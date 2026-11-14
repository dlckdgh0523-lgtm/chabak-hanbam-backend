import { SessionsService } from './sessions.service';
import { AccessService } from '../auth/access.service';
import { EventsService } from '../events/events.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { PrismaService } from '../prisma/prisma.service';
import { Observation } from '../common/freshness';
import { SleepPlanDto } from './sessions.dto';
import { carPrincipal, createAccessMock, createEventsMock, createPrismaMock, expectApiError, inProduction, PrismaMock, userPrincipal } from '../testing/helpers';

const T0 = new Date('2026-11-13T13:00:00.000Z').getTime();
const plan: SleepPlanDto = { heatEnabled: false, targetTempC: null, ventilationPolicy: 'FRESH_AIR_REQUIRED', accessAlertEnabled: true, wakeAt: '2026-11-14T07:00:00+09:00', timezone: 'Asia/Seoul', musicDurationMin: 15 };

const ok = (value: unknown): Observation => ({ value, unit: 'x', source: 'PLEOS', sourceDeviceId: 'car-1', observedAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(), quality: 'VALID', seq: 1, bootId: 'b' });
const safeMetrics = { 'doorLock.all': ok('LOCKED'), 'window.all': ok('CLOSED'), evSocPct: ok(60), batt12vVolt: ok(12.6), coPpm: ok(0), co2Ppm: ok(800) };

const session = (over: Record<string, unknown> = {}) => ({ id: 's-1', vehicleId: 'vehicle-1', tripId: 'trip-1', status: 'PLANNED', planVersion: 1, executionMode: 'PLEOS_EMULATOR', capabilityRevision: 1, ...over });

// [이 파일의 의도]
// 취침 세션: PLANNED → PREFLIGHT → ACTIVE → STOPPED. preflight 가 READY 여야 시작한다.
// "시작"은 차량이 밤새 자동으로 공조를 관리하기 시작한다는 뜻이라, 시작 조건을 엄격하게 본다.
describe('SessionsService', () => {
  let prisma: PrismaMock;
  let access: ReturnType<typeof createAccessMock>;
  let events: ReturnType<typeof createEventsMock>;
  let vehicles: { getState: jest.Mock; getCapabilities: jest.Mock };
  let service: SessionsService;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    prisma = createPrismaMock();
    access = createAccessMock();
    events = createEventsMock();
    vehicles = {
      getState: jest.fn().mockResolvedValue({ revision: 5, connection: 'ONLINE', metrics: safeMetrics }),
      getCapabilities: jest.fn().mockResolvedValue({ revision: 2, features: [] }),
    };
    service = new SessionsService(prisma as unknown as PrismaService, access as unknown as AccessService, events as unknown as EventsService, vehicles as unknown as VehiclesService);

    // view() 에서 쓰는 조회
    prisma.sleepSession.findUniqueOrThrow.mockResolvedValue({ ...session(), startedAt: null, endedAt: null, endReason: null });
    prisma.sleepPlanVersion.findUniqueOrThrow.mockResolvedValue({ desiredPlan: plan });
  });
  afterEach(() => jest.useRealTimers());

  // ── 7.1 세션 생성, 조회, 계획 수정 ───────────────────────────
  describe('7.1.1 세션 생성 create', () => {
    beforeEach(() => {
      access.assertTrip.mockResolvedValue({ id: 'trip-1', vehicleId: 'vehicle-1', status: 'PLANNED' });
      prisma.sleepSession.create.mockResolvedValue({ id: 's-1' });
    });

    // 의도: 남의 예약으로 세션을 만들어 남의 차량을 자동 제어하지 못하게.
    it('1. 본인 예약이 아니면 404', async () => {
      access.assertTrip.mockRejectedValue(Object.assign(new Error(), { code: 'NOT_FOUND' }));
      await expect(service.create(userPrincipal(), { tripId: 'trip-1', desiredPlan: plan })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // 의도: 취소되었거나 끝난 예약으로 세션을 만들면 의미 없는 자동 제어가 생긴다.
    it.each(['CANCELLED', 'DONE'])('2. 예약이 %s 이면 422', async (status) => {
      access.assertTrip.mockResolvedValue({ id: 'trip-1', vehicleId: 'vehicle-1', status });
      await expectApiError(service.create(userPrincipal(), { tripId: 'trip-1', desiredPlan: plan }), 'PRECONDITION_FAILED', 422);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // 의도: 모드를 안 주면 실제 차량 제어가 아니라 시연으로. 안전한 쪽이 기본값이다.
    it('3. executionMode 기본값은 MOCK 이다', async () => {
      await service.create(userPrincipal(), { tripId: 'trip-1', desiredPlan: plan });
      expect(prisma.sleepSession.create.mock.calls[0][0].data.executionMode).toBe('MOCK');
    });

    // 의도: 운영에서 가짜 세션이 실제처럼 보이면 안 된다.
    it('1장. production 에서 MOCK 세션은 403', async () => {
      await inProduction(() => expectApiError(service.create(userPrincipal(), { tripId: 'trip-1', desiredPlan: plan }), 'FORBIDDEN', 403));
    });

    // 의도: 계획 없는 세션이 남으면 조회할 때마다 에러가 난다.
    it('4. 세션과 계획 버전 1 을 한 트랜잭션으로 저장하고 PLAN_UPDATED 이벤트를 보낸다', async () => {
      await service.create(userPrincipal('user-1'), { tripId: 'trip-1', desiredPlan: plan, executionMode: 'PLEOS_EMULATOR' });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.sleepPlanVersion.create).toHaveBeenCalledWith({ data: { sessionId: 's-1', version: 1, desiredPlan: plan, createdBy: 'user-1' } });
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'PLAN_UPDATED', aggregateId: 'vehicle-1', payload: expect.objectContaining({ sessionId: 's-1', planVersion: 1 }) }));
    });
  });

  describe('7.1.2 세션 조회 get', () => {
    // 의도: 여러 계획 버전 중 "현재 버전"의 계획이 나와야 한다.
    it('1. 세션 상태와 현재 버전의 계획을 응답한다', async () => {
      access.assertSession.mockResolvedValue(session());
      const res = await service.get(userPrincipal(), 's-1');
      expect(res).toMatchObject({ id: 's-1', status: 'PLANNED', planVersion: 1, plan });
      expect(prisma.sleepPlanVersion.findUniqueOrThrow).toHaveBeenCalledWith({ where: { sessionId_version: { sessionId: 's-1', version: 1 } } });
    });

    // 의도: 남의 세션 상태를 볼 수 없게.
    it('1. 세션 차량에 접근할 수 없으면 404', async () => {
      access.assertSession.mockRejectedValue(Object.assign(new Error(), { code: 'NOT_FOUND' }));
      await expect(service.get(userPrincipal(), 's-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('7.1.3 계획 수정 patchPlan', () => {
    // 의도: 끝난 세션의 계획을 바꿔도 적용될 곳이 없고, 기록만 헷갈리게 한다.
    it.each(['STOPPED', 'FAILED'])('1. %s 세션이면 422', async (status) => {
      access.assertSession.mockResolvedValue(session({ status }));
      await expectApiError(service.patchPlan(userPrincipal(), 's-1', plan, 1), 'PRECONDITION_FAILED', 422);
    });

    // 의도: 폰과 차량이 동시에 계획을 바꾸면 한쪽이 다른 쪽 수정을 모르고 덮어쓴다.
    it('1. expectedVersion 이 다르면 409', async () => {
      access.assertSession.mockResolvedValue(session({ planVersion: 2 }));
      prisma.sleepSession.updateMany.mockResolvedValue({ count: 0 });
      await expectApiError(service.patchPlan(userPrincipal(), 's-1', plan, 1), 'VERSION_CONFLICT', 409);
      expect(prisma.sleepPlanVersion.create).not.toHaveBeenCalled();
    });

    // 의도: 계획 이력이 남아야 "언제 무엇이 바뀌었는지"를 요약·분쟁 근거로 쓸 수 있다.
    it('2. 성공하면 새 계획 버전을 쌓는다 (기존 버전을 덮어쓰지 않음)', async () => {
      access.assertSession.mockResolvedValue(session());
      prisma.sleepSession.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.patchPlan(userPrincipal('user-1'), 's-1', plan, 1)).resolves.toMatchObject({ planVersion: 2 });
      expect(prisma.sleepSession.updateMany).toHaveBeenCalledWith({ where: { id: 's-1', planVersion: 1 }, data: { planVersion: 2 } });
      expect(prisma.sleepPlanVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sessionId: 's-1', version: 2 }) });
    });

    // 의도: 자는 중의 변경은 "기상 계획 변경"이라 차량이 다르게 처리한다(재검증 후에만 적용).
    it.each([
      ['ACTIVE', 'WAKE_PLAN_UPDATED'],
      ['PLANNED', 'PLAN_UPDATED'],
      ['PREFLIGHT', 'PLAN_UPDATED'],
    ])('3. %s 세션이면 %s 이벤트를 보낸다', async (status, type) => {
      access.assertSession.mockResolvedValue(session({ status }));
      prisma.sleepSession.updateMany.mockResolvedValue({ count: 1 });
      await service.patchPlan(carPrincipal(), 's-1', plan, 1);
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type, revision: 2 }));
    });
  });

  // ── 7.2 preflight ────────────────────────────────────────────
  describe('7.2 preflight', () => {
    beforeEach(() => {
      access.assertSession.mockResolvedValue(session());
      prisma.vehicle.findUniqueOrThrow.mockResolvedValue({ id: 'vehicle-1', powertrain: 'EV' });
      prisma.trip.findUniqueOrThrow.mockResolvedValue({ id: 'trip-1', userId: 'user-1' });
      prisma.consentEvent.findMany.mockResolvedValue([{ purpose: 'VEHICLE_STATE', decision: 'GRANTED' }]);
      prisma.preflight.create.mockImplementation(async ({ data }) => ({ id: 'pf-1', ...data }));
    });

    // 의도: 사용자가 옛날 화면(예: 창문 닫힘)을 보고 확인을 누르는 것을 막는다.
    it('1. 클라이언트가 본 stateRevision 이 서버보다 작으면 422', async () => {
      await expectApiError(service.preflight(userPrincipal(), 's-1', { stateRevision: 4 }), 'PRECONDITION_FAILED', 422);
      expect(prisma.preflight.create).not.toHaveBeenCalled();
    });

    // 의도: 검사 결과는 잠깐만 유효하다. 60초 뒤에는 상태가 바뀌었을 수 있으니 다시 검사해야 한다.
    it('2. 결과는 READY/BLOCKED 와 blocker 목록이고 60초 동안 유효하다', async () => {
      const res = await service.preflight(userPrincipal(), 's-1', { stateRevision: 5 });
      expect(res).toMatchObject({ preflightId: 'pf-1', readiness: 'READY', blockers: [], stateRevision: 5, capabilityRevision: 2 });
      expect((res.expiresAt as Date).getTime()).toBe(T0 + 60_000);
    });

    // 의도: 검사를 한 번이라도 했다는 표시.
    it('3. PLANNED 세션은 PREFLIGHT 가 된다', async () => {
      await service.preflight(userPrincipal(), 's-1', { stateRevision: 5 });
      expect(prisma.sleepSession.update).toHaveBeenCalledWith({ where: { id: 's-1' }, data: { status: 'PREFLIGHT' } });
    });

    // 의도: 자는 중에 다시 검사했다고 ACTIVE 가 PREFLIGHT 로 돌아가면 자동 관리가 멈춘 것처럼 보인다.
    it('3. ACTIVE 세션의 상태는 바꾸지 않는다', async () => {
      access.assertSession.mockResolvedValue(session({ status: 'ACTIVE' }));
      await service.preflight(userPrincipal(), 's-1', { stateRevision: 5 });
      expect(prisma.sleepSession.update).toHaveBeenCalledWith({ where: { id: 's-1' }, data: { status: 'ACTIVE' } });
    });

    // 의도: 저장된 결과로 start 가 판단하므로 저장 값도 BLOCKED 여야 한다.
    it('4. 안전 규칙에 BLOCK 이 있으면 BLOCKED 로 저장한다', async () => {
      prisma.vehicle.findUniqueOrThrow.mockResolvedValue({ id: 'vehicle-1', powertrain: 'ICE' });
      const res = await service.preflight(userPrincipal(), 's-1', { stateRevision: 5 });
      expect(res.readiness).toBe('BLOCKED');
      expect(prisma.preflight.create.mock.calls[0][0].data.readiness).toBe('BLOCKED');
    });

    // 의도: 동의는 계속 쌓인다. 철회했는데 예전 GRANTED 기록 때문에 통과하면 안 된다.
    it('4.1.4 / 4.1-3 목적별로 마지막 결정만 유효하다: GRANTED 후 WITHDRAWN 이면 동의 없음으로 BLOCK', async () => {
      prisma.consentEvent.findMany.mockResolvedValue([
        { purpose: 'VEHICLE_STATE', decision: 'GRANTED' },
        { purpose: 'VEHICLE_STATE', decision: 'WITHDRAWN' },
      ]);
      const res = await service.preflight(userPrincipal(), 's-1', { stateRevision: 5 });
      expect(res.blockers.map((b) => b.code)).toContain('CONSENT_VEHICLE_STATE');
    });

    // 의도: 차량 앱이 preflight 를 요청해도 동의 주체는 예약 주인이다.
    it('6. 동의는 세션을 요청한 사람이 아니라 예약 주인 기준으로 본다', async () => {
      await service.preflight(carPrincipal(), 's-1', { stateRevision: 5 });
      expect(prisma.consentEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' } }));
    });

    // 의도: 끝난 세션을 다시 쓰면 기록(시작/종료 시각, 요약)이 섞인다. 새 세션을 만들어야 한다.
    it('7.3-6. STOPPED 세션은 다시 preflight 를 할 수 없다', async () => {
      access.assertSession.mockResolvedValue(session({ status: 'STOPPED' }));
      await expectApiError(service.preflight(userPrincipal(), 's-1', { stateRevision: 5 }), 'PRECONDITION_FAILED', 422);
    });
  });

  // ── 7.3 시작 ─────────────────────────────────────────────────
  describe('7.3 시작 start', () => {
    const dto = { preflightId: 'pf-1', planVersion: 1, userConfirmed: true, userActionId: 'act-1' };
    const readyPf = (over = {}) => ({ id: 'pf-1', sessionId: 's-1', readiness: 'READY', stateRevision: 5, expiresAt: new Date(T0 + 60_000), blockers: [], ...over });

    beforeEach(() => {
      access.assertSession.mockResolvedValue(session({ status: 'PREFLIGHT' }));
      prisma.preflight.findFirst.mockResolvedValue(readyPf());
    });

    // 의도: 자동 관리는 사용자가 직접 확인 버튼을 눌러야 시작한다.
    it('1. userConfirmed 가 true 가 아니면 422', async () => {
      await expectApiError(service.start(userPrincipal(), 's-1', { ...dto, userConfirmed: false }), 'PRECONDITION_FAILED', 422);
    });

    // 의도: 사용자가 화면에서 본 계획과 실제로 실행되는 계획이 달라지면 안 된다.
    it('2. planVersion 이 현재 버전과 다르면 409', async () => {
      await expectApiError(service.start(userPrincipal(), 's-1', { ...dto, planVersion: 2 }), 'VERSION_CONFLICT', 409);
    });

    // 의도: 다른 세션의 preflight 결과로 시작하지 못하게(세션 ID 까지 같이 조회).
    it('3. preflight 가 없으면 404 (다른 세션의 preflight 도 없는 것으로 본다)', async () => {
      prisma.preflight.findFirst.mockResolvedValue(null);
      await expectApiError(service.start(userPrincipal(), 's-1', dto), 'NOT_FOUND', 404);
      expect(prisma.preflight.findFirst).toHaveBeenCalledWith({ where: { id: 'pf-1', sessionId: 's-1' } });
    });

    // 의도: 60초가 지난 검사 결과로 시작하지 않는다.
    it('3. preflight 가 만료되었으면 422', async () => {
      prisma.preflight.findFirst.mockResolvedValue(readyPf({ expiresAt: new Date(T0 - 1) }));
      await expectApiError(service.start(userPrincipal(), 's-1', dto), 'PRECONDITION_FAILED', 422);
    });

    // 의도: BLOCKED 결과로 시작하지 않고, 무엇 때문인지 blocker 를 함께 알려준다.
    it('3. preflight 가 READY 가 아니면 422 이고 blocker 를 details 로 준다', async () => {
      prisma.preflight.findFirst.mockResolvedValue(readyPf({ readiness: 'BLOCKED', blockers: [{ code: 'SOC_LOW' }] }));
      const err = await expectApiError(service.start(userPrincipal(), 's-1', dto), 'PRECONDITION_FAILED', 422);
      expect(err.details).toEqual([{ code: 'SOC_LOW' }]);
    });

    // 의도: 차량은 이 이벤트를 받고 로컬 재검증 후에만 자동 관리를 시작한다.
    it('4. 성공하면 ACTIVE 가 되고 PLAN_UPDATED 이벤트를 보낸다', async () => {
      await service.start(userPrincipal(), 's-1', dto);
      expect(prisma.sleepSession.update).toHaveBeenCalledWith({ where: { id: 's-1' }, data: { status: 'ACTIVE', startedAt: expect.any(Date) } });
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'PLAN_UPDATED', payload: expect.objectContaining({ status: 'ACTIVE', userActionId: 'act-1' }) }));
    });

    // 의도: 검사 후 SOC 가 떨어지는 등 안전 판단이 바뀌면, 이전 READY 로 시작하지 않는다.
    it('5. preflight 이후 안전 판단에 쓰는 상태(SOC 30% 미만으로 하락)가 바뀌면 시작을 막는다', async () => {
      vehicles.getState.mockResolvedValue({ revision: 6, connection: 'ONLINE', metrics: { ...safeMetrics, evSocPct: ok(10) } });
      await expectApiError(service.start(userPrincipal(), 's-1', dto), 'PRECONDITION_FAILED', 422);
      expect(prisma.sleepSession.update).not.toHaveBeenCalled();
    });

    // 의도: 센서는 5초마다 값을 올려 revision 이 계속 오른다. revision 이 정확히 같아야 시작할 수 있으면 센서가 있는 한 시작이 거의 불가능하다.
    it('5. 센서가 CO₂ 값만 새로 올려 revision 이 오른 경우에는 시작할 수 있어야 한다', async () => {
      vehicles.getState.mockResolvedValue({ revision: 6, connection: 'ONLINE', metrics: { ...safeMetrics, co2Ppm: ok(810) } });
      await expect(service.start(userPrincipal(), 's-1', dto)).resolves.toBeDefined();
    });

    // 의도: 끝난 세션이 다시 ACTIVE 가 되면 종료 시각·요약·취소된 명령 기록이 꼬인다.
    it('6. STOPPED 세션은 다시 start 할 수 없다', async () => {
      access.assertSession.mockResolvedValue(session({ status: 'STOPPED' }));
      await expectApiError(service.start(userPrincipal(), 's-1', dto), 'PRECONDITION_FAILED', 422);
    });

    // 의도: 같은 차량에 자동 관리 세션이 두 개면 두 계획이 서로 다른 명령을 보내 충돌한다.
    it('7. (확인 필요) 한 차량에는 ACTIVE 세션이 하나만 있다: 같은 차량에 이미 ACTIVE 세션이 있으면 시작하지 않는다', async () => {
      const other = { ...session({ id: 's-other', status: 'ACTIVE' }) };
      prisma.sleepSession.findFirst.mockResolvedValue(other);
      prisma.sleepSession.findMany.mockResolvedValue([other]);
      prisma.sleepSession.count.mockResolvedValue(1);

      await expect(service.start(userPrincipal(), 's-1', dto)).rejects.toBeDefined();
      expect(prisma.sleepSession.update).not.toHaveBeenCalled();
    });
  });

  // ── 7.4 종료 ─────────────────────────────────────────────────
  describe('7.4 종료 stop', () => {
    // 의도: 사용자와 차량이 동시에 종료해도 종료 처리와 이벤트는 한 번만.
    it('1. 이미 STOPPED 면 아무것도 바꾸지 않고 그대로 응답한다', async () => {
      access.assertSession.mockResolvedValue(session({ status: 'STOPPED' }));
      await service.stop(userPrincipal(), 's-1', { reason: 'USER_STOP' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(events.publish).not.toHaveBeenCalled();
    });

    // 의도: 전원 꺼짐, 수동 조작 등은 차량이 먼저 안다. 종료 사유가 기록되어야 요약에서 설명할 수 있다.
    it('1·2. 자동차 장치도 종료할 수 있고, 종료 시각과 사유를 기록한다', async () => {
      access.assertSession.mockResolvedValue(session({ status: 'ACTIVE' }));
      await service.stop(carPrincipal(), 's-1', { reason: 'POWER_LOSS' });
      expect(prisma.sleepSession.update).toHaveBeenCalledWith({ where: { id: 's-1' }, data: { status: 'STOPPED', endedAt: expect.any(Date), endReason: 'POWER_LOSS' } });
    });

    // 의도: 끝난 세션의 명령이 차량 재연결 후 늦게 실행되면 위험하다. 종료와 같은 트랜잭션에서 취소한다.
    it('3. 처리되지 않은 명령(REQUESTED, QUEUED, DISPATCHED)을 모두 CANCELLED 로 바꾼다 (같은 트랜잭션)', async () => {
      access.assertSession.mockResolvedValue(session({ status: 'ACTIVE' }));
      await service.stop(userPrincipal(), 's-1', { reason: 'USER_STOP' });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.command.updateMany).toHaveBeenCalledWith({
        where: { sessionId: 's-1', status: { in: ['REQUESTED', 'QUEUED', 'DISPATCHED'] } },
        data: { status: 'CANCELLED', reason: 'session stopped: USER_STOP' },
      });
    });

    // 의도: 차량이 자동 관리를 멈추는 신호.
    it('4. PLAN_UPDATED(STOPPED) 이벤트를 보낸다', async () => {
      access.assertSession.mockResolvedValue(session({ status: 'ACTIVE' }));
      await service.stop(userPrincipal(), 's-1', { reason: 'USER_STOP' });
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'PLAN_UPDATED', payload: expect.objectContaining({ status: 'STOPPED', reason: 'USER_STOP', by: 'USER' }) }));
    });

    // 노션 8.3-2
    // 의도: 차량 inbox 에 이미 들어간 명령은 서버에서 취소만 해서는 모른다. 알려줘야 실행하지 않는다.
    it('8.3-2. 세션 종료로 취소된 명령도 COMMAND_STATUS_CHANGED 로 차량에 알린다', async () => {
      access.assertSession.mockResolvedValue(session({ status: 'ACTIVE' }));
      prisma.command.findMany.mockResolvedValue([{ id: 'cmd-1', vehicleId: 'vehicle-1', status: 'DISPATCHED' }]);
      prisma.command.updateMany.mockResolvedValue({ count: 1 });
      await service.stop(userPrincipal(), 's-1', { reason: 'USER_STOP' });
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'COMMAND_STATUS_CHANGED', payload: expect.objectContaining({ status: 'CANCELLED' }) }));
    });
  });

  // ── 7.5 요약 ─────────────────────────────────────────────────
  describe('7.5 요약 summary', () => {
    const at = (s: number) => new Date(T0 + s * 1000);

    beforeEach(() => {
      access.assertSession.mockResolvedValue(session({ status: 'STOPPED' }));
      prisma.sleepSession.findUniqueOrThrow.mockResolvedValue({ ...session({ status: 'STOPPED' }), startedAt: at(0), endedAt: at(60), createdAt: at(0), endReason: 'USER_STOP', alerts: [], commands: [] });
    });

    // 의도: 아침 요약. 측정이 빠진 구간을 "정상"으로 보여주면 안 된다.
    it('1·3. metric 별 개수/최솟값/최댓값/처음/마지막 시각, 그리고 기록 없음·부분 기록·연속 기록을 구분한다', async () => {
      const co2 = Array.from({ length: 12 }, (_, i) => ({ metric: 'co2Ppm', value: 800 + i * 10, observedAt: at(i * 5), source: 'BLE_SENSOR', quality: 'VALID' }));
      prisma.telemetrySample.findMany.mockResolvedValue([
        ...co2,
        { metric: 'evSocPct', value: 60, observedAt: at(0), source: 'PLEOS', quality: 'VALID' },
      ]);

      const res = await service.summary(userPrincipal(), 's-1');

      expect(res.metrics.co2Ppm).toMatchObject({ count: 12, min: 800, max: 910, firstAt: at(0).toISOString(), lastAt: at(55).toISOString(), gaps: [] });
      expect(res.coverage.co2Ppm).toBe('연속 기록');
      expect(res.coverage.coPpm).toBe('기록 없음');
      expect(res.coverage.evSocPct).toMatch(/^부분 기록/); // 1개뿐 → 커버율 80% 미만
    });

    // 의도: 경계값: 정확히 60초 간격은 결측이 아니고, 61초부터 결측이다.
    it('2. 1분 이상 빈 구간을 결측으로 표시한다', async () => {
      prisma.sleepSession.findUniqueOrThrow.mockResolvedValue({ ...session(), startedAt: at(0), endedAt: at(100), createdAt: at(0), alerts: [], commands: [] });
      prisma.telemetrySample.findMany.mockResolvedValue([
        { metric: 'coPpm', value: 0, observedAt: at(0), source: 'BLE_SENSOR', quality: 'VALID' },
        { metric: 'coPpm', value: 0, observedAt: at(60), source: 'BLE_SENSOR', quality: 'VALID' }, // 정확히 60초는 결측 아님
        { metric: 'coPpm', value: 0, observedAt: at(121), source: 'BLE_SENSOR', quality: 'VALID' }, // 61초 → 결측
      ]);
      const res = await service.summary(userPrincipal(), 's-1');
      expect(res.metrics.coPpm.gaps).toEqual([{ from: at(60).toISOString(), to: at(121).toISOString() }]);
      expect(res.coverage.coPpm).toMatch(/^부분 기록 .*1회 결측/);
    });
  });
});
