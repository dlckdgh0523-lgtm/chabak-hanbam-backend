import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../auth/access.service';
import { EventsService } from '../events/events.service';
import { ApiError } from '../common/errors';
import { Observation, withFreshness } from '../common/freshness';
import { DevicePrincipal, Principal } from '../auth/principal';
import { CapabilityReportDto, HeartbeatDto, TelemetryBatchDto } from './vehicles.dto';

export const METRIC_UNITS: Record<string, string> = {
  co2Ppm: 'ppm', coPpm: 'ppm', oxygenPct: '%', cabinTempC: 'C', evSocPct: '%', batt12vVolt: 'V',
  'fan.level': 'level', 'recirculation.state': 'enum', 'hvac.power': 'bool', 'hvac.targetTempC': 'C',
};

@Injectable()
export class VehiclesService {
  private readonly sensorStaleMs: number;
  private readonly vehicleOfflineMs: number;
  private readonly heartbeats = new Map<string, { at: number; mode: string; powerState?: string }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly events: EventsService,
    cfg: ConfigService,
  ) {
    this.sensorStaleMs = Number(cfg.get('SENSOR_STALE_AFTER_MS') ?? 15000);
    this.vehicleOfflineMs = Number(cfg.get('VEHICLE_OFFLINE_AFTER_MS') ?? 30000);
  }

  private assertModeAllowed(mode: string) {
    if (process.env.NODE_ENV === 'production' && mode === 'MOCK') throw new ApiError('FORBIDDEN', 'MOCK events are rejected in production');
  }

  // ── capability ──────────────────────────────────────────────
  async reportCapabilities(p: DevicePrincipal, vehicleId: string, dto: CapabilityReportDto) {
    if (p.deviceType !== 'CAR') throw new ApiError('FORBIDDEN', 'only CAR device reports capabilities');
    await this.assertCarVehicle(p, vehicleId);
    this.assertModeAllowed(dto.executionMode);
    const last = await this.prisma.capabilityReport.findFirst({ where: { vehicleId }, orderBy: { revision: 'desc' }, select: { revision: true } });
    const revision = (last?.revision ?? 0) + 1;
    await this.prisma.capabilityReport.create({
      data: {
        vehicleId, deviceId: p.deviceId, revision, sdkVersion: dto.sdkVersion, serviceVersion: dto.serviceVersion, emulatorVersion: dto.emulatorVersion,
        permissions: dto.permissions, features: dto.features as unknown as Prisma.InputJsonValue, observedAt: new Date(dto.observedAt),
      },
    });
    this.events.publish({ type: 'CAPABILITIES_UPDATED', aggregateId: vehicleId, revision, sourceDeviceId: p.deviceId, executionMode: dto.executionMode, payload: { revision } });
    return { revision };
  }

  async getCapabilities(p: Principal, vehicleId: string) {
    await this.access.assertVehicle(p, vehicleId);
    const r = await this.prisma.capabilityReport.findFirst({ where: { vehicleId }, orderBy: { revision: 'desc' } });
    if (!r) return { revision: 0, features: [], permissions: [], note: 'no capability report yet — vehicle app must POST /capability-reports' };
    return { revision: r.revision, sdkVersion: r.sdkVersion, serviceVersion: r.serviceVersion, emulatorVersion: r.emulatorVersion, permissions: r.permissions, features: r.features, observedAt: r.observedAt };
  }

  // ── telemetry ───────────────────────────────────────────────
  async ingestTelemetry(p: DevicePrincipal, vehicleId: string, dto: TelemetryBatchDto) {
    await this.access.assertVehicle(p, vehicleId);
    if (dto.sessionId) {
      const s = await this.prisma.sleepSession.findFirst({ where: { id: dto.sessionId, vehicleId }, select: { id: true } });
      if (!s) throw new ApiError('VALIDATION_FAILED', 'sessionId does not belong to vehicle');
    }
    const receivedAt = new Date();
    let accepted = 0, duplicates = 0;
    const latest = new Map<string, Observation>();

    for (const s of dto.samples) {
      this.assertModeAllowed(s.source === 'MOCK' ? 'MOCK' : 'REAL');
      if (s.source === 'PLEOS' && p.deviceType !== 'CAR') throw new ApiError('FORBIDDEN', 'PLEOS source only from CAR device');
      if (s.source === 'BLE_SENSOR' && p.deviceType === 'CAR') { /* 실차 BLE 는 별도 검증 — 허용하되 출처 그대로 */ }
      const quality = s.quality ?? (s.value === null || s.value === undefined ? 'UNKNOWN' : 'VALID');
      // 시계가 앞선 장치의 미래 값은 캐시를 영구 점유하고 STALE 도 안 된다 → 수신 시각으로 고정
      const observedAt = new Date(Math.min(Date.parse(s.observedAt), receivedAt.getTime()));
      try {
        await this.prisma.telemetrySample.create({
          data: {
            vehicleId, sessionId: dto.sessionId, metric: s.metric, value: s.value === undefined ? Prisma.JsonNull : (s.value as Prisma.InputJsonValue),
            unit: s.unit, source: s.source, sourceDeviceId: p.deviceId, observedAt, receivedAt, seq: s.seq, bootId: s.bootId, quality,
          },
        });
        accepted++;
      } catch (e) {
        if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') { duplicates++; continue; }
        throw e;
      }
      const obs: Observation = {
        value: s.value ?? null, unit: s.unit, source: s.source, sourceDeviceId: p.deviceId, observedAt: observedAt.toISOString(),
        receivedAt: receivedAt.toISOString(), quality, seq: s.seq, bootId: s.bootId,
      };
      const prev = latest.get(s.metric);
      if (!prev || Date.parse(prev.observedAt) <= observedAt.getTime()) latest.set(s.metric, obs);
    }

    if (latest.size) {
      // 늦게 온 과거 값이 최신 상태를 덮어쓰지 않게 metric 별 observedAt 비교. 락으로 동시 업로드끼리 서로의 metric 을 지우지 않는다.
      const revision = await this.prisma.$transaction(async (tx) => {
        await this.prisma.lock(tx, vehicleId);
        const cache = await tx.vehicleStateCache.upsert({ where: { vehicleId }, create: { vehicleId, metrics: {} }, update: {} });
        const metrics = { ...(cache.metrics as unknown as Record<string, Observation>) };
        for (const [m, o] of latest) {
          const cur = metrics[m];
          if (!cur || Date.parse(cur.observedAt) <= Date.parse(o.observedAt)) metrics[m] = o;
        }
        const revision = cache.revision + 1;
        await tx.vehicleStateCache.update({ where: { vehicleId }, data: { metrics: metrics as unknown as Prisma.InputJsonValue, revision } });
        return revision;
      });
      this.events.publish({
        type: 'STATE_SNAPSHOT', aggregateId: vehicleId, revision, sourceDeviceId: p.deviceId,
        executionMode: [...latest.values()].some((o) => o.source === 'MOCK') ? 'MOCK' : 'REAL',
        payload: { changed: Object.fromEntries(latest) }, expiresInMs: this.sensorStaleMs * 2,
      });
      this.events.bus.emit('telemetry', { vehicleId, sessionId: dto.sessionId, metrics: Object.fromEntries(latest), deviceId: p.deviceId });
    }
    return { accepted, duplicates, lastSeq: Math.max(-1, ...dto.samples.map((s) => s.seq)) };
  }

  async heartbeat(p: DevicePrincipal, vehicleId: string, dto: HeartbeatDto) {
    await this.access.assertVehicle(p, vehicleId);
    this.assertModeAllowed(dto.executionMode);
    this.heartbeats.set(vehicleId, { at: Date.now(), mode: dto.executionMode, powerState: dto.powerState });
    void this.events.publish({ type: 'LINK_HEALTH_CHANGED', aggregateId: vehicleId, sourceDeviceId: p.deviceId, executionMode: dto.executionMode, payload: { vehicle: 'ONLINE', powerState: dto.powerState ?? null } });
    return { ok: true, serverTime: new Date().toISOString() };
  }

  async getState(p: Principal, vehicleId: string) {
    await this.access.assertVehicle(p, vehicleId);
    const cache = await this.prisma.vehicleStateCache.findUnique({ where: { vehicleId } });
    const now = Date.now();
    const hb = this.heartbeats.get(vehicleId);
    const carDevice = await this.prisma.vehicleLink.findFirst({ where: { vehicleId, status: 'ACTIVE', device: { type: 'CAR' } }, include: { device: { select: { lastSeenAt: true } } } });
    const lastSeen = Math.max(hb?.at ?? 0, carDevice?.device.lastSeenAt?.getTime() ?? 0);
    const connection: 'ONLINE' | 'OFFLINE' = lastSeen && now - lastSeen <= this.vehicleOfflineMs ? 'ONLINE' : 'OFFLINE';

    const metrics: Record<string, Observation> = {};
    for (const [m, o] of Object.entries((cache?.metrics ?? {}) as unknown as Record<string, Observation>)) metrics[m] = withFreshness(o, this.sensorStaleMs, now);

    // 환기: 설정/관측/추정 분리 (명세 7.3 상태 예시)
    const recirc = metrics['recirculation.state'];
    const fan = metrics['fan.level'];
    return {
      vehicleId,
      revision: cache?.revision ?? 0,
      connection,
      lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
      executionMode: hb?.mode ?? null,
      powerState: hb?.powerState ?? null,
      note: connection === 'OFFLINE' ? '차량 오프라인 — 아래 값은 마지막 수신값' : undefined,
      metrics,
      derived: {
        effectiveVentilation: 'UNKNOWN', // 환기량은 측정하지 않는다. 외기·팬 상태 ≠ 산소 안전.
        ventilationObserved: { recirculation: recirc?.quality === 'VALID' ? recirc.value : null, fan: fan?.quality === 'VALID' ? fan.value : null },
      },
    };
  }

  private async assertCarVehicle(p: DevicePrincipal, vehicleId: string) {
    const v = await this.access.vehicleIdForCarDevice(p.deviceId);
    if (v !== vehicleId) throw new ApiError('NOT_FOUND', 'vehicle not found');
  }
}
