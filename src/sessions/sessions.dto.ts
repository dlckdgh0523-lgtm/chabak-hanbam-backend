import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';

export class SleepPlanDto {
  @IsBoolean() heatEnabled: boolean;
  @IsOptional() @IsNumber() @Min(16) @Max(30) targetTempC: number | null; // UI 범위(events.json heating). capability 교집합은 서버가 다시 검사.
  @IsIn(['FRESH_AIR_REQUIRED']) ventilationPolicy: 'FRESH_AIR_REQUIRED'; // 목표 정책이며 측정 결과가 아님
  @IsBoolean() accessAlertEnabled: boolean;
  @IsISO8601() wakeAt: string;
  @IsString() timezone: string;
  @IsInt() @Min(0) @Max(90) musicDurationMin: number;
}

export class CreateSessionDto {
  @IsUUID() tripId: string;
  @ValidateNested() @Type(() => SleepPlanDto) desiredPlan: SleepPlanDto;
  @IsOptional() @IsInt() capabilityRevision?: number;
  @IsOptional() @IsIn(['MOCK', 'PLEOS_EMULATOR', 'REAL']) executionMode?: 'MOCK' | 'PLEOS_EMULATOR' | 'REAL';
}

export class PatchPlanDto {
  @ValidateNested() @Type(() => SleepPlanDto) plan: SleepPlanDto;
  @IsInt() @Min(1) expectedVersion: number;
}

export class PreflightDto {
  @IsInt() @Min(0) stateRevision: number; // 클라이언트가 본 최신 관측 revision
}

export class StartDto {
  @IsUUID() preflightId: string;
  @IsInt() @Min(1) planVersion: number;
  @IsBoolean() userConfirmed: boolean;
  @IsString() @Length(1, 64) userActionId: string;
}

export class StopDto {
  @IsIn(['USER_STOP', 'MANUAL_OVERRIDE', 'SAFETY', 'POWER_LOSS', 'LINK_LOST', 'OTHER']) reason: string;
}

// ── 명령 ──
export class SetClimateTargetAction {
  @IsIn(['SET_CLIMATE_TARGET']) type: 'SET_CLIMATE_TARGET';
  @IsNumber() targetTempC: number;
  @IsString() areaId: string;
}
export class RequestFreshAirAction {
  @IsIn(['REQUEST_FRESH_AIR']) type: 'REQUEST_FRESH_AIR';
  @IsInt() @Min(0) @Max(8) fanLevel: number;
}
export class LockDoorAction {
  @IsIn(['LOCK_DOOR']) type: 'LOCK_DOOR';
  @IsString() areaId: string;
}

export class CommandRequestDto {
  @IsOptional() @IsUUID() sessionId?: string;
  @IsObject() action: { type: 'SET_CLIMATE_TARGET' | 'REQUEST_FRESH_AIR' | 'LOCK_DOOR'; [k: string]: unknown };
  @IsInt() @Min(0) expectedStateRevision: number;
  @IsInt() @Min(0) capabilityRevision: number;
  @IsISO8601() expiresAt: string;
  @IsString() @Length(1, 64) userActionId: string;
  @IsIn(['MOCK', 'PLEOS_EMULATOR', 'REAL']) executionMode: 'MOCK' | 'PLEOS_EMULATOR' | 'REAL';
}

export class CommandResultDto {
  @IsIn(['ACCEPTED', 'VERIFYING', 'VERIFIED', 'REJECTED', 'FAILED', 'UNCONFIRMED']) status: string;
  @IsOptional() observed?: Record<string, unknown>;
  @IsOptional() @IsString() reason?: string;
  @IsInt() @Min(1) attemptNo: number;
}
