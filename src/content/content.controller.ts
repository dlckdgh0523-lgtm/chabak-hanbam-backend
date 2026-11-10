import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { CurrentPrincipal, Principal, Scopes, UserPrincipal } from '../auth/principal';
import { ContentService } from './content.service';

class PowerPlanDto {
  @IsUUID() vehicleId: string;
  @IsOptional() @IsUUID() tripId?: string;
  @IsNumber() @Min(1) @Max(16) nightHours: number;
  @IsInt() @Min(1) @Max(4) people: number;
  @IsOptional() @IsNumber() targetTempC?: number;
  @IsOptional() @IsNumber() outsideTempC?: number;
  @IsNumber() @Min(0) returnDistanceKm: number;
  @IsOptional() @IsNumber() batteryKwh?: number; // 차량 사양. 미입력 시 가정값
}
class ReviewDto {
  @IsUUID() tripId: string;
  @IsInt() @Min(1) @Max(5) rating: number;
  @IsString() @Length(1, 2000) text: string;
}
class PatchReviewDto {
  @IsString() @Length(1, 2000) text: string;
  @IsInt() @Min(1) expectedVersion: number;
}
class AltQuery {
  @IsOptional() @IsString() rank?: string;
  @IsOptional() @IsString() require?: string;
  @IsOptional() @Type(() => Number) @IsNumber() maxExtraMin?: number;
}

@Controller()
export class ContentController {
  constructor(private readonly svc: ContentService) {}

  @Get('places/search') @Scopes('user', 'vehicle')
  search(@Query('q') q?: string, @Query('lat') lat?: string, @Query('lng') lng?: string, @Query('cursor') cursor?: string) {
    return this.svc.search(q, lat ? Number(lat) : undefined, lng ? Number(lng) : undefined, cursor);
  }

  @Get('places/:id/briefing') @Scopes('user', 'vehicle')
  briefing(@Param('id', ParseUUIDPipe) id: string) { return this.svc.briefing(id); }

  /** rank=toilet,ev,quiet  require=camping,cooking  — UNKNOWN 은 필수조건 통과 금지 */
  @Get('places/:id/alternatives') @Scopes('user', 'vehicle')
  alternatives(@Param('id', ParseUUIDPipe) id: string, @Query() q: AltQuery) {
    return this.svc.alternatives(id, (q.rank ?? '').split(',').filter(Boolean), (q.require ?? '').split(',').filter(Boolean), q.maxExtraMin ?? 30);
  }

  @Get('weather/night') @Scopes('user', 'vehicle')
  weather(@Query('lat') lat: string, @Query('lng') lng: string, @Query('date') date: string, @Query('timezone') tz = 'Asia/Seoul') {
    return this.svc.weatherNight(Number(lat), Number(lng), date, tz);
  }

  @Get('sun') @Scopes('user', 'vehicle')
  sun(@Query('lat') lat: string, @Query('lng') lng: string, @Query('date') date: string, @Query('timezone') tz = 'Asia/Seoul') {
    return this.svc.sun(Number(lat), Number(lng), date, tz);
  }

  @Post('power-plans') @Scopes('user', 'vehicle')
  powerPlan(@CurrentPrincipal() p: Principal, @Body() dto: PowerPlanDto) { return this.svc.powerPlan(p, dto); }

  @Post('reviews') @Scopes('user')
  review(@CurrentPrincipal() p: UserPrincipal, @Body() dto: ReviewDto) { return this.svc.createReview(p, dto); }

  @Patch('reviews/:id') @Scopes('user')
  patchReview(@CurrentPrincipal() p: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PatchReviewDto) { return this.svc.patchReview(p, id, dto); }
}
