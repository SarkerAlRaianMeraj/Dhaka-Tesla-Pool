import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError, Repository } from 'typeorm';
import { CLAIMABLE_RIDE_STATUSES } from '../common/enums/ride-status.enum';
import { MatchingService } from '../matching/matching.service';
import { PoolService } from '../pool/pool.service';
import { MyPoolView, PoolManifestView } from '../pool/pool.types';
import { Ride } from '../ride/ride.entity';
import { ZoneService } from '../zone/zone.service';
import { RegisterTeslaDto } from './dto/register-tesla.dto';
import { TeslaAvailability } from './tesla-availability.enum';
import { Tesla } from './tesla.entity';
import { buildCorridorIndex, canShare, MatchableRequest } from './matching';
import { MatchableRideView, TeslaView } from './tesla.types';

/**
 * A driver's Tesla, its availability, and the open requests it could serve.
 *
 * ## What is guaranteed here versus in the database
 *
 * Two rules are enforced by constraints rather than by this service, and both
 * because a check-then-insert is only true until two requests arrive at once:
 *
 * - one Tesla per driver (`uq_teslas_driver`), and
 * - one Tesla per plate (`uq_teslas_plate`).
 *
 * This service still translates those violations into 409s with readable messages,
 * because "unique constraint failed" is not something a driver can act on.
 *
 * ## What lives in `PoolService`
 *
 * Whether a seat may be claimed, and whether a driver may stop taking work while
 * holding one, are decisions about the pool and the assignment. This service
 * resolves the driver's Tesla and defers those decisions to `PoolService`, which
 * is the single path that reads or writes occupancy (D13).
 */
@Injectable()
export class TeslaService {
  /**
   * The only vehicle in the brief is a 3-seater Bullet, so capacity has a
   * defensible default and registration needs one field, not two.
   */
  private static readonly DEFAULT_CAPACITY = 3;

  private static readonly DRIVER_CONSTRAINT = 'uq_teslas_driver';
  private static readonly PLATE_CONSTRAINT = 'uq_teslas_plate';

  constructor(
    @InjectRepository(Tesla)
    private readonly teslaRepository: Repository<Tesla>,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    private readonly zoneService: ZoneService,
    private readonly poolService: PoolService,
    private readonly matchingService: MatchingService,
  ) {}

  /**
   * Registers the driver's Tesla, once (FR-D3.1, US-D2).
   *
   * The plate is normalised before storage so that " Dhaka 11-7788" and
   * "DHAKA 11-7788" cannot become two vehicles that a human reads as one. The
   * unique index would accept both, so normalisation is what makes it enforce the
   * rule the product meant.
   */
  async register(dto: RegisterTeslaDto, driverId: string): Promise<TeslaView> {
    const plate = TeslaService.normalizePlate(dto.plate);
    if (plate.length === 0) {
      throw new BadRequestException('plate must contain a registration number');
    }

    const tesla = this.teslaRepository.create({
      driver: { id: driverId } as Tesla['driver'],
      plate,
      capacity: dto.capacity ?? TeslaService.DEFAULT_CAPACITY,
      availability: TeslaAvailability.OFFLINE,
    });

    try {
      const saved = await this.teslaRepository.save(tesla);
      return TeslaService.toView(saved);
    } catch (error) {
      throw TeslaService.explainConflict(error);
    }
  }

  /**
   * The driver's own Tesla, or `null` when they have not registered one.
   *
   * Absence is returned rather than thrown, because "I have not registered yet" is
   * the ordinary opening state of the `/tesla` page (D26), not a failure. Making it
   * a 404 would force the page to treat a routine empty state as an error and
   * risk showing "could not load" on the one screen whose whole job is to offer
   * the form.
   */
  async findMine(driverId: string): Promise<TeslaView | null> {
    const tesla = await this.teslaRepository.findOne({
      where: { driver: { id: driverId } },
    });
    return tesla === null ? null : TeslaService.toView(tesla);
  }

  /**
   * Records the driver's choice about receiving new requests (FR-D3.2, US-D2).
   *
   * Refuses when there is no Tesla, because "go online" is not a thing a driver
   * without a vehicle can do, and silently accepting it would let the UI show a
   * green online state backed by nothing.
   *
   * Refuses going OFFLINE while the driver owes an assigned passenger (PRD §5.6,
   * E2). The assignment outweighs the toggle: a driver who stops taking new work
   * still owes the ride they have, and going offline could only mean the
   * passenger is silently stranded. Once the pool is empty the toggle is free
   * again — that is exactly what `hasAssignedPassengers` measures.
   *
   * A registration cannot be replaced or edited: capacity is fixed at creation
   * (US-D2) and the plate identifies the vehicle, so there is no update endpoint
   * and therefore no way to change what Phase 4 reasons about.
   */
  async setAvailability(
    driverId: string,
    availability: TeslaAvailability,
  ): Promise<TeslaView> {
    const tesla = await this.requireByDriver(driverId);

    if (
      availability === TeslaAvailability.OFFLINE &&
      (await this.poolService.hasAssignedPassengers(tesla.id))
    ) {
      throw new ConflictException(PoolService.CANNOT_GO_OFFLINE);
    }

    tesla.availability = availability;
    const view = TeslaService.toView(await this.teslaRepository.save(tesla));

    // The flip changed the candidate set: going online makes unassigned rides
    // matchable again, going offline withdraws every `MATCHED` promise this
    // Tesla was the last standing candidate for (D32). Reconcile after the flip
    // is committed so the matcher reads the new availability.
    await this.matchingService.reconcile();

    return view;
  }

  /**
   * Accepts a request onto the driver's Tesla, opening or joining its pool
   * (FR-D4, US-D4, PRD §5.3 `E -> G`).
   *
   * The accepted seat changes what the rest of the fleet may still match (the
   * pool is anchored and a seat is taken), so the matcher re-runs once the
   * claim has committed. The manifest this returns is about the pool the driver
   * just used and is unaffected by those demotions, which is why the recede
   * rather than bake the sweep results into the response.
   *
   * Returns the manifest rather than the ride, because what a driver needs the
   * moment they accept is "who is aboard now" — and the request that just got
   * accepted is the top line of it.
   */
  async accept(rideId: string, driverId: string): Promise<PoolManifestView> {
    const tesla = await this.requireByDriver(driverId);
    const manifest = await this.poolService.acceptForDriver(tesla, rideId);
    await this.matchingService.reconcile();
    return manifest;
  }

  /**
   * The driver's manifest, or an explicit empty one (PRD D4, D28).
   *
   * Requires a Tesla for the same reason the feed does: without a vehicle there
   * is nothing to have passengers in, and "no Tesla" is a different answer from
   * "no passengers yet".
   */
  async getPool(driverId: string): Promise<MyPoolView> {
    const tesla = await this.requireByDriver(driverId);
    return this.poolService.getManifest(tesla.id);
  }

  /**
   * Open requests a driver's Tesla could serve (FR-D3.3, FR-M2, US-D3).
   *
   * Two filters, both introduced in Phase 4 and both from the matching rule:
   *
   * 1. **Status.** Only rides nobody is assigned to yet appear. This is
   *    `REQUESTED` plus `MATCHED` — a request a suitable Tesla has been
   *    identified for still needs a driver to accept it, so it belongs in feeds.
   * 2. **Relevance to *this* Tesla.** Once the driver's pool is anchored by its
   *    first passenger, a request is only shown if it can share with every
   *    member already aboard (`canShare` against the whole pool, PRD §6.1) and
   *    still fits the seats left open. With no pool there is nothing aboard and
   *    nothing to filter (D27).
   *
   * `matchable` below is therefore always true — a request that survives these
   * two filters is by construction one this driver can carry — and the field is
   * kept so the client does not have to re-derive the decision.
   */
  async listMatchableRides(driverId: string): Promise<MatchableRideView[]> {
    const tesla = await this.requireByDriver(driverId);

    const index = buildCorridorIndex(await this.zoneService.list());
    const pool = await this.poolService.poolForFeed(tesla.id);

    const rides = await this.rideRepository.find({
      where: { status: In(CLAIMABLE_RIDE_STATUSES) },
      relations: { pickupZone: true, destinationZone: true },
      order: { createdAt: 'DESC' },
    });

    return rides
      .filter((ride) => {
        if (pool === null) {
          return true;
        }

        const request: MatchableRequest = {
          pickupZoneCode: ride.pickupZone.code,
          destinationZoneCode: ride.destinationZone.code,
        };

        return (
          pool.openSeats >= ride.seatsRequested &&
          pool.anchors.every((anchor) => canShare(anchor, request, index))
        );
      })
      .map((ride) => ({
        id: ride.id,
        pickupZoneCode: ride.pickupZone.code,
        pickupZoneName: ride.pickupZone.name,
        destinationZoneCode: ride.destinationZone.code,
        destinationZoneName: ride.destinationZone.name,
        seatsRequested: ride.seatsRequested,
        fareEstimatePoysha: ride.fareEstimatePoysha,
        status: ride.status,
        // True for everything listed: the filter above kept only requests this
        // Tesla's pool (or planned pool) can carry. It is stated explicitly so
        // the fade between "Phase 3: nothing excluded" and "Phase 4: excluded
        // everything incompatible" is a change of behaviour, not of shape.
        matchable: true,
        createdAt: ride.createdAt,
      }));
  }

  private async requireByDriver(driverId: string): Promise<Tesla> {
    const tesla = await this.teslaRepository.findOne({
      where: { driver: { id: driverId } },
    });
    if (tesla === null) {
      throw new NotFoundException('Register your Tesla before doing that');
    }
    return tesla;
  }

  /**
   * Trimmed, upper-cased, and with internal whitespace collapsed.
   *
   * Collapsing matters more than it looks: without it `DHAKA 11-7788` and
   * `DHAKA  11-7788` pass the unique index as two distinct plates while meaning
   * the same vehicle to every human and to the traffic police.
   */
  private static normalizePlate(plate: string): string {
    return plate.trim().replace(/\s+/g, ' ').toUpperCase();
  }

  /**
   * Turns a unique-constraint violation into something the caller can act on.
   *
   * Anything that is not a recognised violation is rethrown untouched, so a real
   * fault is never dressed up as a conflict.
   */
  private static explainConflict(error: unknown): unknown {
    if (error instanceof QueryFailedError) {
      const driverError = (
        error as unknown as {
          driverError?: { code?: string; constraint?: string };
        }
      ).driverError;

      if (driverError?.code === '23505') {
        if (driverError.constraint === TeslaService.DRIVER_CONSTRAINT) {
          return new ConflictException(
            'You have already registered a Tesla (US-D2)',
          );
        }
        if (driverError.constraint === TeslaService.PLATE_CONSTRAINT) {
          return new ConflictException('That plate is already registered');
        }
      }
    }
    return error;
  }

  private static toView(tesla: Tesla): TeslaView {
    return {
      id: tesla.id,
      plate: tesla.plate,
      model: tesla.model,
      capacity: tesla.capacity,
      availability: tesla.availability,
      createdAt: tesla.createdAt,
      updatedAt: tesla.updatedAt,
    };
  }
}
