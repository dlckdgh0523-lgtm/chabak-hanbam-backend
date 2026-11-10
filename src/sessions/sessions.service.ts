import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../auth/access.service';
import { EventsService } from '../events/events.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { ApiError } from '../common/errors';
import { Principal, UserPrincipal } from '../auth/principal';
import { CreateSessionDto, PreflightDto, SleepPlanDto, StartDto, StopDto } from './sessions.dto';
import { evaluatePreflight } from './policy';
import { Observation } from '../common/freshness';

const PREFLIGHT_TTL_MS = 60_000;

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly events: EventsService,
    private readonly vehicles: VehiclesService,
  ) {}

  async create(p: UserPrincipal, dto: CreateSessionDto) {
    const trip = await this.access.assertTrip(p, dto.tripId);
    if (trip.status === 'CANCELLED' || trip.status === 'DONE') throw new ApiError('PRECONDITION_FAILED', `trip is ${trip.status}`);
    const mode = dto.executionMode ?? 'MOCK';
    if (process.env.NODE_ENV === 'production' && mode === 'MOCK') throw new ApiError('FORBIDDEN', 'MOCK sessions rejected in production');
    const s = await this.prisma.$transaction(async (tx) => {
      const s = await tx.sleepSession.create({ data: { tripId: trip.id, vehicleId: trip.vehicleId, capabilityRevision: dto.capabilityRevision, executionMode: mode } });
      await tx.sleepPlanVersion.create({ data: { sessionId: s.id, version: 1, desiredPlan: dto.desiredPlan as unknown as Prisma.InputJsonValue, createdBy: p.userId } });
      return s;
    });
    this.events.publish({ type: 'PLAN_UPDATED', aggregateId: trip.vehicleId, revision: 1, executionMode: mode, payload: { sessionId: s.id, planVersion: 1, plan: dto.desiredPlan } });
    return this.view(s.id);
  }

  async patchPlan(p: Principal, id: string, plan: SleepPlanDto, expectedVersion: number) {
    const s = await this.access.assertSession(p, id);
    if (s.status === 'STOPPED' || s.status === 'FAILED') throw new ApiError('PRECONDITION_FAILED', `session is ${s.status}`);
    const version = expectedVersion + 1;
    const r = await this.prisma.sleepSession.updateMany({ where: { id, planVersion: expectedVersion }, data: { planVersion: version } });
    if (r.count !== 1) throw new ApiError('VERSION_CONFLICT', `expectedVersion ${expectedVersion} is stale (current ${s.planVersion})`);
    await this.prisma.sleepPlanVersion.create({ data: { sessionId: id, version, desiredPlan: plan as unknown as Prisma.InputJsonValue, createdBy: p.id } });
    const type = s.status === 'ACTIVE' ? 'WAKE_PLAN_UPDATED' : 'PLAN_UPDATED';
    this.events.publish({ type, aggregateId: s.vehicleId, revision: version, executionMode: s.executionMode, payload: { sessionId: id, planVersion: version, plan } });
    // ACTIVE 세션의 계획 변경은 차량 재적용 lease 를 해제한다 — 재동의 전 재적용 안 함 (7.4)
    return { sessionId: id, planVersion: version, note: s.status === 'ACTIVE' ? 'plan saved; vehicle re-applies only after local re-validation' : undefined };
  }

  /** 자동 관리 진입 검사. 사용자 자기확인(체크박스)과 구분. */
  async preflight(p: Principal, id: string, dto: PreflightDto) {
    const s = await this.access.assertSession(p, id);
    const [state, caps, vehicle, trip, consents, planRow] = await Promise.all([
      this.vehicles.getState(p, s.vehicleId),
      this.vehicles.getCapabilities(p, s.vehicleId),
      this.prisma.vehicle.findUniqueOrThrow({ where: { id: s.vehicleId } }),
      this.prisma.trip.findUniqueOrThrow({ where: { id: s.tripId } }),
      this.prisma.consentEvent.findMany({ where: { userId: (await this.prisma.trip.findUniqueOrThrow({ where: { id: s.tripId } })).userId }, orderBy: { occurredAt: 'asc' } }),
      this.prisma.sleepPlanVersion.findUniqueOrThrow({ where: { sessionId_version: { sessionId: id, version: s.planVersion } } }),
    ]);
    void trip;
    if (dto.stateRevision < state.revision) throw new ApiError('PRECONDITION_FAILED', `client stateRevision ${dto.stateRevision} < server ${state.revision}; refetch state`);

    // 최신 동의 상태 계산 (append-only 이벤트에서 마지막 결정)
    const latestConsent = new Map<string, string>();
    for (const c of consents) latestConsent.set(c.purpose, c.decision);
    const granted = new Set([...latestConsent.entries()].filter(([, d]) => d === 'GRANTED').map(([k]) => k));

    const plan = planRow.desiredPlan as unknown as SleepPlanDto;
    const result = evaluatePreflight({
      powertrain: vehicle.powertrain, connection: state.connection, metrics: state.metrics as Record<string, Observation>,
      plan: { heatEnabled: plan.heatEnabled, targetTempC: plan.targetTempC }, capabilities: (caps.features ?? []) as never, consents: granted, executionMode: s.executionMode,
    });
    const pf = await this.prisma.preflight.create({
      data: { sessionId: id, stateRevision: state.revision, readiness: result.readiness, blockers: result.blockers as unknown as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + PREFLIGHT_TTL_MS) },
    });
    await this.prisma.sleepSession.update({ where: { id }, data: { status: s.status === 'PLANNED' ? 'PREFLIGHT' : s.status } });
    return { preflightId: pf.id, readiness: result.readiness, blockers: result.blockers, stateRevision: state.revision, capabilityRevision: caps.revision, expiresAt: pf.expiresAt };
  }

  async start(p: UserPrincipal, id: string, dto: StartDto) {
    const s = await this.access.assertSession(p, id);
    if (!dto.userConfirmed) throw new ApiError('PRECONDITION_FAILED', 'userConfirmed must be true');
    if (dto.planVersion !== s.planVersion) throw new ApiError('VERSION_CONFLICT', `planVersion ${dto.planVersion} != ${s.planVersion}`);
    const pf = await this.prisma.preflight.findFirst({ where: { id: dto.preflightId, sessionId: id } });
    if (!pf) throw new ApiError('NOT_FOUND', 'preflight not found');
    if (pf.expiresAt < new Date()) throw new ApiError('PRECONDITION_FAILED', 'preflight expired; run preflight again');
    if (pf.readiness !== 'READY') throw new ApiError('PRECONDITION_FAILED', 'preflight BLOCKED', pf.blockers);
    const state = await this.vehicles.getState(p, s.vehicleId);
    if (state.revision !== pf.stateRevision) throw new ApiError('PRECONDITION_FAILED', `state changed since preflight (rev ${pf.stateRevision} → ${state.revision}); run preflight again`);

    await this.prisma.sleepSession.update({ where: { id }, data: { status: 'ACTIVE', startedAt: new Date() } });
    // 차량은 이 이벤트를 받고 로컬 재검증 후에만 자동 관리를 시작한다
    this.events.publish({ type: 'PLAN_UPDATED', aggregateId: s.vehicleId, revision: s.planVersion, executionMode: s.executionMode, payload: { sessionId: id, status: 'ACTIVE', planVersion: s.planVersion, userActionId: dto.userActionId, note: 'vehicle must re-validate locally before acting' } });
    return this.view(id);
  }

  async stop(p: Principal, id: string, dto: StopDto) {
    const s = await this.access.assertSession(p, id);
    if (s.status === 'STOPPED') return this.view(id);
    await this.prisma.$transaction([
      this.prisma.sleepSession.update({ where: { id }, data: { status: 'STOPPED', endedAt: new Date(), endReason: dto.reason } }),
      // 미완료 명령은 전부 취소 — 재연결 시 재생 금지
      this.prisma.command.updateMany({ where: { sessionId: id, status: { in: ['REQUESTED', 'QUEUED', 'DISPATCHED'] } }, data: { status: 'CANCELLED', reason: `session stopped: ${dto.reason}` } }),
    ]);
    this.events.publish({ type: 'PLAN_UPDATED', aggregateId: s.vehicleId, revision: s.planVersion, executionMode: s.executionMode, payload: { sessionId: id, status: 'STOPPED', reason: dto.reason, by: p.kind } });
    return this.view(id);
  }

  async summary(p: Principal, id: string) {
    const s = await this.access.assertSession(p, id);
    const full = await this.prisma.sleepSession.findUniqueOrThrow({ where: { id }, include: { alerts: { include: { acks: true } }, commands: true } });
    const samples = await this.prisma.telemetrySample.findMany({ where: { sessionId: id }, orderBy: { observedAt: 'asc' }, select: { metric: true, value: true, observedAt: true, source: true, quality: true } });
    const byMetric: Record<string, { count: number; firstAt: string; lastAt: string; min: number | null; max: number | null; gaps: { from: string; to: string }[] }> = {};
    for (const m of ['co2Ppm', 'coPpm', 'cabinTempC', 'evSocPct']) byMetric[m] = { count: 0, firstAt: '', lastAt: '', min: null, max: null, gaps: [] };
    for (const smp of samples) {
      const b = (byMetric[smp.metric] ??= { count: 0, firstAt: '', lastAt: '', min: null, max: null, gaps: [] });
      const t = smp.observedAt.toISOString();
      if (b.lastAt && Date.parse(t) - Date.parse(b.lastAt) > 60_000) b.gaps.push({ from: b.lastAt, to: t }); // 1분 이상 결측
      if (!b.firstAt) b.firstAt = t;
      b.lastAt = t;
      b.count++;
      if (typeof smp.value === 'number') { b.min = b.min === null ? smp.value : Math.min(b.min, smp.value); b.max = b.max === null ? smp.value : Math.max(b.max, smp.value); }
    }
    // 센서 결측을 정상으로 요약하지 않는다
    const sessionMs = Math.max(1, (full.endedAt ?? new Date()).getTime() - (full.startedAt ?? full.createdAt).getTime());
    const expectedIntervalMs = 5000; // 센서 제품 주기에 맞춰 조정
    const coverage = Object.fromEntries(Object.entries(byMetric).map(([k, v]) => {
      if (v.count === 0) return [k, '기록 없음'];
      const ratio = Math.min(1, (v.count * expectedIntervalMs) / sessionMs);
      if (v.gaps.length || ratio < 0.8) return [k, `부분 기록 (${Math.round(ratio * 100)}% 커버, ${v.gaps.length}회 결측)`];
      return [k, '연속 기록'];
    }));
    return {
      sessionId: id, status: full.status, executionMode: s.executionMode, startedAt: full.startedAt, endedAt: full.endedAt, endReason: full.endReason,
      coverage, metrics: byMetric,
      alerts: full.alerts.map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, raisedAt: a.raisedAt, status: a.status, acks: a.acks.map((x) => x.action) })),
      commands: full.commands.map((c) => ({ id: c.id, action: c.action, status: c.status, mode: c.mode })),
      disclaimer: '결측 구간은 "기록 없음" 이며 정상 아님. 모드가 MOCK 인 항목은 실차 측정이 아님.',
    };
  }

  async get(p: Principal, id: string) {
    await this.access.assertSession(p, id);
    return this.view(id);
  }

  async view(id: string) {
    const s = await this.prisma.sleepSession.findUniqueOrThrow({ where: { id } });
    const plan = await this.prisma.sleepPlanVersion.findUniqueOrThrow({ where: { sessionId_version: { sessionId: id, version: s.planVersion } } });
    return { id: s.id, tripId: s.tripId, vehicleId: s.vehicleId, status: s.status, executionMode: s.executionMode, planVersion: s.planVersion, plan: plan.desiredPlan, startedAt: s.startedAt, endedAt: s.endedAt, endReason: s.endReason };
  }
}
