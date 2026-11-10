import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateSessionDto {
  @IsIn(['DEV']) provider: 'DEV'; // 실제 인증 공급자(OIDC 등) 연결 전. DEV 는 production 에서 거부.
  @IsString() @Length(1, 200) credential: string; // DEV: 임의 subject 문자열
}

export class RefreshDto {
  @IsString() @Length(10, 200) refreshToken: string;
}

export class EnrollVehicleDeviceDto {
  @IsString() @Length(1, 64) enrollSecret: string;
  @IsString() @Length(1, 80) displayName: string;
  @IsOptional() @IsIn(['EV', 'ICE', 'HEV', 'PHEV', 'UNKNOWN']) powertrain?: 'EV' | 'ICE' | 'HEV' | 'PHEV' | 'UNKNOWN';
  @IsOptional() @IsString() @Length(1, 64) installationId?: string; // 에뮬레이터 재설치 시 재발급 구분용
}
