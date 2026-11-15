import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ApiError } from '../common/errors';
import { TokenService } from './token.service';
import { CreateSessionDto, EnrollVehicleDeviceDto } from './auth.dto';

const ENROLL_FAIL_LIMIT = 10;
const ENROLL_FAIL_WINDOW_MS = 10 * 60_000;

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
  // shortcut: 실패 횟수는 인스턴스 메모리에 둔다(서버 1대 기준). 다중화하면 DB/Redis 로.
  private enrollFailures = new Map<string, number[]>();

  async enrollVehicleDevice(dto: EnrollVehicleDeviceDto, ip = 'unknown') {
    const now = Date.now();
    const recent = (this.enrollFailures.get(ip) ?? []).filter((t) => now - t < ENROLL_FAIL_WINDOW_MS);
    if (recent.length >= ENROLL_FAIL_LIMIT) throw new ApiError('RATE_LIMITED', 'too many failed enroll attempts; retry later');
    // 공용 설치 비밀은 데모 리허설용 — production 에서는 차량별 1회용 코드만
    const shared = this.cfg.get('NODE_ENV') !== 'production' && dto.enrollSecret === this.cfg.get('VEHICLE_ENROLL_SECRET');
    const fail = () => {
      this.enrollFailures.set(ip, [...recent, now]);
      return new ApiError('FORBIDDEN', 'invalid, used or expired provisioning code');
    };
    const usable = { codeHash: this.tokens.hash(dto.enrollSecret), usedAt: null, expiresAt: { gt: new Date() } };
    if (!shared && !(await this.prisma.provisioningCode.findFirst({ where: usable, select: { id: true } }))) throw fail(); // 빠른 거절 — 소비는 아래 트랜잭션에서
    const token = this.tokens.newDeviceToken();
    const result = await this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.create({ data: { displayName: dto.displayName, powertrain: dto.powertrain ?? 'UNKNOWN', source: 'USER' } });
      if (!shared) {
        // 조건부 updateMany 로 원자적 소비: 동시에 같은 코드로 2대가 와도 1대만 count=1
        const used = await tx.provisioningCode.updateMany({ where: usable, data: { usedAt: new Date(), usedByVehicleId: vehicle.id } });
        if (used.count !== 1) throw fail();
      }
      const device = await tx.device.create({ data: { type: 'CAR', displayName: dto.installationId ?? dto.displayName, tokenHash: token.hash, enrolledVehicleId: vehicle.id } });
      await tx.vehicleStateCache.create({ data: { vehicleId: vehicle.id, metrics: {} } });
      return { vehicle, device };
    });
    return { deviceId: result.device.id, vehicleId: result.vehicle.id, deviceToken: token.raw, scope: 'vehicle' as const };
  }
}
