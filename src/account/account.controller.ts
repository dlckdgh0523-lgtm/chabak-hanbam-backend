import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Length, Matches, Min, ValidateNested } from 'class-validator';
import { CurrentPrincipal, Scopes, UserPrincipal, DevicePrincipal, Principal } from '../auth/principal';
import { AccountService } from './account.service';
import { Idempotent } from '../common/idempotency.interceptor';

class ConsentDto {
  @IsIn(['LOCATION', 'CONTACTS', 'EXTERNAL_AI', 'SENSOR', 'VEHICLE_STATE', 'TERMS']) purpose: string;
  @IsString() @Length(1, 32) version: string;
  @IsIn(['GRANTED', 'DENIED', 'WITHDRAWN']) decision: 'GRANTED' | 'DENIED' | 'WITHDRAWN';
  @IsOptional() @IsString() deviceId?: string;
}

class ContactDto {
  @IsString() @Length(1, 40) name: string;
  @IsString() @Matches(/^\+?[0-9\-]{7,20}$/) phone: string;
}
class PutContactsDto {
  @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => ContactDto) contacts: ContactDto[];
  @IsInt() @Min(0) expectedVersion: number;
}
class TestSmsDto {
  @IsString() contactId: string;
  @IsString() @Length(1, 64) userActionId: string;
}
class PushTokenDto {
  @IsString() @Length(10, 4096) token: string;
  @IsIn(['ANDROID', 'IOS']) platform: 'ANDROID' | 'IOS';
}
class DeleteAccountDto {
  @IsString() reauthCredential: string;
}

@Controller()
export class AccountController {
  constructor(private readonly svc: AccountService) {}

  @Get('consents') @Scopes('user')
  listConsents(@CurrentPrincipal() p: UserPrincipal) {
    return this.svc.listConsents(p.userId);
  }
  @Post('consents') @Scopes('user')
  consent(@CurrentPrincipal() p: UserPrincipal, @Body() dto: ConsentDto) {
    return this.svc.recordConsent(p.userId, dto);
  }

  @Get('emergency-contacts') @Scopes('user')
  getContacts(@CurrentPrincipal() p: UserPrincipal) {
    return this.svc.getContacts(p.userId);
  }
  @Put('emergency-contacts') @Scopes('user')
  putContacts(@CurrentPrincipal() p: UserPrincipal, @Body() dto: PutContactsDto) {
    return this.svc.putContacts(p.userId, dto.contacts, dto.expectedVersion);
  }
  /** 명시적 사용자 요청으로만 발송. 개발 환경은 log 공급자. */
  @Post('emergency-contacts/test-sms') @Scopes('user') @Idempotent() @HttpCode(202)
  testSms(@CurrentPrincipal() p: UserPrincipal, @Body() dto: TestSmsDto) {
    return this.svc.testSms(p.userId, dto.contactId, dto.userActionId);
  }

  /** 폰/차량 장치 push 토큰 등록. 사용자 principal 이면 PHONE 장치를 만든다. */
  @Post('devices/push-token') @Scopes('user', 'vehicle')
  pushToken(@CurrentPrincipal() p: Principal, @Body() dto: PushTokenDto) {
    return this.svc.registerPushToken(p as UserPrincipal | DevicePrincipal, dto.token, dto.platform);
  }

  /** 폰이 BLE 센서값을 올릴 때 쓰는 scope=sensor 장치 토큰 발급. */
  @Post('vehicles/:vehicleId/sensor-tokens') @Scopes('user')
  sensorToken(@CurrentPrincipal() p: UserPrincipal, @Param('vehicleId', ParseUUIDPipe) vehicleId: string) {
    return this.svc.issueSensorToken(p, vehicleId);
  }

  @Delete('account') @Scopes('user') @HttpCode(202)
  deleteAccount(@CurrentPrincipal() p: UserPrincipal, @Body() dto: DeleteAccountDto) {
    return this.svc.requestDeletion(p.userId, dto.reauthCredential);
  }
}
