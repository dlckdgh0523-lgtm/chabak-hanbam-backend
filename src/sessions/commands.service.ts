import { Injectable, Logger } from '@nestjs/common';
import { CommandStatus, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../auth/access.service';
import { EventsService } from '../events/events.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { ApiError, notFound } from '../common/errors';
import { DevicePrincipal, Principal, UserPrincipal } from '../auth/principal';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CommandRequestDto, CommandResultDto, LockDoorAction, RequestFreshAirAction, SetClimateTargetAction } from './sessions.dto';

/**
 * REQUESTED → QUEUED → DISPATCHED → ACCEPTED → VERIFYING → VERIFIED
 * 종료: REJECTED, FAILED, EXPIRED, CANCELLED, UNCONFIRMED
 * 서버는 접수·전달·기록만 한다. 실행·물리 확인은 차량 executor.
 */
const TRANSITIONS: Record<CommandStatus, CommandStatus[]> = {
  REQUESTED: ['QUEUED', 'REJECTED', 'CANCELLED'],
  QUEUED: ['DISPATCHED', 'EXPIRED', 'CANCELLED'],
  DISPATCHED: ['ACCEPTED', 'REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED'],
  ACCEPTED: ['VERIFYING', 'VERIFIED', 'FAILED', 'UNCONFIRMED'],
  VERIFYING: ['VERIFIED', 'FAILED', 'UNCONFIRMED'],
  VERIFIED: [], REJECTED: [], FAILED: [], EXPIRED: [], CANCELLED: [], UNCONFIRMED: [],
};

/** 실차 allowlist 는 공식 승인 전까지 비어 있다. MOCK/에뮬레이터만 허용 (명세 7.3). */
const ALLOWLIST: Record<'MOCK' | 'PLEOS_EMULATOR' | 'REAL', string[]> = {
  MOCK: ['SET_CLIMATE_TARGET', 'REQUEST_FRESH_AIR', 'LOCK_DOOR'],
  PLEOS_EMULATOR: ['SET_CLIMATE_TARGET', 'REQUEST_FRESH_AIR'],
  REAL: [],
};

const ACTION_DTO: Record<string, new () => object> = { SET_CLIMATE_TARGET: SetClimateTargetAction, REQUEST_FRESH_AIR: RequestFreshAirAction, LOCK_DOOR: LockDoorAction };

@Injectable()
export class CommandsService {
  private readonly log = new Logger(CommandsService.name);
  constructor(private readonly prisma: PrismaService, private readonly access: AccessService, private readonly events: EventsService, private readonly vehicles: VehiclesService) {}

  async request(p: UserPrincipal, vehicleId: string, dto: CommandRequestDto) {
    await this.access.assertVehicle(p, vehicleId);
    if (process.env.NODE_ENV === 'production' && dto.executionMode === 'MOCK') throw new ApiError('FORBIDDEN', 'MOCK commands rejected in production');
    const type = dto.action?.type;
    if (!ALLOWLIST[dto.executionMode].includes(type)) throw new ApiError('UNSUPPORTED_CAPABILITY', `action ${type} not in ${dto.executionMode} allowlist`, { allowlist: ALLOWLIST[dto.executionMode] });
    const bad = validateSync(plainToInstance(ACTION_DTO[type], dto.action));
    if (bad.length) throw new ApiError('VALIDATION_FAILED', `invalid ${type} fields`, bad.map((e) => e.property));
    if (Date.parse(dto.expiresAt) <= Date.now()) throw new ApiError('VALIDATION_FAILED', 'expiresAt already passed');

    if (dto.sessionId) {
      const s = await this.access.assertSession(p, dto.sessionId);
      if (s.status !== 'ACTIVE' && s.status !== 'PREFLIGHT') throw new ApiError('PRECONDITION_FAILED', `session is ${s.status}`);
    }

    // 사전검사: 차량 온라인, capability 범위
    const state = await this.vehicles.getState(p, vehicleId);
    if (state.connection !== 'ONLINE') throw new ApiError('PRECONDITION_FAILED', 'vehicle offline');
    // 취침 중 센서 업로드로 revision 은 계속 오른다 → 클라이언트가 서버보다 앞선 값만 거부 (8.1-6)
    if (dto.expectedStateRevision > state.revision) throw new ApiError('PRECONDITION_FAILED', `expectedStateRevision ${dto.expectedStateRevision} > ${state.revision}`);
    const caps = await this.vehicles.getCapabilities(p, vehicleId);
    if (dto.capabilityRevision !== caps.revision) throw new ApiError('PRECONDITION_FAILED', `capabilityRevision ${dto.capabilityRevision} != ${caps.revision}`);
    this.validateAgainstCapability(dto.action, (caps.features ?? []) as never, dto.executionMode);

    const payloadHash = createHash('sha256').update(JSON.stringify(dto.action)).digest('hex');
    const cmd = await this.prisma.command.create({
      data: {
        vehicleId, sessionId: dto.sessionId, action: dto.action as Prisma.InputJsonValue, payloadHash, mode: dto.executionMode, status: 'QUEUED',
        expiresAt: new Date(dto.expiresAt), requestedBy: p.userId, userActionId: dto.userActionId, expectedRevision: dto.expectedStateRevision, capabilityRev: dto.capabilityRevision,
      },
    });
    await this.prisma.commandAttempt.create({ data: { commandId: cmd.id, attemptNo: 0, phase: 'QUEUED', result: 'ok', finishedAt: new Date() } });
    // 서버→차량 전달. 차량은 commandId 로 durable inbox 중복 실행 방지.
    this.events.publish({ type: 'COMMAND_DISPATCH', aggregateId: vehicleId, executionMode: dto.executionMode, expiresInMs: Date.parse(dto.expiresAt) - Date.now(), payload: { commandId: cmd.id, action: dto.action, expiresAt: dto.expiresAt, sessionId: dto.sessionId ?? null, expectedStateRevision: dto.expectedStateRevision } });
    await this.transition(cmd.id, 'DISPATCHED', { attemptNo: 1, phase: 'DISPATCHED' });
    return { commandId: cmd.id, status: 'DISPATCHED', note: 'accepted ≠ verified; poll GET /commands/:id' };
  }

  private validateAgainstCapability(action: CommandRequestDto['action'], caps: { feature: string; supported: boolean | null; writeAllowed: boolean; min?: number; max?: number; step?: number; areas?: string[] }[], mode: string) {
    const need = action.type === 'SET_CLIMATE_TARGET' ? 'hvac.temperature' : action.type === 'REQUEST_FRESH_AIR' ? 'hvac.recirculation' : 'door.lock';
    const cap = caps.find((c) => c.feature === need);
    if (mode === 'MOCK' && !cap) return; // MOCK 은 capability 없이도 상태기계 시연 허용
    if (!cap || cap.supported !== true) throw new ApiError('UNSUPPORTED_CAPABILITY', `${need} unsupported or unverified`);
    // MOCK 은 권한 없이도 상태기계를 시연한다. 단 결과 화면에는 mode=MOCK 이 계속 따라간다.
    if (!cap.writeAllowed && mode !== 'MOCK') throw new ApiError('UNSUPPORTED_CAPABILITY', `${need} write not allowed (permission)`);
    if (action.type === 'SET_CLIMATE_TARGET') {
      const t = Number(action.targetTempC);
      if (cap.min !== undefined && t < cap.min) throw new ApiError('VALIDATION_FAILED', `targetTempC < capability min ${cap.min}`);
      if (cap.max !== undefined && t > cap.max) throw new ApiError('VALIDATION_FAILED', `targetTempC > capability max ${cap.max}`);
      if (cap.step && Math.abs((t - (cap.min ?? 0)) / cap.step - Math.round((t - (cap.min ?? 0)) / cap.step)) > 1e-6) throw new ApiError('VALIDATION_FAILED', `targetTempC not on step ${cap.step}`);
      if (cap.areas?.length && !cap.areas.includes(String(action.areaId))) throw new ApiError('VALIDATION_FAILED', `areaId not in ${cap.areas.join(',')}`);
    }
  }

  async get(p: Principal, id: string) {
    const c = await this.prisma.command.findUnique({ where: { id }, include: { attempts: { orderBy: { attemptNo: 'asc' } } } });
    if (!c) throw notFound('command');
    await this.access.assertVehicle(p, c.vehicleId);
    return { id: c.id, status: c.status, mode: c.mode, action: c.action, observed: c.observed, reason: c.reason, expiresAt: c.expiresAt, attempts: c.attempts, verified: c.status === 'VERIFIED' };
  }

  /** 차량 executor 전용. SDK 콜백 성공=ACCEPTED, 물리 상태 readback=VERIFIED. */
  async result(p: DevicePrincipal, id: string, dto: CommandResultDto) {
    const c = await this.prisma.command.findUnique({ where: { id } });
    if (!c) throw notFound('command');
    await this.access.assertVehicle(p, c.vehicleId);
    if (TRANSITIONS[c.status].length && c.expiresAt < new Date() && !['VERIFIED', 'FAILED', 'REJECTED'].includes(dto.status)) {
      await this.transition(id, 'EXPIRED', { attemptNo: dto.attemptNo, phase: 'EXPIRED', error: 'result after expiry' });
      return { commandId: id, status: 'EXPIRED' };
    }
    const next = dto.status as CommandStatus;
    if (!TRANSITIONS[c.status].includes(next)) {
      if (c.status === next) return { commandId: id, status: c.status, duplicate: true };
      throw new ApiError('PRECONDITION_FAILED', `illegal transition ${c.status} → ${next}`);
    }
    await this.transition(id, next, { attemptNo: dto.attemptNo, phase: next, result: dto.reason, observed: dto.observed });
    return { commandId: id, status: next };
  }

  private async transition(id: string, status: CommandStatus, a: { attemptNo: number; phase: string; result?: string; error?: string; observed?: Record<string, unknown> }) {
    const c = await this.prisma.command.update({ where: { id }, data: { status, observed: a.observed as Prisma.InputJsonValue, reason: a.result ?? a.error } });
    await this.prisma.commandAttempt.upsert({
      where: { commandId_attemptNo: { commandId: id, attemptNo: a.attemptNo } },
      create: { commandId: id, attemptNo: a.attemptNo, phase: a.phase, result: a.result, error: a.error, finishedAt: new Date() },
      update: { phase: a.phase, result: a.result, error: a.error, finishedAt: new Date() },
    });
    this.events.publish({ type: 'COMMAND_STATUS_CHANGED', aggregateId: c.vehicleId, executionMode: c.mode, payload: { commandId: id, status, observed: a.observed ?? null, reason: a.result ?? a.error ?? null } });
  }

  /** 만료 스윕 (워커). 재연결 시 만료된 제어를 재생하지 않는다. */
  async expireStale() {
    const stale = await this.prisma.command.findMany({ where: { status: { in: ['QUEUED', 'DISPATCHED'] }, expiresAt: { lt: new Date() } }, select: { id: true } });
    for (const s of stale) await this.transition(s.id, 'EXPIRED', { attemptNo: 99, phase: 'EXPIRED', error: 'ttl' });
    if (stale.length) this.log.log(`expired ${stale.length} commands`);
  }
}
