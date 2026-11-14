import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../auth/token.service';
import { AccessService } from '../auth/access.service';
import { ApiError, notFound } from '../common/errors';
import { DevicePrincipal, UserPrincipal } from '../auth/principal';
import { EventsService } from '../events/events.service';

const PAIRING_TTL_MS = 120_000;

@Injectable()
export class PairingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly access: AccessService,
    private readonly events: EventsService,
  ) {}

  async create(p: DevicePrincipal) {
    if (p.deviceType !== 'CAR') throw new ApiError('FORBIDDEN', 'only CAR devices create pairings');
    const vehicleId = await this.access.vehicleIdForCarDevice(p.deviceId);
    const secret = 'pair_' + randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    const ch = await this.prisma.pairingChallenge.create({
      data: { carDeviceId: p.deviceId, vehicleId, secretHash: this.tokens.hash(secret), expiresAt },
    });
    // QR 에 담을 payload. secret 원문은 이 응답에만 존재한다.
    const qrPayload = JSON.stringify({ v: 1, pairingId: ch.id, secret });
    return { challengeId: ch.id, qrPayload, expiresAt: expiresAt.toISOString() };
  }

  async claim(p: UserPrincipal, id: string, secret: string) {
    const now = new Date();
    // 원자적: 미사용·미만료·secret 일치인 것만 claimed 로 바꾼다
    const r = await this.prisma.pairingChallenge.updateMany({
      where: { id, secretHash: this.tokens.hash(secret), claimedAt: null, usedAt: null, expiresAt: { gt: now } },
      data: { claimedBy: p.userId, claimedAt: now },
    });
    if (r.count !== 1) throw new ApiError('PRECONDITION_FAILED', 'pairing expired, already claimed, or secret mismatch');
    const ch = await this.prisma.pairingChallenge.findUniqueOrThrow({ where: { id } });
    this.events.publish({ type: 'PAIRING_CLAIMED', aggregateId: ch.vehicleId, payload: { pairingId: id } });
    return { pairingId: id, vehicleId: ch.vehicleId, status: 'PENDING_VEHICLE_CONFIRM', expiresAt: ch.expiresAt.toISOString() };
  }

  async confirm(p: DevicePrincipal, id: string) {
    const ch = await this.prisma.pairingChallenge.findUnique({ where: { id } });
    if (!ch || ch.carDeviceId !== p.deviceId) throw notFound('pairing');
    if (!ch.claimedBy || !ch.claimedAt) throw new ApiError('PRECONDITION_FAILED', 'not claimed yet');
    if (ch.usedAt) throw new ApiError('PRECONDITION_FAILED', 'already used');
    if (ch.expiresAt < new Date()) throw new ApiError('PRECONDITION_FAILED', 'expired');

    const link = await this.prisma.$transaction(async (tx) => {
      await tx.pairingChallenge.update({ where: { id }, data: { confirmedAt: new Date(), usedAt: new Date() } });
      await tx.device.update({ where: { id: p.deviceId }, data: { userId: ch.claimedBy } });
      return tx.vehicleLink.upsert({
        where: { userId_vehicleId_deviceId: { userId: ch.claimedBy!, vehicleId: ch.vehicleId, deviceId: p.deviceId } },
        create: { userId: ch.claimedBy!, vehicleId: ch.vehicleId, deviceId: p.deviceId, role: 'OWNER', status: 'ACTIVE' },
        update: { status: 'ACTIVE', revokedAt: null },
      });
    });
    this.events.publish({ type: 'LINK_HEALTH_CHANGED', aggregateId: ch.vehicleId, payload: { linkId: link.id, status: 'ACTIVE' } });
    return { linkId: link.id, vehicleId: ch.vehicleId, userId: ch.claimedBy, status: 'ACTIVE' };
  }

  async revokeLink(p: UserPrincipal, linkId: string) {
    const link = await this.prisma.vehicleLink.findFirst({ where: { id: linkId, userId: p.userId } });
    if (!link) throw notFound('link');
    await this.prisma.$transaction([
      this.prisma.vehicleLink.update({ where: { id: linkId }, data: { status: 'REVOKED', revokedAt: new Date() } }),
      // 장치 토큰 폐기 (BLE 키 폐기는 BLE 도입 시 추가)
      this.prisma.device.update({ where: { id: link.deviceId }, data: { revokedAt: new Date(), tokenHash: null } }),
    ]);
    this.events.publish({ type: 'LINK_HEALTH_CHANGED', aggregateId: link.vehicleId, payload: { linkId, status: 'REVOKED' } });
    this.events.bus.emit('revoked', { principals: [`USER:${link.userId}`], vehicleId: link.vehicleId });
    this.events.bus.emit('revoked', { principals: [`DEVICE:${link.deviceId}`] });
  }
}
