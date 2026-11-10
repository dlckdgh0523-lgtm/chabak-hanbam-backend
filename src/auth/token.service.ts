import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomBytes } from 'crypto';
import { DeviceType } from '@prisma/client';

/**
 * 토큰 두 종류를 한 곳에서 다룬다.
 *  - 사용자 JWT: 폰 앱. scope=user. 짧은 TTL + refresh 회전.
 *  - 장치 토큰: `dvt_<base64url 32B>`. 불투명. 서버는 HMAC 해시만 저장.
 *    CAR 장치 → scope=vehicle, SENSOR/PHONE 센서 역할 → scope=sensor.
 * QR 자체는 토큰이 아니다 (명세 7.1).
 */
@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService, private readonly cfg: ConfigService) {}

  // ── 사용자 ────────────────────────────────────────────────
  signUserAccess(userId: string) {
    return this.jwt.sign(
      { sub: userId, scope: 'user' },
      { secret: this.cfg.getOrThrow('JWT_USER_SECRET'), expiresIn: Number(this.cfg.get('JWT_USER_TTL_SEC') ?? 900) },
    );
  }

  verifyUserAccess(token: string): { sub: string; scope: string } | null {
    try {
      return this.jwt.verify<{ sub: string; scope: string }>(token, { secret: this.cfg.getOrThrow("JWT_USER_SECRET") });
    } catch {
      return null;
    }
  }

  newRefreshToken() {
    const raw = 'rft_' + randomBytes(32).toString('base64url');
    return { raw, hash: this.hash(raw) };
  }

  // ── 장치 ──────────────────────────────────────────────────
  newDeviceToken() {
    const raw = 'dvt_' + randomBytes(32).toString('base64url');
    return { raw, hash: this.hash(raw) };
  }

  isDeviceToken(t: string) {
    return t.startsWith('dvt_');
  }

  hash(raw: string) {
    return createHmac('sha256', this.cfg.getOrThrow('DEVICE_TOKEN_PEPPER')).update(raw).digest('hex');
  }

  scopeForDevice(type: DeviceType): 'vehicle' | 'sensor' {
    return type === 'CAR' ? 'vehicle' : 'sensor';
  }
}
