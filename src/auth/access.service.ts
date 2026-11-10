import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { notFound } from '../common/errors';
import { Principal } from './principal';

/**
 * 모든 차량/세션 조회에 소유·연결 관계를 검사한다 (명세 7.1).
 * 실패는 항상 NOT_FOUND — 존재 여부를 노출하지 않는다.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** principal 이 이 vehicle 에 접근 가능한지. USER 는 ACTIVE 링크, DEVICE 는 자신이 링크된 장치여야 한다. */
  async assertVehicle(p: Principal, vehicleId: string) {
    // CAR 장치는 enroll 시점에 차량에 묶인다. 사용자 페어링 여부와 무관하게 자기 차량에는 접근 가능.
    if (p.kind === 'DEVICE' && p.deviceType === 'CAR') {
      const d = await this.prisma.device.findUnique({ where: { id: p.deviceId }, select: { enrolledVehicleId: true } });
      if (d?.enrolledVehicleId === vehicleId) return { id: 'enrolled', userId: p.userId, deviceId: p.deviceId };
      throw notFound('vehicle');
    }
    const where =
      p.kind === 'USER'
        ? { userId: p.userId, vehicleId, status: 'ACTIVE' as const }
        : { deviceId: p.deviceId, vehicleId, status: 'ACTIVE' as const };
    const link = await this.prisma.vehicleLink.findFirst({ where, select: { id: true, userId: true, deviceId: true } });
    if (!link) throw notFound('vehicle');
    return link;
  }

  /** CAR 장치가 어떤 vehicle 에 묶여 있는지 (enroll 직후, 페어링 전에는 링크가 없으므로 Device→PairingChallenge 로 추적) */
  async vehicleIdForCarDevice(deviceId: string): Promise<string> {
    const link = await this.prisma.vehicleLink.findFirst({ where: { deviceId, status: 'ACTIVE' }, select: { vehicleId: true } });
    if (link) return link.vehicleId;
    const d = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { enrolledVehicleId: true } });
    if (d?.enrolledVehicleId) return d.enrolledVehicleId;
    throw notFound('vehicle');
  }

  async assertSession(p: Principal, sessionId: string) {
    const s = await this.prisma.sleepSession.findUnique({ where: { id: sessionId }, select: { id: true, vehicleId: true, tripId: true, status: true, planVersion: true, executionMode: true, capabilityRevision: true } });
    if (!s) throw notFound('session');
    await this.assertVehicle(p, s.vehicleId);
    return s;
  }

  async assertTrip(p: Principal, tripId: string) {
    const t = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!t) throw notFound('trip');
    if (p.kind === 'USER' && t.userId !== p.userId) throw notFound('trip');
    if (p.kind === 'DEVICE') await this.assertVehicle(p, t.vehicleId);
    return t;
  }
}
