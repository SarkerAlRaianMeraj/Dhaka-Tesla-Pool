import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../common/auth/authenticated-user';
import { CurrentUser } from '../common/auth/authenticated-user';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { MyPoolView, PoolManifestView } from '../pool/pool.types';
import { RegisterTeslaDto } from './dto/register-tesla.dto';
import { UpdateTeslaAvailabilityDto } from './dto/update-tesla-availability.dto';
import { TeslaService } from './tesla.service';
import { MatchableRideView, MyTeslaView, TeslaView } from './tesla.types';

/**
 * Everything a driver does with the Tesla they offer rides in (FR-D3).
 *
 * Singular `/tesla` rather than `/teslas`, because every route here is about the
 * *caller's own* vehicle: a driver has one (US-D2), there is no browsing a fleet,
 * and no route lets one driver name another's Tesla. The driver is taken from the
 * token throughout, so no body or path can point at somebody else's car.
 *
 * State changes are POSTs to named actions, matching `POST /rides/:id/cancel` and
 * `POST /auth/logout` rather than inventing PATCH where nothing else uses it.
 *
 * Guard order is load-bearing and identical to `RideController`: `JwtAuthGuard`
 * populates `request.user` for `RolesGuard` to read, so reversing them would tell
 * an anonymous caller 403 ("you are the wrong role") instead of 401 ("you are
 * nobody"), which misdescribes the problem and confirms the route exists.
 */
@Controller('tesla')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Driver)
export class TeslaController {
  constructor(private readonly teslaService: TeslaService) {}

  /**
   * Registers the driver's Tesla (FR-D3.1).
   *
   * 201, because a row now exists. A second attempt is 409 rather than a silent
   * success — US-D2 says the Tesla is created once, and quietly updating the old
   * one would let a typo rewrite the plate of a vehicle with history.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  register(
    @Body() registerTeslaDto: RegisterTeslaDto,
    @CurrentUser() driver: AuthenticatedUser,
  ): Promise<TeslaView> {
    return this.teslaService.register(registerTeslaDto, driver.id);
  }

  /**
   * The driver's Tesla, or a `null` one, in an envelope.
   *
   * `GET /tesla/me` rather than `GET /tesla`, because the empty state is real and
   * a driver with no Tesla is not a missing resource — they are a driver who has
   * not got to the form yet.
   *
   * Always 200. The absence travels as `tesla: null` inside the body rather than as
   * a bare `null` return, because Nest renders a returned `null` as an empty
   * response with no `Content-Type`, leaving the client unable to tell "nothing
   * registered" from "no payload arrived". See `MyTeslaView`.
   */
  @Get('me')
  mine(@CurrentUser() driver: AuthenticatedUser): Promise<MyTeslaView> {
    return this.teslaService.findMine(driver.id).then((tesla) => ({ tesla }));
  }

  /**
   * Records whether the driver is offering rides (FR-D3.2).
   *
   * 200 not 204: the updated Tesla comes back so the toggle's new position is the
   * server's answer rather than the client's optimistic guess, which is the same
   * reason `POST /rides/:id/cancel` returns the ride.
   */
  @Post('availability')
  @HttpCode(HttpStatus.OK)
  setAvailability(
    @Body() updateTeslaAvailabilityDto: UpdateTeslaAvailabilityDto,
    @CurrentUser() driver: AuthenticatedUser,
  ): Promise<TeslaView> {
    return this.teslaService.setAvailability(
      driver.id,
      updateTeslaAvailabilityDto.availability,
    );
  }

  /**
   * Open requests the driver's Tesla could serve (FR-D3.3, FR-M2).
   *
   * Unfiltered in Phase 3 by design: the matching rule compares two requests and a
   * driver's first request does not exist yet, so every `REQUESTED` ride is
   * potentially the seed of a pool (D27). Phase 4 narrows this same list.
   */
  @Get('requests')
  listMatchable(
    @CurrentUser() driver: AuthenticatedUser,
  ): Promise<MatchableRideView[]> {
    return this.teslaService.listMatchableRides(driver.id);
  }

  /**
   * Accepts a request onto the driver's Tesla (FR-D4, US-D4, PRD §5.3).
   *
   * 201, because a pool membership now exists. The body is the manifest so the
   * driver sees who is aboard immediately; the passenger's own screen is updated
   * by their next read, exactly as the feed's next read reflects the seat gone.
   */
  @Post('requests/:rideId/accept')
  @HttpCode(HttpStatus.CREATED)
  accept(
    @Param('rideId', new ParseUUIDPipe()) rideId: string,
    @CurrentUser() driver: AuthenticatedUser,
  ): Promise<PoolManifestView> {
    return this.teslaService.accept(rideId, driver.id);
  }

  /**
   * The driver's manifest of who is aboard (PRD D4).
   *
   * Always 200: no open pool is the ordinary "no passengers yet" state, and it
   * travels as `pool: null` rather than a 404 (D28).
   */
  @Get('pool')
  pool(@CurrentUser() driver: AuthenticatedUser): Promise<MyPoolView> {
    return this.teslaService.getPool(driver.id);
  }
}
