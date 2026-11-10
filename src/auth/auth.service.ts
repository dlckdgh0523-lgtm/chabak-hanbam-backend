import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ApiError } from '../common/errors';
import { TokenService } from './token.service';
import { CreateSessionDto, EnrollVehicleDeviceDto } from './auth.dto';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly tokens: TokenService, private readonly cfg: ConfigService) {}

  async createSession(dto: CreateSessionDto) {
    if (dto.provider === 'DEV') {
      if (this.cfg.get('NODE_ENV') === 'production' || this.cfg.get('DEV_LOGIN_ENABLED') !== 'true') {
        throw new ApiError('FORBIDDEN', 'DEV login disabled');
      }
      const user = await this.prisma.user.upsert({
        where: { authSubject: `dev:${dto.credential}` },
        create: { authSubject: `dev:${dto.credential}` },
        update: {},
      });
      return this.issueUserTokens(user.id);
    }
    throw new ApiError('VALIDATION_FAILED', 'unsupported provider');
  }

  private async issueUserTokens(userId: string, familyId: string = randomUUID()) {
    const refresh = this.tokens.newRefreshToken();
    const ttl = Number(this.cfg.get('REFRESH_TTL_SEC') ?? 2592000);
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: refresh.hash, familyId, expiresAt: new Date(Date.now() + ttl * 1000) },
    });
    return { accessToken: this.tokens.signUserAccess(userId), refreshToken: refresh.raw, userId };
  }

  /** 회전 + 재사용 탐지: 이미 사용된 refresh 가 다시 오면 family 전체 폐기 */
  async refresh(raw: string) {
    const rec = await this.prisma.refreshToken.findUnique({ where: { tokenHash: this.tokens.hash(raw) } });
    if (!rec || rec.revokedAt || rec.expiresAt < new Date()) throw new ApiError('UNAUTHENTICATED', 'invalid refresh token');
    if (rec.usedAt) {
      await this.prisma.refreshToken.updateMany({ where: { familyId: rec.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new ApiError('UNAUTHENTICATED', 'refresh token reuse detected; family revoked');
    }
    await this.prisma.refreshToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } });
    return this.issueUserTokens(rec.userId, rec.familyId);
  }

  /**
   * 차량 앱 최초 등록. 설치 비밀로 CAR 장치 + Vehicle 을 만들고 장치 토큰을 1회 반환한다.
   * 토큰 원문은 서버에 남지 않는다. 분실 시 재등록.
   */
  async enrollVehicleDevice(dto: EnrollVehicleDeviceDto) {
    if (dto.enrollSecret !== this.cfg.getOrThrow('VEHICLE_ENROLL_SECRET')) throw new ApiError('FORBIDDEN', 'bad enroll secret');
    const token = this.tokens.newDeviceToken();
    const result = await this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.create({ data: { displayName: dto.displayName, powertrain: dto.powertrain ?? 'UNKNOWN', source: 'USER' } });
      const device = await tx.device.create({ data: { type: 'CAR', displayName: dto.installationId ?? dto.displayName, tokenHash: token.hash, enrolledVehicleId: vehicle.id } });
      await tx.vehicleStateCache.create({ data: { vehicleId: vehicle.id, metrics: {} } });
      return { vehicle, device };
    });
    return { deviceId: result.device.id, vehicleId: result.vehicle.id, deviceToken: token.raw, scope: 'vehicle' as const };
  }
}
