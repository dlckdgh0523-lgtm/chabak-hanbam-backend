import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { PrismaService } from '../prisma/prisma.service';

export type EventType =
  | 'CAPABILITIES_UPDATED'
  | 'STATE_SNAPSHOT'
  | 'PLAN_UPDATED'
  | 'TRIP_SYNCED'
  | 'COMMAND_STATUS_CHANGED'
  | 'ALERT_RAISED'
  | 'ALERT_ACKED'
  | 'WAKE_PLAN_UPDATED'
  | 'LINK_HEALTH_CHANGED'
  | 'PAIRING_CLAIMED'
  | 'COMMAND_DISPATCH'; // 서버→차량 executor

/** 명세 9장 envelope (제안). aggregateId 는 보통 vehicleId; room 키로 쓴다. */
export interface Envelope {
  schemaVersion: 1;
  eventId: string;
  type: EventType;
  aggregateId: string;
  revision: number;
  sourceDeviceId: string;
  bootId: string;
  seq: number;
  occurredAt: string;
  expiresAt: string | null;
  executionMode: 'MOCK' | 'PLEOS_EMULATOR' | 'REAL' | 'SERVER';
  payload: unknown;
}

/**
 * Outbox: DB 에 먼저 기록(at-least-once) → 워커가 WSS 로 전파.
 * 재접속 클라이언트는 cursor(마지막 version) 이후를 재전송받는다.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(EventsService.name);
  readonly bus = new EventEmitter();
  private timer?: NodeJS.Timeout;
  private readonly bootId = randomUUID();
  private seq = 0;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // 여러 대여도 한 곳만 전파 (같은 행을 두 번 내보내지 않게)
    this.timer = setInterval(() => void this.prisma.runExclusive('worker:outbox', () => this.drain()).catch((err: Error) => this.log.error(`drain failed: ${err.message}`)), 250);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 트랜잭션 밖에서 호출해도 되지만, 가능한 한 쓰기 트랜잭션 안에서 tx 를 넘겨라. */
  publish(
    e: { type: EventType; aggregateId: string; payload: unknown; revision?: number; sourceDeviceId?: string; executionMode?: Envelope['executionMode']; expiresInMs?: number },
    tx: { outboxEvent: PrismaService['outboxEvent'] } = this.prisma,
  ) {
    const eventId = randomUUID();
    const now = new Date();
    const env: Envelope = {
      schemaVersion: 1,
      eventId,
      type: e.type,
      aggregateId: e.aggregateId,
      revision: e.revision ?? 0,
      sourceDeviceId: e.sourceDeviceId ?? 'server',
      bootId: this.bootId,
      seq: ++this.seq,
      occurredAt: now.toISOString(),
      expiresAt: e.expiresInMs ? new Date(now.getTime() + e.expiresInMs).toISOString() : null,
      executionMode: e.executionMode ?? 'SERVER',
      payload: e.payload,
    };
    void tx.outboxEvent
      .create({ data: { eventId, aggregateId: e.aggregateId, type: e.type, version: env.revision, payload: env as object } })
      .catch((err: Error) => this.log.error(`outbox write failed: ${err.message}`));
    return env;
  }

  private draining = false;
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const rows = await this.prisma.outboxEvent.findMany({ where: { processedAt: null }, orderBy: { createdAt: 'asc' }, take: 100 });
      for (const r of rows) {
        this.bus.emit('event', r.payload as unknown as Envelope, r.id);
        await this.prisma.outboxEvent.update({ where: { id: r.id }, data: { processedAt: new Date() } });
      }
    } catch (err) {
      this.log.error(`drain failed: ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  /** 재접속 cursor 재전송용: 해당 aggregate 의 outbox 행 id(순차 증가 아님) 대신 createdAt 기준 */
  async replaySince(aggregateId: string, sinceIso: string, limit = 200) {
    return this.prisma.outboxEvent.findMany({
      where: { aggregateId, createdAt: { gt: new Date(sinceIso) }, processedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
}
