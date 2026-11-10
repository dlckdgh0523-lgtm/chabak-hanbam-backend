import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, Length, Min, ValidateNested } from 'class-validator';

export class CapabilityDto {
  @IsString() @Length(1, 64) feature: string; // e.g. hvac.temperature, door.lock, ev.soc
  @IsOptional() @IsBoolean() supported: boolean | null;
  @IsBoolean() readAllowed: boolean;
  @IsBoolean() writeAllowed: boolean;
  @IsOptional() @IsIn(['UNSUPPORTED', 'PERMISSION_DENIED', 'OFFLINE', 'NOT_VERIFIED']) reason?: string;
  @IsArray() @IsString({ each: true }) areas: string[];
  @IsOptional() @IsNumber() min?: number;
  @IsOptional() @IsNumber() max?: number;
  @IsOptional() @IsNumber() step?: number;
  @IsOptional() @IsString() unit?: string;
}

export class CapabilityReportDto {
  @IsString() @Length(1, 32) sdkVersion: string;
  @IsOptional() @IsString() serviceVersion?: string;
  @IsOptional() @IsString() emulatorVersion?: string;
  @IsArray() @IsString({ each: true }) permissions: string[]; // 실제 승인된 manifest 권한
  @IsArray() @ValidateNested({ each: true }) @Type(() => CapabilityDto) features: CapabilityDto[];
  @IsISO8601() observedAt: string;
  @IsIn(['MOCK', 'PLEOS_EMULATOR', 'REAL']) executionMode: 'MOCK' | 'PLEOS_EMULATOR' | 'REAL';
}

export class TelemetrySampleDto {
  @IsString() @Length(1, 64) metric: string;
  @IsOptional() value: number | string | boolean | null; // 0 은 결측이 아니다. 결측은 null.
  @IsString() @Length(1, 16) unit: string;
  @IsIn(['PLEOS', 'BLE_SENSOR', 'USER', 'MOCK']) source: 'PLEOS' | 'BLE_SENSOR' | 'USER' | 'MOCK';
  @IsISO8601() observedAt: string;
  @IsInt() @Min(0) seq: number;
  @IsString() @Length(1, 64) bootId: string;
  @IsOptional() @IsIn(['VALID', 'STALE', 'UNKNOWN', 'INVALID']) quality?: 'VALID' | 'STALE' | 'UNKNOWN' | 'INVALID';
}

export class TelemetryBatchDto {
  @IsOptional() @IsString() sessionId?: string;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => TelemetrySampleDto) samples: TelemetrySampleDto[];
}

export class HeartbeatDto {
  @IsIn(['MOCK', 'PLEOS_EMULATOR', 'REAL']) executionMode: 'MOCK' | 'PLEOS_EMULATOR' | 'REAL';
  @IsOptional() @IsIn(['DRIVE', 'PARKED', 'UTILITY', 'SUSPEND', 'UNKNOWN']) powerState?: string; // 차량이 보고한 값. 서버는 추정하지 않는다.
}
