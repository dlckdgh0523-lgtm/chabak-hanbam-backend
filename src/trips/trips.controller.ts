import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { CurrentPrincipal, DevicePrincipal, Principal, Scopes, UserPrincipal } from '../auth/principal';
import { Idempotent } from '../common/idempotency.interceptor';
import { TripsService } from './trips.service';

export class CreateTripDto {
  @IsUUID() placeId: string;
  @IsUUID() vehicleId: string;
  @IsISO8601() startAt: string;
  @IsISO8601() endAt: string;
  @IsString() timezone: string;
  @IsInt() @Min(1) @Max(4) people: number; // 1~4 는 기획값
}
export class PatchTripDto {
  @IsInt() @Min(1) expectedVersion: number;
  @IsOptional() @IsISO8601() startAt?: string;
  @IsOptional() @IsISO8601() endAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(4) people?: number;
  @IsOptional() @IsIn(['CANCELLED']) status?: 'CANCELLED';
}
export class SyncAckDto {
  @IsInt() @Min(1) appliedVersion: number;
}

@Controller()
export class TripsController {
  constructor(private readonly svc: TripsService) {}

  @Post('trips') @Scopes('user') @Idempotent()
  create(@CurrentPrincipal() p: UserPrincipal, @Body() dto: CreateTripDto) {
    return this.svc.create(p, dto);
  }

  @Get('trips/:id') @Scopes('user', 'vehicle')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(p, id);
  }

  @Patch('trips/:id') @Scopes('user')
  patch(@CurrentPrincipal() p: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PatchTripDto) {
    return this.svc.patch(p, id, dto);
  }

  /** 차량이 서버 예약을 내려받는다. 다운로드 ≠ 적용. */
  @Get('vehicles/:vehicleId/trips/upcoming') @Scopes('vehicle', 'user')
  upcoming(@CurrentPrincipal() p: Principal, @Param('vehicleId', ParseUUIDPipe) vehicleId: string, @Query('cursor') cursor?: string) {
    return this.svc.upcoming(p, vehicleId, cursor);
  }

  /** 차량 로컬 저장 완료 확인. 실행 동의가 아니다. */
  @Post('trips/:id/sync-acks') @Scopes('vehicle') @HttpCode(200)
  ack(@CurrentPrincipal() p: DevicePrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SyncAckDto) {
    return this.svc.syncAck(p, id, dto.appliedVersion);
  }
}
