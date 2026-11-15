import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CreateSessionDto, EnrollVehicleDeviceDto, RefreshDto } from './auth.dto';
import { Public } from './principal';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Post('auth/sessions')
  createSession(@Body() dto: CreateSessionDto) {
    return this.auth.createSession(dto);
  }

  @Public() @Post('auth/refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  /** 차량 AAOS 앱 부트스트랩. 응답의 deviceToken 을 안전 저장(EncryptedSharedPreferences 등)하고 이후 Bearer 로 사용. */
  @Public() @Post('devices/vehicle/enroll')
  enroll(@Body() dto: EnrollVehicleDeviceDto, @Ip() ip: string) {
    return this.auth.enrollVehicleDevice(dto, ip);
  }
}
