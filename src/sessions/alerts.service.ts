import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertSeverity, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../auth/access.service';
import { EventsService } from '../events/events.service';
import { ApiError, notFound } from '../common/errors';
import { Principal, UserPrincipal } from '../auth/principal';
import { Observation } from '../common/freshness';
import { ALERT_RULES } from './policy';

const IMMEDIATE_KINDS = new Set(['CO_DETECTED', 'CO2_CRITICAL']); // D9: 30초 지연 없음

@Injectable()
export class AlertsService implements OnModuleInit {
  private readonly log = new Logger(AlertsService.name);
  private readonly staleMs: number;
  private lastSeen = new Map<string, { at: number; sessionId?: string }>(); // vehicleId:metric

  constructor(private readonly prisma: PrismaService, private readonly access: AccessService, private readonly events: EventsService, cfg: ConfigService) {
    this.staleMs = Number(cfg.get('SENSOR_STALE_AFTER_MS') ?? 15000);
  }

  onModuleInit() {
    this.events.bus.on('telemetry', (e: { vehicleId: string; sessionId?: string; metrics: Record<string, Observation>; deviceId: string }) => void this.onTelemetry(e));
    setInterval(() => void this.sweepDisconnected(), 5000);
  }

  // ── 규칙 평가 (서버 보조; 차량 로컬 경보가 1차) ──────────────
  private async onTelemetry(e: { vehicleId: string; sessionId?: string; metrics: Record<string, Observation>; deviceId: string }) {
    const active = e.sessionId ? await this.prisma.sleepSession.findFirst({ where: { id: e.sessionId, status: 'ACTIVE' } }) : await this.prisma.sleepSession.findFirst({ where: { vehicleId: e.vehicleId, status: 'ACTIVE' } });
    for (const [m, o] of Object.entries(e.metrics)) {
      if (['co2Ppm', 'coPpm'].includes(m)) this.lastSeen.set(`${e.vehicleId}:${m}`, { at: Date.now(), sessionId: active?.id });
      if (!active || o.quality !== 'VALID' || typeof o.value !== 'number') continue;
      const mode = o.source === 'MOCK' ? 'MOCK' : active.executionMode;
      if (m === 'coPpm') {
        if (o.value >= ALERT_RULES.coCriticalPpm) await this.raise(active.id, 'CO_DETECTED', 'CRITICAL', { metric: m, value: o.value, observedAt: o.observedAt, source: o.source }, mode, `co:${e.vehicleId}:${o.bootId}:${o.seq}`);
        else if (o.value >= ALERT_RULES.coWarnPpm) await this.raise(active.id, 'CO_ELEVATED', 'WARNING', { metric: m, value: o.value, observedAt: o.observedAt, source: o.source }, mode, `co-warn:${e.vehicleId}:${Math.floor(Date.now() / 300_000)}`);
      }
      if (m === 'co2Ppm') {
        if (o.value >= ALERT_RULES.co2CriticalPpm) await this.raise(active.id, 'CO2_CRITICAL', 'CRITICAL', { metric: m, value: o.value, observedAt: o.observedAt, source: o.source }, mode, `co2c:${e.vehicleId}:${Math.floor(Date.now() / 60_000)}`);
        else if (o.value >= ALERT_RULES.co2WarnPpm) await this.raise(active.id, 'CO2_HIGH', 'WARNING', { metric: m, value: o.value, observedAt: o.observedAt, source: o.source, action: 'REQUEST_FRESH_AIR (MOCK) — 환기량 보장 아님' }, mode, `co2w:${e.vehicleId}:${Math.floor(Date.now() / 300_000)}`);
      }
    }
  }

  private async sweepDisconnected() {
    const now = Date.now();
    for (const [key, v] of this.lastSeen) {
      if (now - v.at > this.staleMs && v.sessionId) {
        const [vehicleId, metric] = key.split(':');
        const s = await this.prisma.sleepSession.findFirst({ where: { id: v.sessionId, status: 'ACTIVE' } });
        if (s) await this.raise(s.id, 'SENSOR_DISCONNECTED', 'WARNING', { metric, lastSeenAt: new Date(v.at).toISOString(), staleAfterMs: this.staleMs, note: '센서 단절과 차 전원 OFF 는 구별 불가능할 수 있음' }, s.executionMode, `disc:${vehicleId}:${metric}:${v.at}`);
        this.lastSeen.delete(key);
      }
    }
  }

  // ── 공개 API ────────────────────────────────────────────────
  /** 차량/폰이 위험 이벤트를 기록. sourceEventId 로 중복 제거. 문자 발송과 분리. */
  async raiseExternal(p: Principal, dto: { sessionId: string; kind: string; severity: AlertSeverity; sourceEventId: string; evidence: Record<string, unknown>; executionMode: 'MOCK' | 'PLEOS_EMULATOR' | 'REAL' }) {
    const s = await this.access.assertSession(p, dto.sessionId);
    if (process.env.NODE_ENV === 'production' && dto.executionMode === 'MOCK') throw new ApiError('FORBIDDEN', 'MOCK alerts rejected in production');
    if (dto.kind === 'ACCESS_DETECTED' && dto.executionMode !== 'MOCK') throw new ApiError('UNSUPPORTED_CAPABILITY', 'ACCESS_DETECTED has no public sensor API; MOCK only (S8b DEMO)');
    return this.raise(s.id, dto.kind, dto.severity, dto.evidence, dto.executionMode, dto.sourceEventId);
  }

  private async raise(sessionId: string, kind: string, severity: AlertSeverity, evidence: Record<string, unknown>, executionMode: 'MOCK' | 'PLEOS_EMULATOR' | 'REAL', sourceEventId: string) {
    const existing = await this.prisma.alert.findFirst({ where: { sessionId, sourceEventId } });
    if (existing) return { alertId: existing.id, duplicate: true, status: existing.status };
    const s = await this.prisma.sleepSession.findUniqueOrThrow({ where: { id: sessionId } });
    const a = await this.prisma.alert.create({ data: { sessionId, kind, severity, sourceEventId, evidence: evidence as Prisma.InputJsonValue, executionMode } });
    // 전달 레코드: WSS(차량·폰) + PUSH(폰) 각각 추적. 기술 ACK ≠ 사용자 확인.
    await this.prisma.delivery.createMany({ data: [{ alertId: a.id, channel: 'WSS', recipientRef: `vehicle:${s.vehicleId}`, status: 'SENT' }, { alertId: a.id, channel: 'PUSH', recipientRef: `vehicle-users:${s.vehicleId}`, status: 'QUEUED' }] });
    this.events.publish({
      type: 'ALERT_RAISED', aggregateId: s.vehicleId, executionMode, payload: {
        alertId: a.id, kind, severity, evidence, raisedAt: a.raisedAt,
        userResponseTimeoutSec: IMMEDIATE_KINDS.has(kind) ? 0 : kind === 'ACCESS_DETECTED' ? 30 : null, // D9
        demo: executionMode === 'MOCK',
      },
    });
    this.log.warn(`ALERT ${kind} ${severity} session=${sessionId} mode=${executionMode} [push: provider=log]`);
    return { alertId: a.id, duplicate: false, status: 'RAISED' as const };
  }

  async ack(p: Principal, alertId: string, action: string) {
    const a = await this.prisma.alert.findUnique({ where: { id: alertId } });
    if (!a || !a.sessionId) throw notFound('alert');
    const s = await this.access.assertSession(p, a.sessionId);
    const ack = await this.prisma.alertAck.create({ data: { alertId, userId: p.kind === 'USER' ? p.userId : null, actor: p.kind === 'USER' ? 'USER' : 'SYSTEM', action } });
    // 사람이 한 응답만 ACKED. 경보 해제(RESOLVED)는 새 정상 관측 + 정책 — 여기서 자동 해제하지 않는다.
    if (p.kind === 'USER') {
      await this.prisma.alert.update({ where: { id: alertId }, data: { status: 'ACKED' } });
      await this.prisma.delivery.updateMany({ where: { alertId }, data: { status: 'USER_ACK' } });
    }
    this.events.publish({ type: 'ALERT_ACKED', aggregateId: s.vehicleId, executionMode: s.executionMode, payload: { alertId, action, actor: ack.actor } });
    return { alertId, action, status: p.kind === 'USER' ? 'ACKED' : a.status };
  }

  /** RECEIVED/DISPLAYED 는 기술 ACK. 사용자 응답 타이머를 멈추지 않는다. */
  async receipt(p: Principal, dto: { eventId: string; stage: 'RECEIVED' | 'DISPLAYED'; channel: 'WSS' | 'PUSH' | 'LOCAL'; time: string }) {
    const a = await this.prisma.alert.findUnique({ where: { id: dto.eventId } });
    if (!a || !a.sessionId) throw notFound('alert');
    await this.access.assertSession(p, a.sessionId);
    await this.prisma.delivery.updateMany({ where: { alertId: a.id, channel: dto.channel, status: { in: ['QUEUED', 'SENT', 'RECEIVED'] } }, data: { status: dto.stage } });
    return { ok: true, note: 'technical receipt only; not a user acknowledgement' };
  }

  /** 사용자 명시 요청으로만 SMS. 멱등 + 레이트 제한(동일 alert 5분 1회). */
  async contactNotification(p: UserPrincipal, alertId: string, dto: { recipients: string[]; template: string; userActionId: string }) {
    const a = await this.prisma.alert.findUnique({ where: { id: alertId } });
    if (!a || !a.sessionId) throw notFound('alert');
    await this.access.assertSession(p, a.sessionId);
    const recent = await this.prisma.delivery.findFirst({ where: { alertId, channel: 'SMS', createdAt: { gt: new Date(Date.now() - 300_000) } } });
    if (recent) throw new ApiError('RATE_LIMITED', 'SMS for this alert sent within 5 minutes');
    const contacts = await this.prisma.emergencyContact.findMany({ where: { userId: p.userId, id: { in: dto.recipients } } });
    if (contacts.length !== dto.recipients.length) throw notFound('contact');
    const jobId = randomUUID();
    for (const c of contacts) await this.prisma.delivery.create({ data: { alertId, channel: 'SMS', recipientRef: `contact:${c.id}`, status: 'QUEUED', providerMessageId: `log-${jobId}` } });
    this.log.log(`[SMS:log] job=${jobId} alert=${alertId} template=${dto.template} to=${contacts.length} userActionId=${dto.userActionId}`);
    return { jobId, recipients: contacts.length, note: 'provider acceptance ≠ read receipt; no exactly-once guarantee' };
  }

  async test(p: UserPrincipal, vehicleId: string, kind: string) {
    await this.access.assertVehicle(p, vehicleId);
    const s = await this.prisma.sleepSession.findFirst({ where: { vehicleId, status: { in: ['ACTIVE', 'PREFLIGHT', 'PLANNED'] } }, orderBy: { createdAt: 'desc' } });
    if (!s) throw new ApiError('PRECONDITION_FAILED', 'no session to attach test alert');
    return this.raise(s.id, `TEST_${kind}`, 'INFO', { test: true }, 'MOCK', `test:${randomUUID()}`);
  }

  async list(p: Principal, sessionId: string) {
    await this.access.assertSession(p, sessionId);
    return this.prisma.alert.findMany({ where: { sessionId }, orderBy: { raisedAt: 'desc' }, include: { acks: true, deliveries: true } });
  }
}
