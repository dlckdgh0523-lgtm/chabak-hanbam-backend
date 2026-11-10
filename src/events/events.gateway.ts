import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { IncomingMessage } from 'http';
import { Server, WebSocket } from 'ws';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../auth/token.service';
import { Envelope, EventsService } from './events.service';

interface Client {
  ws: WebSocket;
  principal: string;
  rooms: Set<string>; // vehicleId
}

/**
 * WSS /v1/ws?token=<bearer>&vehicleId=<id>&since=<iso>
 * - 인증 후 소유/연결된 vehicle room 만 가입 (서버가 검사; 클라이언트가 임의 room 지정 불가)
 * - since 가 있으면 그 이후 outbox 를 재전송 (at-least-once; 클라이언트 inbox 에서 eventId 중복 제거)
 * - 보관 범위를 넘으면 {type:'RESYNC_REQUIRED'} → GET /vehicles/:id/state 재조회
 */
@WebSocketGateway({ path: '/v1/ws' })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(EventsGateway.name);
  @WebSocketServer() server: Server;
  private clients = new Map<WebSocket, Client>();

  constructor(private readonly prisma: PrismaService, private readonly tokens: TokenService, private readonly events: EventsService) {}

  afterInit() {
    this.events.bus.on('event', (env: Envelope) => this.broadcast(env));
  }

  async handleConnection(ws: WebSocket, req: IncomingMessage) {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const token = url.searchParams.get('token') ?? '';
      const vehicleId = url.searchParams.get('vehicleId') ?? '';
      const since = url.searchParams.get('since');

      const principal = await this.resolve(token);
      if (!principal) return this.reject(ws, 4401, 'unauthenticated');

      const where = principal.kind === 'USER' ? { userId: principal.id, vehicleId, status: 'ACTIVE' as const } : { deviceId: principal.id, vehicleId, status: 'ACTIVE' as const };
      const link = await this.prisma.vehicleLink.findFirst({ where });
      if (!link) return this.reject(ws, 4403, 'no access to vehicle room');

      this.clients.set(ws, { ws, principal: `${principal.kind}:${principal.id}`, rooms: new Set([vehicleId]) });
      ws.send(JSON.stringify({ type: 'HELLO', vehicleId, serverTime: new Date().toISOString() }));

      if (since) {
        const rows = await this.events.replaySince(vehicleId, since);
        if (rows.length >= 200) ws.send(JSON.stringify({ type: 'RESYNC_REQUIRED', reason: 'replay window exceeded' }));
        for (const r of rows) ws.send(JSON.stringify(r.payload));
      }
    } catch (e) {
      this.log.warn(`ws connect failed: ${(e as Error).message}`);
      this.reject(ws, 4400, 'bad request');
    }
  }

  handleDisconnect(ws: WebSocket) {
    this.clients.delete(ws);
  }

  private reject(ws: WebSocket, code: number, reason: string) {
    try { ws.close(code, reason); } catch { /* ignore */ }
  }

  private async resolve(raw: string): Promise<{ kind: 'USER' | 'DEVICE'; id: string } | null> {
    if (!raw) return null;
    if (this.tokens.isDeviceToken(raw)) {
      const d = await this.prisma.device.findUnique({ where: { tokenHash: this.tokens.hash(raw) } });
      return d && !d.revokedAt ? { kind: 'DEVICE', id: d.id } : null;
    }
    const p = this.tokens.verifyUserAccess(raw);
    return p ? { kind: 'USER', id: p.sub } : null;
  }

  private broadcast(env: Envelope) {
    const msg = JSON.stringify(env);
    for (const c of this.clients.values()) {
      if (c.rooms.has(env.aggregateId) && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
    }
  }
}
