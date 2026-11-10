import { Body, Controller, Delete, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { CurrentPrincipal, DevicePrincipal, Principal, Scopes, UserPrincipal } from '../auth/principal';
import { PairingService } from './pairing.service';

class ClaimDto {
  @IsString() @Length(20, 120) secret: string;
}

@Controller()
export class PairingController {
  constructor(private readonly svc: PairingService) {}

  /** 차량 장치: QR 챌린지 생성. 120초·1회용(제안값). */
  @Post('pairings') @Scopes('vehicle')
  create(@CurrentPrincipal() p: DevicePrincipal) {
    return this.svc.create(p);
  }

  /** 폰(로그인 사용자): QR 스캔 → pending. 원자적 사용 처리. */
  @Post('pairings/:id/claim') @Scopes('user') @HttpCode(200)
  claim(@CurrentPrincipal() p: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ClaimDto) {
    return this.svc.claim(p, id, dto.secret);
  }

  /** 차량 화면에서 사용자 확인 → 연결 ACTIVE. 타인이 QR 만 스캔해서는 제어 권한을 못 얻는다. */
  @Post('pairings/:id/confirm') @Scopes('vehicle') @HttpCode(200)
  confirm(@CurrentPrincipal() p: DevicePrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.confirm(p, id);
  }

  @Delete('vehicle-links/:id') @Scopes('user') @HttpCode(204)
  async unlink(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.svc.revokeLink(p as UserPrincipal, id);
  }
}
