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
import { CreateRideRequestDto } from './dto/create-ride-request.dto';
import { QuoteRideDto } from './dto/quote-ride.dto';
import { RideService } from './ride.service';
import { QuoteView, RideView } from './ride.types';

/**
 * Everything a passenger does with a ride they own.
 *
 * The guard is applied to the whole controller rather than per route: not one of
 * these endpoints means anything without knowing who is asking, and an endpoint
 * added later without the decorator would then be public by omission.
 */
@Controller('rides')
// Order is load-bearing: `JwtAuthGuard` populates `request.user`, which is what
// `RolesGuard` then reads. Reversed, an unauthenticated caller would be told 403
// ("you are the wrong role") instead of 401 ("you are nobody"), which both
// misdescribes the problem and confirms that the route exists to a stranger.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Passenger)
export class RideController {
  constructor(private readonly rideService: RideService) {}

  /**
   * Prices a journey, persisting nothing (FR-P2.2).
   *
   * 201 is not appropriate here even though this is a POST: nothing was created.
   */
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  quote(@Body() quoteRideDto: QuoteRideDto): Promise<QuoteView> {
    return this.rideService.quote(quoteRideDto);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  createRequest(
    @Body() createRideRequestDto: CreateRideRequestDto,
    @CurrentUser() passenger: AuthenticatedUser,
  ): Promise<RideView> {
    return this.rideService.createRequest(createRideRequestDto, passenger.id);
  }

  @Get()
  listMine(@CurrentUser() passenger: AuthenticatedUser): Promise<RideView[]> {
    return this.rideService.listMine(passenger.id);
  }

  /**
   * `:id` is validated as a UUID before the service runs, so a malformed id is a
   * 400 about the format rather than a 404 that suggests the ride might exist.
   */
  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe()) rideId: string,
    @CurrentUser() passenger: AuthenticatedUser,
  ): Promise<RideView> {
    return this.rideService.findOneOwned(rideId, passenger.id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', new ParseUUIDPipe()) rideId: string,
    @CurrentUser() passenger: AuthenticatedUser,
  ): Promise<RideView> {
    return this.rideService.cancel(rideId, passenger.id);
  }

  /**
   * Joins the caller's ride to an open pool on the same route (PRD A2, D7).
   *
   * 201, because a pool membership now exists. The ride comes back with the full
   * history, so the passenger's screen can move straight to "seat reserved".
   */
  @Post(':id/join')
  @HttpCode(HttpStatus.CREATED)
  join(
    @Param('id', new ParseUUIDPipe()) rideId: string,
    @CurrentUser() passenger: AuthenticatedUser,
  ): Promise<RideView> {
    return this.rideService.joinPool(rideId, passenger.id);
  }
}
