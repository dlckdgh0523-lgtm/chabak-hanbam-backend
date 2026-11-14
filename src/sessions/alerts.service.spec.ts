import { AlertsService } from './alerts.service';
import { AccessService } from '../auth/access.service';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { Observation } from '../common/freshness';
import { carPrincipal, createAccessMock, createConfig, createEventsMock, createPrismaMock, expectApiError, inProduction, PrismaMock, userPrincipal } from '../testing/helpers';

const T0 = new Date('2026-11-13T15:00:10.000Z').getTime();
const reading = (value: unknown, over: Partial<Observation> = {}): Observation => ({
  value, unit: 'ppm', source: 'BLE_SENSOR', sourceDeviceId: 'sensor-1', observedAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(), quality: 'VALID', seq: 1, bootId: 'boot-1', ...over,
});
const activeSession = { id: 's-1', vehicleId: 'vehicle-1', status: 'ACTIVE', executionMode: 'PLEOS_EMULATOR' };

// [이 파일의 의도]
// 서버 경보는 보조다(1차 경보는 차량 앱). 그래도 위험 값은 놓치지 않고, 경고는 너무 자주 울리지 않아야 한다.
// 전달 영수증(RECEIVED, DISPLAYED)은 기술적 확인일 뿐 "사람이 봤다"는 뜻이 아니다.
describe('AlertsService', () => {
  let prisma: PrismaMock;
  let access: ReturnType<typeof createAccessMock>;
  let events: ReturnType<typeof createEventsMock>;
  let service: AlertsService;
  let alerts: { id: string; sessionId: string; sourceEventId: string; kind: string; severity: string; status: string }[];

  // private 메서드는 bracket 접근으로 호출한다 (bus 이벤트 / setInterval 을 거치지 않고 직접 확인)
  const telemetry = (metrics: Record<string, Observation>, sessionId?: string) =>
    service['onTelemetry']({ vehicleId: 'vehicle-1', sessionId, metrics, deviceId: 'sensor-1' });
  const sweep = () => service['sweepDisconnected']();
  const raised = () => alerts.map((a) => `${a.kind}:${a.severity}`);

  beforeEach(() => {
    jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    prisma = createPrismaMock();
    access = createAccessMock();
    events = createEventsMock();
    service = new AlertsService(prisma as unknown as PrismaService, access as unknown as AccessService, events as unknown as EventsService, createConfig());

    alerts = [];
    prisma.sleepSession.findFirst.mockResolvedValue(activeSession);
    prisma.sleepSession.findUniqueOrThrow.mockResolvedValue(activeSession);
    prisma.alert.findFirst.mockImplementation(async ({ where }) => alerts.find((a) => a.sessionId === where.sessionId && a.sourceEventId === where.sourceEventId) ?? null);
    prisma.alert.create.mockImplementation(async ({ data }) => {
      const a = { id: `alert-${alerts.length + 1}`, status: 'RAISED', raisedAt: new Date(), ...data };
      alerts.push(a);
      return a;
    });
  });
  afterEach(() => jest.useRealTimers());

  // ── 9.1 자동 경보 ────────────────────────────────────────────
  describe('9.1 자동 경보 (텔레메트리 → 경보)', () => {
    // 의도: 자지 않을 때(세션이 없을 때) 울리는 경보는 소음이다.
    it('1. ACTIVE 세션이 없으면 경보를 만들지 않는다', async () => {
      prisma.sleepSession.findFirst.mockResolvedValue(null);
      await telemetry({ coPpm: reading(200) });
      expect(alerts).toHaveLength(0);
    });

    // 의도: 오래된 값이나 형식이 틀린 값으로 경보를 만들면 잘못된 경보가 울리거나 해제된다.
    it('1. VALID 인 숫자값으로만 경보를 만든다', async () => {
      await telemetry({ coPpm: reading(200, { quality: 'STALE' }) });
      await telemetry({ coPpm: reading('200') });
      await telemetry({ coPpm: reading(null, { quality: 'UNKNOWN' }) });
      expect(alerts).toHaveLength(0);
    });

    // 의도: 기준값 정각에서 경보가 나야 한다(이상 = 이상 포함).
    it.each([
      ['CO 70ppm 이상', 'coPpm', 70, 'CO_DETECTED:CRITICAL'],
      ['CO 30ppm 이상', 'coPpm', 30, 'CO_ELEVATED:WARNING'],
      ['CO₂ 3500ppm 이상', 'co2Ppm', 3500, 'CO2_CRITICAL:CRITICAL'],
      ['CO₂ 2000ppm 이상', 'co2Ppm', 2000, 'CO2_HIGH:WARNING'],
    ])('1. %s → %s', async (_l, metric, value, expected) => {
      await telemetry({ [metric]: reading(value) });
      expect(raised()).toEqual([expected]);
    });

    // 의도: 기준 바로 아래 값은 경보가 아니다.
    it.each([['coPpm', 29.9], ['co2Ppm', 1999]])('1. 기준 미만(%s=%s)이면 경보 없음', async (metric, value) => {
      await telemetry({ [metric]: reading(value) });
      expect(alerts).toHaveLength(0);
    });

    // 의도: 위험 경보는 사용자 응답을 기다리지 않고 바로 다음 단계로 간다.
    it('1. CO_DETECTED·CO2_CRITICAL 은 응답 타이머 0초다', async () => {
      await telemetry({ coPpm: reading(80), co2Ppm: reading(4000) });
      const timeouts = events.publish.mock.calls.filter((c) => c[0].type === 'ALERT_RAISED').map((c) => c[0].payload.userResponseTimeoutSec);
      expect(timeouts).toEqual([0, 0]);
    });

    // [백엔드 수정] 원래 "샘플(seq)마다 새 경보" 였다. 아래 todo 3 에서 정하기로 한 중복 단위를 1분 + 값 상승 시 재경보로 정해 바꿨다.
    //   같은 샘플 재전송은 여전히 한 건이다.
    it('1. CO_DETECTED 는 같은 분 안에서 값이 그대로면 다시 만들지 않는다 (재전송 포함)', async () => {
      await telemetry({ coPpm: reading(80, { seq: 1 }) });
      await telemetry({ coPpm: reading(80, { seq: 1 }) }); // 같은 샘플 재전송
      await telemetry({ coPpm: reading(80, { seq: 2 }) }); // 5초 뒤 같은 값
      expect(raised()).toEqual(['CO_DETECTED:CRITICAL']);
    });

    // 의도: 경고가 5초마다 울리면 사용자가 무시하게 된다. 5분 구간 경계에서 새 경보가 나는지도 본다.
    it('1. CO_ELEVATED·CO2_HIGH 는 5분 단위로 중복을 제거한다', async () => {
      // T0 = 15:00:10 → 같은 5분 구간(15:00~15:05)
      await telemetry({ coPpm: reading(40), co2Ppm: reading(2500) });
      jest.setSystemTime(T0 + 4 * 60_000);
      await telemetry({ coPpm: reading(40), co2Ppm: reading(2500) });
      expect(alerts).toHaveLength(2);

      jest.setSystemTime(T0 + 5 * 60_000);
      await telemetry({ coPpm: reading(40), co2Ppm: reading(2500) });
      expect(alerts).toHaveLength(4);
    });

    // 의도: 위험 단계라 경고보다 자주(1분) 다시 알린다.
    it('1. CO2_CRITICAL 은 1분 단위로 중복을 제거한다', async () => {
      await telemetry({ co2Ppm: reading(4000) });
      jest.setSystemTime(T0 + 30_000); // 15:00:40 같은 분
      await telemetry({ co2Ppm: reading(4000) });
      expect(alerts).toHaveLength(1);
      jest.setSystemTime(T0 + 50_000); // 15:01:00 다음 분
      await telemetry({ co2Ppm: reading(4000) });
      expect(alerts).toHaveLength(2);
    });

    // 의도: 가짜 값으로 만든 경보가 실제 경보로 보이면 안 된다.
    it('1. MOCK 출처 값으로 만든 경보는 MOCK 모드다', async () => {
      await telemetry({ coPpm: reading(80, { source: 'MOCK' }) });
      expect(prisma.alert.create.mock.calls[0][0].data.executionMode).toBe('MOCK');
      jest.setSystemTime(T0 + 60_000); // [백엔드 수정] CO_DETECTED 1분 묶음 — 다음 분으로 넘겨 새 경보를 만든다
      await telemetry({ coPpm: reading(80, { seq: 9 }) });
      expect(prisma.alert.create.mock.calls[1][0].data.executionMode).toBe('PLEOS_EMULATOR');
    });

    // [백엔드 수정] 단절 감시는 메모리가 아니라 DB 상태 캐시의 observedAt 으로 본다(재시작·다중 인스턴스에도 같은 결과).
    //   그래서 "텔레메트리 호출" 대신 상태 캐시와 ACTIVE 세션 조회를 mock 한다.
    const watch = (metrics: Record<string, Observation>, sessions: unknown[] = [{ ...activeSession, startedAt: new Date(T0) }]) => {
      prisma.sleepSession.findMany.mockResolvedValue(sessions);
      prisma.vehicleStateCache.findMany.mockResolvedValue([{ vehicleId: 'vehicle-1', metrics }]);
    };
    const at = (ms: number) => new Date(T0 + ms).toISOString();

    // 의도: 센서가 꺼지면 감시가 비어 있는 상태다. 그걸 알려야 한다. 한 번 끊긴 동안 경보는 한 번만.
    it('2. CO₂ 값이 15초 동안 안 들어오면 SENSOR_DISCONNECTED(WARNING) 를 단절 1회당 하나 만든다', async () => {
      watch({ co2Ppm: reading(800) });

      jest.setSystemTime(T0 + 15_000);
      await sweep();
      expect(alerts).toHaveLength(0); // 정확히 15초는 아직 아님

      jest.setSystemTime(T0 + 15_001);
      await sweep();
      jest.setSystemTime(T0 + 20_000);
      await sweep();
      expect(raised()).toEqual(['SENSOR_DISCONNECTED:WARNING']);
    });

    // 의도: 두 번째 끊김도 놓치지 않는다.
    it('2. 값이 다시 들어왔다가 또 끊기면 새 단절 경보를 만든다', async () => {
      watch({ coPpm: reading(0) });
      jest.setSystemTime(T0 + 16_000);
      await sweep();
      watch({ coPpm: reading(0, { observedAt: at(16_000) }) }); // 다시 들어옴
      jest.setSystemTime(T0 + 32_000);
      await sweep();
      expect(raised()).toEqual(['SENSOR_DISCONNECTED:WARNING', 'SENSOR_DISCONNECTED:WARNING']);
    });

    // [백엔드 결정 4.3.2-4-5] 센서 폰이 한 대뿐이라 꺼지면 감시가 빈다. 단절 경보는 차량 방(WSS)으로도 나가 차량 화면이 알 수 있다.
    it('4.3.2-4-5. 센서 단절 경보는 차량 방 이벤트(ALERT_RAISED)와 차량 WSS 전달 기록으로도 나간다', async () => {
      watch({ co2Ppm: reading(800) });
      jest.setSystemTime(T0 + 16_000);
      await sweep();
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'ALERT_RAISED', aggregateId: 'vehicle-1', payload: expect.objectContaining({ kind: 'SENSOR_DISCONNECTED' }) }));
      expect(prisma.delivery.createMany.mock.calls[0][0].data).toContainEqual(expect.objectContaining({ channel: 'WSS', recipientRef: 'vehicle:vehicle-1' }));
    });

    // [백엔드 추가] 재시작해도 DB 기준이라 감시가 비지 않는다. 시작 전에 이미 끊긴 센서는 시작 시각부터 센다.
    it('2. 세션 시작 전에 끊긴 센서는 시작 시각부터 15초 뒤 경보한다 (재시작 후에도 같음)', async () => {
      watch({ co2Ppm: reading(800, { observedAt: at(-3600_000) }) }, [{ ...activeSession, startedAt: new Date(T0) }]);
      jest.setSystemTime(T0 + 10_000);
      await sweep();
      expect(alerts).toHaveLength(0);
      jest.setSystemTime(T0 + 16_000);
      await sweep();
      expect(raised()).toEqual(['SENSOR_DISCONNECTED:WARNING']);
      expect(alerts[0].sourceEventId).toBe(`disc:co2Ppm:${T0}`); // (세션, metric, 단절 시작 시각) 유니크
    });

    // [백엔드 추가] 같은 단절을 두 곳(인스턴스)이 동시에 만들어도 유니크 충돌은 중복으로 처리하고 한 건만 남긴다.
    it('2. 같은 단절 경보 생성이 유니크 충돌(P2002)이면 중복으로 보고 에러를 내지 않는다', async () => {
      watch({ co2Ppm: reading(800) });
      prisma.alert.findFirst.mockResolvedValueOnce(null);
      prisma.alert.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
      prisma.alert.findFirstOrThrow.mockResolvedValue({ id: 'alert-x', status: 'RAISED' });
      jest.setSystemTime(T0 + 16_000);
      await expect(sweep()).resolves.toBeUndefined();
      expect(events.publish).not.toHaveBeenCalled();
    });

    // 의도: 일어나서 센서를 끈 걸 단절 경보로 울리면 안 된다.
    it('2. 세션이 끝났으면 단절 경보를 만들지 않는다', async () => {
      watch({ co2Ppm: reading(800) }, []); // ACTIVE 세션 없음
      jest.setSystemTime(T0 + 16_000);
      await sweep();
      expect(alerts).toHaveLength(0);
    });

    // [백엔드 결정] 1분 단위로 묶고, 그 분 안에서 값이 더 오르면 바로 새 경보. 다음 분에는 같은 값이어도 다시 알린다.
    it('3. CO_DETECTED 는 1분 단위로 묶되, 값이 더 오르면 바로 새 경보를 만든다', async () => {
      await telemetry({ coPpm: reading(80, { seq: 1 }) });
      await telemetry({ coPpm: reading(75, { seq: 2 }) }); // 내려감 → 없음
      await telemetry({ coPpm: reading(120, { seq: 3 }) }); // 오름 → 새 경보
      expect(alerts).toHaveLength(2);
      jest.setSystemTime(T0 + 50_000); // 15:01:00 다음 분
      await telemetry({ coPpm: reading(80, { seq: 4 }) });
      expect(raised()).toEqual(['CO_DETECTED:CRITICAL', 'CO_DETECTED:CRITICAL', 'CO_DETECTED:CRITICAL']);
    });

    // 의도: 경보가 어디까지 전달됐는지(차량 화면, 폰 푸시)를 채널별로 추적한다.
    it('4. 경보를 만들면 전달 기록 WSS(SENT)·PUSH(QUEUED) 를 만들고 ALERT_RAISED 이벤트를 보낸다', async () => {
      await telemetry({ coPpm: reading(80) });
      expect(prisma.delivery.createMany).toHaveBeenCalledWith({
        data: [
          { alertId: 'alert-1', channel: 'WSS', recipientRef: 'vehicle:vehicle-1', status: 'SENT' },
          { alertId: 'alert-1', channel: 'PUSH', recipientRef: 'vehicle-users:vehicle-1', status: 'QUEUED' },
        ],
      });
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'ALERT_RAISED', aggregateId: 'vehicle-1', payload: expect.objectContaining({ alertId: 'alert-1', kind: 'CO_DETECTED' }) }));
    });
  });

  // ── 9.2 외부, 테스트 경보 ────────────────────────────────────
  describe('9.2.1 외부 경보 raiseExternal', () => {
    const dto = (over = {}) => ({ sessionId: 's-1', kind: 'DOOR_OPENED', severity: 'WARNING' as const, sourceEventId: 'evt-1', evidence: {}, executionMode: 'PLEOS_EMULATOR' as const, ...over });

    beforeEach(() => access.assertSession.mockResolvedValue(activeSession));

    // 의도: 남의 세션에 가짜 경보를 넣지 못하게.
    it('1. 세션에 접근할 수 없으면 404', async () => {
      access.assertSession.mockRejectedValue(Object.assign(new Error(), { code: 'NOT_FOUND' }));
      await expect(service.raiseExternal(carPrincipal(), dto())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // 의도: 외부 접근 감지 센서 API 가 아직 없다. 실제 감지처럼 보이는 경보를 만들면 안 된다.
    it('2. ACCESS_DETECTED 는 MOCK 이 아니면 422', async () => {
      await expectApiError(service.raiseExternal(carPrincipal(), dto({ kind: 'ACCESS_DETECTED' })), 'UNSUPPORTED_CAPABILITY', 422);
    });

    // 의도: 아는 사람일 수 있으니 30초 동안 사용자 응답을 기다린다.
    it('2. ACCESS_DETECTED(MOCK) 의 응답 타이머는 30초다', async () => {
      await service.raiseExternal(carPrincipal(), dto({ kind: 'ACCESS_DETECTED', executionMode: 'MOCK' }));
      expect(events.publish.mock.calls[0][0].payload).toMatchObject({ userResponseTimeoutSec: 30, demo: true });
    });

    // 의도: 차량이 같은 이벤트를 재전송해도 경보가 두 번 울리지 않게.
    it('3. 같은 세션에 같은 sourceEventId 가 다시 오면 새 경보 없이 duplicate: true 와 기존 경보를 응답한다', async () => {
      const first = await service.raiseExternal(carPrincipal(), dto());
      const second = await service.raiseExternal(carPrincipal(), dto());
      expect(second).toEqual({ alertId: first.alertId, duplicate: true, status: 'RAISED' });
      expect(prisma.alert.create).toHaveBeenCalledTimes(1);
    });

    // 의도: 운영에서 가짜 경보 금지.
    it('1장. production 에서 MOCK 경보는 403', async () => {
      await inProduction(() => expectApiError(service.raiseExternal(carPrincipal(), dto({ executionMode: 'MOCK' })), 'FORBIDDEN', 403));
    });
  });

  describe('9.2.2 테스트 경보 test', () => {
    // 의도: 경보 화면/소리를 미리 시험해 보는 기능. 실제 경보와 구분되게 TEST_, INFO, MOCK 으로 만든다.
    it('1. 차량의 최근 세션(ACTIVE, PREFLIGHT, PLANNED)에 TEST_<종류> INFO MOCK 경보를 만든다', async () => {
      await service.test(userPrincipal(), 'vehicle-1', 'CO');
      expect(prisma.sleepSession.findFirst).toHaveBeenCalledWith({ where: { vehicleId: 'vehicle-1', status: { in: ['ACTIVE', 'PREFLIGHT', 'PLANNED'] } }, orderBy: { createdAt: 'desc' } });
      expect(prisma.alert.create.mock.calls[0][0].data).toMatchObject({ kind: 'TEST_CO', severity: 'INFO', executionMode: 'MOCK' });
    });

    // 의도: 경보는 세션에 붙으므로 세션이 있어야 한다.
    it('2. 세션이 없으면 422', async () => {
      prisma.sleepSession.findFirst.mockResolvedValue(null);
      await expectApiError(service.test(userPrincipal(), 'vehicle-1', 'CO'), 'PRECONDITION_FAILED', 422);
    });
  });

  // ── 9.3 경보 응답, 전달 영수증 ───────────────────────────────
  describe('9.3.1 경보 응답 ack', () => {
    beforeEach(() => {
      prisma.alert.findUnique.mockResolvedValue({ id: 'alert-1', sessionId: 's-1', status: 'RAISED' });
      access.assertSession.mockResolvedValue(activeSession);
      prisma.alertAck.create.mockImplementation(async ({ data }) => data);
    });

    // 의도: 사람이 직접 응답했다는 기록.
    it('1. 사용자가 응답하면 경보가 ACKED 가 된다', async () => {
      await expect(service.ack(userPrincipal('user-1'), 'alert-1', 'OK')).resolves.toMatchObject({ status: 'ACKED' });
      expect(prisma.alert.update).toHaveBeenCalledWith({ where: { id: 'alert-1' }, data: { status: 'ACKED' } });
      expect(prisma.alertAck.create.mock.calls[0][0].data).toMatchObject({ userId: 'user-1', actor: 'USER', action: 'OK' });
    });

    // 의도: 차량 화면이 자동으로 닫힌 것을 사람이 확인한 것으로 치면 안 된다.
    it('2. 자동차 장치가 응답하면 기록만 남기고 경보 상태는 그대로 둔다', async () => {
      await expect(service.ack(carPrincipal(), 'alert-1', 'OK')).resolves.toMatchObject({ status: 'RAISED' });
      expect(prisma.alertAck.create.mock.calls[0][0].data).toMatchObject({ userId: null, actor: 'SYSTEM' });
      expect(prisma.alert.update).not.toHaveBeenCalled();
    });

    // 의도: 응답했다고 위험이 끝난 것은 아니다. 해제는 새 정상 관측으로 판단한다.
    it('3. 자동으로 RESOLVED 로 바꾸지 않는다', async () => {
      await service.ack(userPrincipal(), 'alert-1', 'REQUEST_HELP');
      for (const [arg] of prisma.alert.update.mock.calls) expect(arg.data.status).not.toBe('RESOLVED');
    });

    // 의도: 다른 기기(차량, 다른 폰)의 경보 화면을 닫게 한다.
    it('4. ALERT_ACKED 이벤트를 보낸다', async () => {
      await service.ack(userPrincipal(), 'alert-1', 'SNOOZE');
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'ALERT_ACKED', payload: { alertId: 'alert-1', action: 'SNOOZE', actor: 'USER' } }));
    });

    // 의도: 없는 경보 ID.
    it('없는 경보면 404', async () => {
      prisma.alert.findUnique.mockResolvedValue(null);
      await expectApiError(service.ack(userPrincipal(), 'nope', 'OK'), 'NOT_FOUND', 404);
    });

    // 의도: 전달 기록이 USER_ACK 가 되면 "사용자가 확인함"으로 집계되어, 아무도 보지 않은 경보가 확인된 것처럼 보인다.
    it('5. 자동차 장치가 응답했을 때 전달 기록을 USER_ACK 로 바꾸지 않는다', async () => {
      await service.ack(carPrincipal(), 'alert-1', 'OK');
      expect(prisma.delivery.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'USER_ACK' } }));
    });
  });

  describe('9.3.2 전달 영수증 receipt', () => {
    // 의도: "화면에 떴다"는 "사람이 봤다"가 아니다. 응답 타이머를 멈추면 안 된다.
    it('1. 전달 기록만 바꾸고 경보 상태는 그대로 둔다', async () => {
      prisma.alert.findUnique.mockResolvedValue({ id: 'alert-1', sessionId: 's-1', status: 'RAISED' });
      access.assertSession.mockResolvedValue(activeSession);

      const res = await service.receipt(userPrincipal(), { eventId: 'alert-1', stage: 'DISPLAYED', channel: 'PUSH', time: new Date().toISOString() });

      expect(prisma.delivery.updateMany).toHaveBeenCalledWith({ where: { alertId: 'alert-1', channel: 'PUSH', status: { in: ['QUEUED', 'SENT', 'RECEIVED'] } }, data: { status: 'DISPLAYED' } });
      expect(prisma.alert.update).not.toHaveBeenCalled();
      expect(res.note).toContain('not a user acknowledgement');
    });
  });

  // ── 9.4 비상연락처 SMS ───────────────────────────────────────
  describe('9.4 비상연락처 SMS contactNotification', () => {
    const dto = { recipients: ['c-1', 'c-2'], template: 'CO_ALERT', userActionId: 'act-1' };

    beforeEach(() => {
      prisma.alert.findUnique.mockResolvedValue({ id: 'alert-1', sessionId: 's-1' });
      access.assertSession.mockResolvedValue(activeSession);
      prisma.delivery.findFirst.mockResolvedValue(null);
      // [백엔드 수정] 경보 SMS 도 사용자당 하루 20건 한도를 쓴다(테스트 SMS 와 합산)
      prisma.user.findUniqueOrThrow.mockResolvedValue({ smsQuotaDay: null, smsQuotaUsed: 0 });
    });

    // 의도: 남의 연락처로 문자를 보내는 통로가 되지 않게. 일부만 보내지도 않는다.
    it('3. 본인 연락처가 아닌 수신자가 섞여 있으면 404 이고 보내지 않는다', async () => {
      prisma.emergencyContact.findMany.mockResolvedValue([{ id: 'c-1' }]);
      await expectApiError(service.contactNotification(userPrincipal('user-1'), 'alert-1', dto), 'NOT_FOUND', 404);
      expect(prisma.emergencyContact.findMany).toHaveBeenCalledWith({ where: { userId: 'user-1', id: { in: ['c-1', 'c-2'] } } });
      expect(prisma.delivery.create).not.toHaveBeenCalled();
    });

    // 의도: 버튼 연타로 가족에게 문자가 쏟아지지 않게.
    it('4. 같은 경보에 5분 안에 다시 보내면 429', async () => {
      prisma.delivery.findFirst.mockResolvedValue({ id: 'd-1' });
      await expectApiError(service.contactNotification(userPrincipal(), 'alert-1', dto), 'RATE_LIMITED', 429);
      expect(prisma.delivery.findFirst).toHaveBeenCalledWith({ where: { alertId: 'alert-1', channel: 'SMS', createdAt: { gt: new Date(T0 - 300_000) } } });
    });

    // 의도: 수신자별로 접수 여부를 추적한다.
    it('5. 수신자마다 SMS 전달 기록을 만들고 jobId 를 응답한다', async () => {
      prisma.emergencyContact.findMany.mockResolvedValue([{ id: 'c-1' }, { id: 'c-2' }]);
      const res = await service.contactNotification(userPrincipal(), 'alert-1', dto);
      expect(res).toMatchObject({ jobId: expect.any(String), recipients: 2 });
      expect(prisma.delivery.create).toHaveBeenCalledTimes(2);
      expect(prisma.delivery.create.mock.calls[0][0].data).toMatchObject({ alertId: 'alert-1', channel: 'SMS', recipientRef: 'contact:c-1', status: 'QUEUED' });
    });

    // [백엔드 추가] 연락처에는 아무 번호나 넣을 수 있어 문자 폭탄·비용 악용 통로가 된다. 오늘 이미 19건이면 2명에게는 못 보낸다.
    it('6. 사용자당 하루 SMS 한도(20건)를 넘으면 429 이고 보내지 않는다', async () => {
      prisma.emergencyContact.findMany.mockResolvedValue([{ id: 'c-1' }, { id: 'c-2' }]);
      prisma.user.findUniqueOrThrow.mockResolvedValue({ smsQuotaDay: new Date(T0).toISOString().slice(0, 10), smsQuotaUsed: 19 });
      await expectApiError(service.contactNotification(userPrincipal(), 'alert-1', dto), 'RATE_LIMITED', 429);
      expect(prisma.delivery.create).not.toHaveBeenCalled();
    });
  });

  // ── 9.5 경보 조회 ────────────────────────────────────────────
  describe('9.5 경보 조회 list', () => {
    // 의도: 경보 화면에서 무엇이 언제 울렸고 누가 응답했는지 한 번에 보여준다.
    it('1. 최신순으로 응답하고 응답 기록과 전달 기록을 포함한다', async () => {
      access.assertSession.mockResolvedValue(activeSession);
      await service.list(userPrincipal(), 's-1');
      expect(prisma.alert.findMany).toHaveBeenCalledWith({ where: { sessionId: 's-1' }, orderBy: { raisedAt: 'desc' }, include: { acks: true, deliveries: true } });
    });
  });
});
