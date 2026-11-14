import { IncomingMessage } from 'http';
import { JwtService } from '@nestjs/jwt';
import { WebSocket } from 'ws';
import { Envelope, EventsService } from './events.service';
import { EventsGateway } from './events.gateway';
import { TokenService } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';
import { createConfig, createPrismaMock, PrismaMock } from '../testing/helpers';

const T0 = new Date('2026-11-13T15:00:00.000Z').getTime();

// [이 파일의 의도]
// 실시간 이벤트: DB(Outbox)에 먼저 쓰고 0.25초마다 WebSocket 으로 보낸다.
// 유실보다 중복이 낫다(at-least-once). 중복은 클라이언트가 eventId 로 거른다.
describe('EventsService (10.1 이벤트 저장, 전파)', () => {
  let prisma: PrismaMock;
  let events: EventsService;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    prisma = createPrismaMock();
    prisma.outboxEvent.create.mockResolvedValue({});
    events = new EventsService(prisma as unknown as PrismaService, createConfig());
  });
  afterEach(() => {
    events.onModuleDestroy();
    jest.useRealTimers();
  });

  // 의도: 서버가 보내기 직전에 죽어도 이벤트가 DB 에 남아, 재시작 후 보낸다.
  it('1. 이벤트는 전파 전에 Outbox 에 먼저 저장한다', () => {
    const env = events.publish({ type: 'STATE_SNAPSHOT', aggregateId: 'vehicle-1', revision: 3, payload: { a: 1 } });
    expect(prisma.outboxEvent.create).toHaveBeenCalledWith({ data: { eventId: env.eventId, aggregateId: 'vehicle-1', type: 'STATE_SNAPSHOT', version: 3, payload: env } });
  });

  // 의도: 폰/차량 앱이 파싱하는 계약이다. 필드가 빠지면 앱이 깨진다.
  it('2. 이벤트 봉투는 정해진 필드를 모두 갖는다', () => {
    const env = events.publish({ type: 'COMMAND_DISPATCH', aggregateId: 'vehicle-1', payload: { x: 1 }, sourceDeviceId: 'car-1', executionMode: 'MOCK', expiresInMs: 30_000 });
    expect(env).toEqual<Envelope>({
      schemaVersion: 1, eventId: expect.any(String), type: 'COMMAND_DISPATCH', aggregateId: 'vehicle-1', revision: 0, sourceDeviceId: 'car-1',
      bootId: expect.any(String), seq: expect.any(Number), occurredAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 30_000).toISOString(), executionMode: 'MOCK', payload: { x: 1 },
    });
  });

  // 의도: eventId 로 중복을 거르고, bootId+seq 로 순서를 판단한다.
  it('2. 기본값: sourceDeviceId=server, executionMode=SERVER, expiresAt=null, eventId 와 seq 는 매번 달라진다', () => {
    const a = events.publish({ type: 'PLAN_UPDATED', aggregateId: 'v', payload: {} });
    const b = events.publish({ type: 'PLAN_UPDATED', aggregateId: 'v', payload: {} });
    expect(a).toMatchObject({ sourceDeviceId: 'server', executionMode: 'SERVER', expiresAt: null });
    expect(a.eventId).not.toBe(b.eventId);
    expect(b.seq).toBe(a.seq + 1);
    expect(a.bootId).toBe(b.bootId);
  });

  // 의도: 보낸 이벤트는 처리 시각을 기록해 다시 보내지 않는다.
  it('1. 0.25초마다 미처리 이벤트를 전파하고 처리 시각을 기록한다', async () => {
    const rows = [{ id: 'o-1', payload: { eventId: 'e-1' } }, { id: 'o-2', payload: { eventId: 'e-2' } }];
    prisma.outboxEvent.findMany.mockResolvedValue(rows);
    prisma.outboxEvent.update.mockResolvedValue({});
    const emitted: string[] = [];
    events.bus.on('event', (env: Envelope) => emitted.push(env.eventId));

    events.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);

    expect(prisma.outboxEvent.findMany).toHaveBeenCalledWith({ where: { processedAt: null }, orderBy: { createdAt: 'asc' }, take: 100 });
    expect(emitted).toEqual(['e-1', 'e-2']);
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith({ where: { id: 'o-1' }, data: { processedAt: expect.any(Date) } });
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith({ where: { id: 'o-2' }, data: { processedAt: expect.any(Date) } });
  });

  // 의도: 처리 기록에 실패하면 다음 주기에 다시 보낸다. 안 보내는 것보다 두 번 보내는 게 낫다.
  it('1. 한 번 이상 전달(at-least-once): 처리 시각 기록에 실패하면 다음 주기에 같은 이벤트를 다시 보낸다', async () => {
    prisma.outboxEvent.findMany.mockResolvedValue([{ id: 'o-1', payload: { eventId: 'e-1' } }]);
    prisma.outboxEvent.update.mockRejectedValueOnce(new Error('db down')).mockResolvedValue({});
    const emitted: string[] = [];
    events.bus.on('event', (env: Envelope) => emitted.push(env.eventId));

    events.onModuleInit();
    await jest.advanceTimersByTimeAsync(500);

    expect(emitted).toEqual(['e-1', 'e-1']);
  });

  describe('10.3 재접속 시 재전송 replaySince', () => {
    // 의도: 재접속한 클라이언트가 끊긴 동안 놓친 이벤트를 받는다. 아직 안 보낸 건 drain 이 보낼 것이라 제외.
    it('1. since 이후 전파된(처리된) 이벤트를 차량별로 최대 200개, 오래된 순으로 조회한다', async () => {
      prisma.outboxEvent.findMany.mockResolvedValue([]);
      await events.replaySince('vehicle-1', '2026-11-13T14:00:00.000Z');
      expect(prisma.outboxEvent.findMany).toHaveBeenCalledWith({
        where: { aggregateId: 'vehicle-1', createdAt: { gt: new Date('2026-11-13T14:00:00.000Z') }, processedAt: { not: null } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
    });
  });
});

// [이 describe 의 의도]
// WebSocket 접속은 HTTP AuthGuard 를 거치지 않는다. 인증·차량 방 권한·탈퇴/만료 처리를 여기서 따로 해야 한다.
describe('EventsGateway (10.2 WebSocket 접속, 10.3 재전송)', () => {
  let prisma: PrismaMock;
  let tokens: TokenService;
  let events: { bus: { on: jest.Mock }; replaySince: jest.Mock };
  let gateway: EventsGateway;
  let onEvent: (env: Envelope) => void;

  const fakeWs = () => ({ send: jest.fn(), close: jest.fn(), readyState: WebSocket.OPEN }) as unknown as WebSocket & { send: jest.Mock; close: jest.Mock };
  const connect = async (query: string) => {
    const ws = fakeWs();
    await gateway.handleConnection(ws, { url: `/v1/ws?${query}` } as IncomingMessage);
    return ws;
  };
  const sent = (ws: { send: jest.Mock }) => ws.send.mock.calls.map((c) => JSON.parse(c[0]));

  beforeEach(() => {
    prisma = createPrismaMock();
    tokens = new TokenService(new JwtService(), createConfig());
    events = { bus: { on: jest.fn((_e, fn) => (onEvent = fn)) }, replaySince: jest.fn().mockResolvedValue([]) };
    gateway = new EventsGateway(prisma as unknown as PrismaService, tokens, events as unknown as EventsService);
    gateway.afterInit();
  });

  // 의도: WebSocket 은 HTTP guard 를 거치지 않으므로 여기서 따로 인증한다.
  it('1. 토큰이 없거나 잘못되면 4401 로 닫는다', async () => {
    expect((await connect('vehicleId=vehicle-1')).close).toHaveBeenCalledWith(4401, expect.any(String));
    expect((await connect('token=garbage&vehicleId=vehicle-1')).close).toHaveBeenCalledWith(4401, expect.any(String));
  });

  // 의도: 연결 해제된 차량 앱이 계속 이벤트를 받지 못하게.
  it('1. 폐기된 장치 토큰이면 4401', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: 'car-1', revokedAt: new Date() });
    expect((await connect('token=dvt_x&vehicleId=vehicle-1')).close).toHaveBeenCalledWith(4401, expect.any(String));
  });

  // 의도: 남의 차량 이벤트(경보, 상태, 예약)를 엿듣지 못하게.
  it('1. 그 차량에 ACTIVE 연결이 없으면 4403', async () => {
    prisma.vehicleLink.findFirst.mockResolvedValue(null);
    const ws = await connect(`token=${tokens.signUserAccess('user-1')}&vehicleId=vehicle-1`);
    expect(ws.close).toHaveBeenCalledWith(4403, expect.any(String));
    expect(prisma.vehicleLink.findFirst).toHaveBeenCalledWith({ where: { userId: 'user-1', vehicleId: 'vehicle-1', status: 'ACTIVE' } });
  });

  // 의도: 잘못된 요청으로 서버 오류가 나도 연결은 정해진 코드로 닫힌다.
  it('1. 요청 형식이 잘못되면(예: since 가 날짜가 아님) 4400', async () => {
    prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-1' });
    events.replaySince.mockImplementation(async (_v: string, since: string) => {
      if (Number.isNaN(Date.parse(since))) throw new Error('Invalid Date');
      return [];
    });
    const ws = await connect(`token=${tokens.signUserAccess('user-1')}&vehicleId=vehicle-1&since=not-a-date`);
    expect(ws.close).toHaveBeenCalledWith(4400, expect.any(String));
  });

  // 의도: 클라이언트가 "구독 완료"를 알고 서버 시각을 받는다.
  it('2. 접속에 성공하면 HELLO 메시지를 보낸다', async () => {
    prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-1' });
    const ws = await connect(`token=${tokens.signUserAccess('user-1')}&vehicleId=vehicle-1`);
    expect(ws.close).not.toHaveBeenCalled();
    expect(sent(ws)[0]).toMatchObject({ type: 'HELLO', vehicleId: 'vehicle-1' });
  });

  // 의도: 방(room) 단위로 나눠서 다른 차량 이벤트가 섞이지 않게.
  it('3. 클라이언트는 허용된 차량 방의 이벤트만 받는다', async () => {
    prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-1' });
    const ws = await connect(`token=${tokens.signUserAccess('user-1')}&vehicleId=vehicle-1`);
    ws.send.mockClear();

    onEvent({ aggregateId: 'vehicle-2', eventId: 'e-other' } as Envelope);
    onEvent({ aggregateId: 'vehicle-1', eventId: 'e-mine' } as Envelope);

    expect(sent(ws).map((m) => m.eventId)).toEqual(['e-mine']);
  });

  // 의도: 끊긴 소켓에 보내다 오류가 나지 않게.
  it('3. 연결이 끊긴 클라이언트에는 보내지 않는다', async () => {
    prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-1' });
    const ws = await connect(`token=${tokens.signUserAccess('user-1')}&vehicleId=vehicle-1`);
    gateway.handleDisconnect(ws);
    ws.send.mockClear();
    onEvent({ aggregateId: 'vehicle-1', eventId: 'e-1' } as Envelope);
    expect(ws.send).not.toHaveBeenCalled();
  });

  // 의도: HTTP 는 페어링 전 차량 앱의 자기 차량 접근을 허용하는데(QR 생성 등), WebSocket 은 ACTIVE 연결만 본다.
  //       페어링 전에 PAIRING_CLAIMED 를 실시간으로 받아야 하는지 정해지지 않아 todo 로 둔다.
  it.todo('4. (확인 필요) 페어링 전 자동차 장치도 자기 차량 방에 접속할 수 있어야 하는가 — 현재 HTTP 는 허용, WebSocket 은 4403');

  // 의도: HTTP 는 탈퇴하면 바로 막히는데 WebSocket 만 열려 있으면 탈퇴 후에도 차량 이벤트를 계속 받는다.
  it('5. 탈퇴한 사용자의 JWT 로는 접속할 수 없다', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', deletionRequestedAt: new Date() });
    prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-1' }); // 탈퇴 처리 직전 상태 등으로 링크가 남아 있다고 가정
    const ws = await connect(`token=${tokens.signUserAccess('user-1')}&vehicleId=vehicle-1`);
    expect(ws.close).toHaveBeenCalledWith(4401, expect.any(String));
  });

  // 의도: 접속할 때만 검사하면 한 번 연결된 소켓은 토큰이 만료돼도 계속 이벤트를 받는다.
  it('5. 만료된 JWT 로는 연결을 유지할 수 없다: 접속 후 토큰이 만료되면 연결을 끊는다', async () => {
    jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', deletionRequestedAt: null });
      prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-1' });
      const shortLived = new TokenService(new JwtService(), createConfig({ JWT_USER_TTL_SEC: '60' })).signUserAccess('user-1');

      const ws = await connect(`token=${shortLived}&vehicleId=vehicle-1`);
      expect(ws.close).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(5 * 60_000); // 만료 후 5분
      expect(ws.close).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  describe('10.3 재접속 시 재전송', () => {
    beforeEach(() => prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-1' }));

    // 의도: HELLO 다음에 놓친 이벤트를 순서대로 보낸다.
    it('1. since 를 주면 그 이후 이벤트를 다시 보낸다', async () => {
      events.replaySince.mockResolvedValue([{ payload: { eventId: 'e-1' } }, { payload: { eventId: 'e-2' } }]);
      const ws = await connect(`token=${tokens.signUserAccess('user-1')}&vehicleId=vehicle-1&since=2026-11-13T14:00:00Z`);
      expect(events.replaySince).toHaveBeenCalledWith('vehicle-1', '2026-11-13T14:00:00Z');
      expect(sent(ws).map((m) => m.type ?? m.eventId)).toEqual(['HELLO', 'e-1', 'e-2']);
    });

    // 의도: 너무 많이 놓쳤으면 이벤트를 다 주는 대신 상태를 새로 조회하게 한다.
    it('2. 200개에 닿으면 RESYNC_REQUIRED 를 보낸다', async () => {
      events.replaySince.mockResolvedValue(Array.from({ length: 200 }, (_, i) => ({ payload: { eventId: `e-${i}` } })));
      const ws = await connect(`token=${tokens.signUserAccess('user-1')}&vehicleId=vehicle-1&since=2026-11-13T14:00:00Z`);
      expect(sent(ws).map((m) => m.type)).toContain('RESYNC_REQUIRED');
    });

    // 의도: 경계값: 199개는 재전송만으로 충분하다.
    it('2. 200개 미만이면 RESYNC_REQUIRED 를 보내지 않는다', async () => {
      events.replaySince.mockResolvedValue(Array.from({ length: 199 }, (_, i) => ({ payload: { eventId: `e-${i}` } })));
      const ws = await connect(`token=${tokens.signUserAccess('user-1')}&vehicleId=vehicle-1&since=2026-11-13T14:00:00Z`);
      expect(sent(ws).map((m) => m.type)).not.toContain('RESYNC_REQUIRED');
    });
  });
});
