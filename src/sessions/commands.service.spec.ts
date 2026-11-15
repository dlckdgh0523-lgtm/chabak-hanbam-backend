import { CommandsService } from './commands.service';
import { AccessService } from '../auth/access.service';
import { EventsService } from '../events/events.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { PrismaService } from '../prisma/prisma.service';
import { CommandRequestDto } from './sessions.dto';
import { carPrincipal, createAccessMock, createEventsMock, createPrismaMock, expectApiError, inProduction, PrismaMock, userPrincipal } from '../testing/helpers';

const T0 = new Date('2026-11-13T13:00:00.000Z').getTime();
const hvac = (over = {}) => ({ feature: 'hvac.temperature', supported: true, writeAllowed: true, min: 16, max: 28, step: 0.5, areas: ['ROW_1_LEFT'], ...over });

// [이 파일의 의도]
// 차량 명령: 서버는 검사·전달·기록만 하고, 실행과 확인은 차량이 한다.
// ACCEPTED(SDK 호출 성공)와 VERIFIED(실제 상태를 다시 읽어 확인)를 구분하는 게 핵심이다.
describe('CommandsService', () => {
  let prisma: PrismaMock;
  let access: ReturnType<typeof createAccessMock>;
  let events: ReturnType<typeof createEventsMock>;
  let vehicles: { getState: jest.Mock; getCapabilities: jest.Mock };
  let service: CommandsService;

  const dto = (over: Partial<CommandRequestDto> = {}): CommandRequestDto => ({
    action: { type: 'SET_CLIMATE_TARGET', targetTempC: 20, areaId: 'ROW_1_LEFT' },
    expectedStateRevision: 5, capabilityRevision: 2, expiresAt: new Date(T0 + 30_000).toISOString(), userActionId: 'act-1', executionMode: 'PLEOS_EMULATOR', ...over,
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    prisma = createPrismaMock();
    access = createAccessMock();
    events = createEventsMock();
    vehicles = {
      getState: jest.fn().mockResolvedValue({ revision: 5, connection: 'ONLINE' }),
      getCapabilities: jest.fn().mockResolvedValue({ revision: 2, features: [hvac(), { feature: 'hvac.recirculation', supported: true, writeAllowed: true }] }),
    };
    service = new CommandsService(prisma as unknown as PrismaService, access as unknown as AccessService, events as unknown as EventsService, vehicles as unknown as VehiclesService);
    prisma.command.create.mockResolvedValue({ id: 'cmd-1', vehicleId: 'vehicle-1', mode: 'PLEOS_EMULATOR' });
    prisma.command.update.mockImplementation(async ({ data }) => ({ id: 'cmd-1', vehicleId: 'vehicle-1', mode: 'PLEOS_EMULATOR', ...data }));
  });
  afterEach(() => jest.useRealTimers());

  // ── 8.1 명령 요청 ────────────────────────────────────────────
  describe('8.1 명령 요청 request', () => {
    describe('2. 모드별 allowlist', () => {
      // 의도: 공식 승인 전에는 실차 제어를 하지 않는다. 에뮬레이터에서 검증되지 않은 문 잠금도 막는다.
      it.each([
        ['MOCK', 'LOCK_DOOR', true],
        ['MOCK', 'REQUEST_FRESH_AIR', true],
        ['PLEOS_EMULATOR', 'LOCK_DOOR', false],
        ['PLEOS_EMULATOR', 'REQUEST_FRESH_AIR', true],
        ['REAL', 'SET_CLIMATE_TARGET', false],
      ] as const)('%s 모드에서 %s 허용=%s', async (mode, type, allowed) => {
        // [백엔드 수정] 명령별 허용 필드만 받는다(8.1-9). 모든 type 에 areaId+fanLevel 을 섞어 보내면 400 이라, type 별 올바른 action 을 쓴다.
        const action = { LOCK_DOOR: { type, areaId: 'ROW_1_LEFT' }, REQUEST_FRESH_AIR: { type, fanLevel: 3 }, SET_CLIMATE_TARGET: { type, targetTempC: 20, areaId: 'ROW_1_LEFT' } }[type];
        const req = service.request(userPrincipal(), 'vehicle-1', dto({ executionMode: mode, action }));
        if (allowed) await expect(req).resolves.toMatchObject({ status: 'DISPATCHED' });
        else {
          const err = await expectApiError(req, 'UNSUPPORTED_CAPABILITY', 422);
          expect(err.details).toHaveProperty('allowlist');
        }
      });

      // 의도: 실차 제어 범위가 실수로 열리지 않았는지.
      it('REAL 모드의 allowlist 는 비어 있다', async () => {
        const err = await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto({ executionMode: 'REAL' })), 'UNSUPPORTED_CAPABILITY', 422);
        expect(err.details).toEqual({ allowlist: [] });
      });
    });

    // 의도: 운영에서 가짜 명령이 실제 이력처럼 남지 않게.
    it('1장. production 에서 MOCK 명령은 403', async () => {
      await inProduction(() => expectApiError(service.request(userPrincipal(), 'vehicle-1', dto({ executionMode: 'MOCK' })), 'FORBIDDEN', 403));
    });

    // 의도: 이미 만료된 명령은 받자마자 버려야 할 명령이다.
    it('3. expiresAt 이 이미 지났으면 400', async () => {
      await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto({ expiresAt: new Date(T0).toISOString() })), 'VALIDATION_FAILED', 400);
    });

    // [백엔드 추가] 오프라인 차량이 몇 시간 뒤 재접속해 옛 공조·잠금 명령을 실행하지 않게 상한 10분.
    it('3. expiresAt 이 10분보다 멀면 400', async () => {
      await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto({ expiresAt: new Date(T0 + 10 * 60_000 + 1).toISOString() })), 'VALIDATION_FAILED', 400);
      await expect(service.request(userPrincipal(), 'vehicle-1', dto({ expiresAt: new Date(T0 + 10 * 60_000).toISOString() }))).resolves.toMatchObject({ status: 'DISPATCHED' });
    });

    // [백엔드 추가] 정의되지 않은 필드가 저장되고 차량에 그대로 전달되지 않게.
    it('8.1-9. action 에 정의되지 않은 필드가 있으면 400', async () => {
      await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto({ action: { type: 'SET_CLIMATE_TARGET', targetTempC: 20, areaId: 'ROW_1_LEFT', extra: 1 } as never })), 'VALIDATION_FAILED', 400);
    });

    // 의도: 아직 검사 전이거나 이미 끝난 세션에 묶인 명령은 실행되면 안 된다.
    it.each(['PLANNED', 'STOPPED'])('4. sessionId 를 줬는데 세션이 %s 이면 422', async (status) => {
      access.assertSession.mockResolvedValue({ id: 's-1', status });
      await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto({ sessionId: 's-1' })), 'PRECONDITION_FAILED', 422);
    });

    // 의도: 검사 중(PREFLIGHT)이나 자는 중(ACTIVE) 세션의 명령은 허용.
    it.each(['ACTIVE', 'PREFLIGHT'])('4. 세션이 %s 이면 통과한다', async (status) => {
      access.assertSession.mockResolvedValue({ id: 's-1', status });
      await expect(service.request(userPrincipal(), 'vehicle-1', dto({ sessionId: 's-1' }))).resolves.toMatchObject({ status: 'DISPATCHED' });
    });

    // 의도: 받지 못할 명령을 쌓아두면 재연결 후 늦게 실행되는 위험이 있다.
    it('5. 차량이 OFFLINE 이면 422', async () => {
      vehicles.getState.mockResolvedValue({ revision: 5, connection: 'OFFLINE' });
      await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto()), 'PRECONDITION_FAILED', 422);
    });

    // 의도: 사용자가 본 상태와 지금 상태가 다르면, 그 상태를 기준으로 만든 명령은 맞지 않을 수 있다.
    // [백엔드 수정] 원래 "서버 값과 다르면(4 vs 5) 422" 였는데, 바로 아래 6번은 "클라이언트 5 / 서버 9 면 통과" 를 요구해 두 테스트가 동시에 통과할 수 없다.
    //   6번(데모 치명)을 따르고, 서버에 없는 미래 revision(클라이언트가 앞섬)만 거부한다. 실행 직전 안전 검사는 차량이 한다.
    it('5. expectedStateRevision 이 서버 값보다 앞서면 422', async () => {
      await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto({ expectedStateRevision: 6 })), 'PRECONDITION_FAILED', 422);
    });

    // 의도: 차량 기능이 바뀐 뒤 옛 기능 기준으로 만든 명령을 막는다.
    it('5. capabilityRevision 이 서버 값과 다르면 422', async () => {
      await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto({ capabilityRevision: 1 })), 'PRECONDITION_FAILED', 422);
    });

    // 의도: 센서가 5초마다 올리면 revision 이 계속 오른다. 정확히 같아야만 하면 자는 중에는 명령이 거의 다 실패한다.
    it('6. 센서가 계속 값을 올려 state revision 이 오른 취침 중에도 명령을 보낼 수 있다', async () => {
      vehicles.getState.mockResolvedValue({ revision: 9, connection: 'ONLINE' }); // 클라이언트가 본 5 이후 CO₂ 샘플 4번
      await expect(service.request(userPrincipal(), 'vehicle-1', dto({ expectedStateRevision: 5 }))).resolves.toMatchObject({ status: 'DISPATCHED' });
    });

    describe('7. 기능 지원·쓰기 권한', () => {
      // 의도: 차량이 못 하는 명령을 보내지 않는다.
      it('기능이 지원되지 않으면 422', async () => {
        vehicles.getCapabilities.mockResolvedValue({ revision: 2, features: [hvac({ supported: false })] });
        await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto()), 'UNSUPPORTED_CAPABILITY', 422);
      });

      // 의도: 지원 여부를 모르면 지원한다고 가정하지 않는다.
      it('기능 보고가 없으면 422', async () => {
        vehicles.getCapabilities.mockResolvedValue({ revision: 2, features: [] });
        await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto()), 'UNSUPPORTED_CAPABILITY', 422);
      });

      // 의도: 읽기만 허용된 기능을 제어하지 않는다.
      it('쓰기 권한이 없으면 422', async () => {
        vehicles.getCapabilities.mockResolvedValue({ revision: 2, features: [hvac({ writeAllowed: false })] });
        await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto()), 'UNSUPPORTED_CAPABILITY', 422);
      });

      // 의도: 데모에서 상태 흐름(QUEUED → DISPATCHED → …)을 시연할 수 있어야 한다.
      it('MOCK 은 기능 보고나 쓰기 권한이 없어도 통과한다', async () => {
        vehicles.getCapabilities.mockResolvedValue({ revision: 2, features: [] });
        await expect(service.request(userPrincipal(), 'vehicle-1', dto({ executionMode: 'MOCK', action: { type: 'LOCK_DOOR', areaId: 'ALL' } }))).resolves.toBeDefined();

        vehicles.getCapabilities.mockResolvedValue({ revision: 2, features: [hvac({ writeAllowed: false })] });
        await expect(service.request(userPrincipal(), 'vehicle-1', dto({ executionMode: 'MOCK' }))).resolves.toBeDefined();
      });

      // 의도: 명령과 기능의 매핑이 틀리면 다른 기능의 권한으로 명령이 통과한다.
      it('명령마다 필요한 기능이 다르다 (REQUEST_FRESH_AIR → hvac.recirculation)', async () => {
        vehicles.getCapabilities.mockResolvedValue({ revision: 2, features: [hvac()] });
        await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto({ action: { type: 'REQUEST_FRESH_AIR', fanLevel: 3 } })), 'UNSUPPORTED_CAPABILITY', 422);
      });
    });

    describe('8. SET_CLIMATE_TARGET 범위', () => {
      // 의도: 차량이 지원하지 않는 온도, 단위에 안 맞는 값, 없는 좌석을 서버에서 먼저 거른다.
      it.each([
        ['min 미만', 15.5, 'ROW_1_LEFT'],
        ['max 초과', 28.5, 'ROW_1_LEFT'],
        ['step 에 맞지 않음', 20.3, 'ROW_1_LEFT'],
        ['areas 에 없는 areaId', 20, 'ROW_2_RIGHT'],
      ])('%s 이면 400', async (_l, targetTempC, areaId) => {
        await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto({ action: { type: 'SET_CLIMATE_TARGET', targetTempC, areaId } })), 'VALIDATION_FAILED', 400);
      });

      // 의도: 경계값(min, max)과 step 배수는 정상 값이다.
      it.each([16, 28, 20.5])('경계값/step 에 맞는 %s 는 통과', async (targetTempC) => {
        await expect(service.request(userPrincipal(), 'vehicle-1', dto({ action: { type: 'SET_CLIMATE_TARGET', targetTempC, areaId: 'ROW_1_LEFT' } }))).resolves.toBeDefined();
      });
    });

    // 의도: 'abc' 는 숫자로 바꾸면 NaN 이고, NaN 은 모든 범위 비교가 false 라 min/max/step 검사를 그냥 통과한다.
    it("9. 명령별 필드 형식을 검사한다: targetTempC: 'abc' 는 400", async () => {
      await expectApiError(service.request(userPrincipal(), 'vehicle-1', dto({ action: { type: 'SET_CLIMATE_TARGET', targetTempC: 'abc', areaId: 'ROW_1_LEFT' } })), 'VALIDATION_FAILED', 400);
    });

    // 의도: payloadHash 와 commandId 로 차량이 같은 명령을 두 번 실행하지 않게 한다. 이벤트 순서: 전달 → 상태 변경.
    it('10. 통과하면 QUEUED 로 저장하고, COMMAND_DISPATCH 이벤트를 보내고, DISPATCHED 로 바꾼다', async () => {
      const res = await service.request(userPrincipal('user-1'), 'vehicle-1', dto());

      expect(res).toMatchObject({ commandId: 'cmd-1', status: 'DISPATCHED' });
      expect(prisma.command.create.mock.calls[0][0].data).toMatchObject({ vehicleId: 'vehicle-1', status: 'QUEUED', requestedBy: 'user-1', payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(prisma.commandAttempt.create).toHaveBeenCalledWith({ data: expect.objectContaining({ commandId: 'cmd-1', attemptNo: 0, phase: 'QUEUED' }) });
      const types = events.publish.mock.calls.map((c) => c[0].type);
      expect(types).toEqual(['COMMAND_DISPATCH', 'COMMAND_STATUS_CHANGED']);
      expect(prisma.command.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'cmd-1' }, data: expect.objectContaining({ status: 'DISPATCHED' }) }));
    });

    // 의도: 거부된 명령이 DB 에 남으면 만료 스윕이나 재전송에서 다시 다뤄질 수 있다.
    it('검사에 실패하면 명령을 저장하지 않는다', async () => {
      vehicles.getState.mockResolvedValue({ revision: 5, connection: 'OFFLINE' });
      await expect(service.request(userPrincipal(), 'vehicle-1', dto())).rejects.toBeDefined();
      expect(prisma.command.create).not.toHaveBeenCalled();
      expect(events.publish).not.toHaveBeenCalled();
    });
  });

  // ── 8.2 결과 보고 ────────────────────────────────────────────
  describe('8.2 결과 보고 result', () => {
    const cmd = (over = {}) => ({ id: 'cmd-1', vehicleId: 'vehicle-1', status: 'DISPATCHED', mode: 'PLEOS_EMULATOR', expiresAt: new Date(T0 + 30_000), ...over });

    // 의도: 다른 차량의 장치가 남의 명령 결과를 조작하지 못하게.
    it('1. 명령이 없으면 404, 그 차량의 자동차 장치가 아니면 접근 검사에서 404', async () => {
      prisma.command.findUnique.mockResolvedValue(null);
      await expectApiError(service.result(carPrincipal(), 'cmd-1', { status: 'ACCEPTED', attemptNo: 1 }), 'NOT_FOUND', 404);

      prisma.command.findUnique.mockResolvedValue(cmd());
      access.assertVehicle.mockRejectedValue(Object.assign(new Error(), { code: 'NOT_FOUND' }));
      await expect(service.result(carPrincipal('car-x'), 'cmd-1', { status: 'ACCEPTED', attemptNo: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(access.assertVehicle).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'car-x' }), 'vehicle-1');
    });

    // 의도: 정상 흐름: 전달 → 수락 → 확인 중 → 확인됨, 그리고 거부/미확인.
    it.each([
      ['DISPATCHED', 'ACCEPTED'], ['ACCEPTED', 'VERIFYING'], ['ACCEPTED', 'VERIFIED'], ['VERIFYING', 'VERIFIED'], ['DISPATCHED', 'REJECTED'], ['VERIFYING', 'UNCONFIRMED'],
    ])('2. 허용된 전이 %s → %s', async (from, to) => {
      prisma.command.findUnique.mockResolvedValue(cmd({ status: from }));
      await expect(service.result(carPrincipal(), 'cmd-1', { status: to, attemptNo: 2 })).resolves.toEqual({ commandId: 'cmd-1', status: to });
    });

    // 의도: 수락 없이 바로 확인됨, 수락 후 거부 같은 단계 건너뛰기는 기록을 믿을 수 없게 만든다.
    it.each([
      ['DISPATCHED', 'VERIFIED'], ['ACCEPTED', 'REJECTED'], ['QUEUED', 'ACCEPTED'],
    ])('2. 허용되지 않은 전이 %s → %s 는 422', async (from, to) => {
      prisma.command.findUnique.mockResolvedValue(cmd({ status: from }));
      await expectApiError(service.result(carPrincipal(), 'cmd-1', { status: to, attemptNo: 2 }), 'PRECONDITION_FAILED', 422);
    });

    // 의도: 차량이 응답을 못 받아 다시 보내도 attempt 와 이벤트가 중복으로 쌓이지 않게.
    it('3. 현재와 같은 상태를 다시 보고하면 duplicate: true 이고 기록을 남기지 않는다', async () => {
      prisma.command.findUnique.mockResolvedValue(cmd({ status: 'ACCEPTED' }));
      await expect(service.result(carPrincipal(), 'cmd-1', { status: 'ACCEPTED', attemptNo: 2 })).resolves.toEqual({ commandId: 'cmd-1', status: 'ACCEPTED', duplicate: true });
      expect(prisma.command.update).not.toHaveBeenCalled();
    });

    // 의도: 무엇이 언제 어떤 결과였는지 시도 기록이 남아야 실패 원인을 추적할 수 있다.
    it('4. 상태가 바뀌면 attempt 기록을 남기고 COMMAND_STATUS_CHANGED 이벤트를 보낸다', async () => {
      prisma.command.findUnique.mockResolvedValue(cmd({ status: 'ACCEPTED' }));
      await service.result(carPrincipal(), 'cmd-1', { status: 'VERIFIED', attemptNo: 2, observed: { cabinTempC: 20 } });

      expect(prisma.commandAttempt.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { commandId_attemptNo: { commandId: 'cmd-1', attemptNo: 2 } } }));
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'COMMAND_STATUS_CHANGED', payload: expect.objectContaining({ status: 'VERIFIED', observed: { cabinTempC: 20 } }) }));
    });

    // 의도: 끝난 명령이 다시 바뀌면 "실패했다"고 알린 명령이 나중에 "성공"으로 바뀌는 식의 혼란이 생긴다.
    it.each(['VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED', 'UNCONFIRMED'])('5. 종료 상태(%s)인 명령은 다른 상태로 바뀌지 않는다', async (terminal) => {
      prisma.command.findUnique.mockResolvedValue(cmd({ status: terminal }));
      const to = terminal === 'FAILED' ? 'VERIFIED' : 'FAILED';
      await expectApiError(service.result(carPrincipal(), 'cmd-1', { status: to, attemptNo: 3 }), 'PRECONDITION_FAILED', 422);
    });

    // 의도: 만료 후의 "수락"은 늦게 실행되는 중이라는 뜻이다. 이건 만료로 처리한다.
    it('6. 만료 후 도착한 결과는 VERIFIED/FAILED/REJECTED 가 아니면 EXPIRED 로 처리한다', async () => {
      prisma.command.findUnique.mockResolvedValue(cmd({ status: 'DISPATCHED', expiresAt: new Date(T0 - 1) }));
      await expect(service.result(carPrincipal(), 'cmd-1', { status: 'ACCEPTED', attemptNo: 2 })).resolves.toEqual({ commandId: 'cmd-1', status: 'EXPIRED' });
      expect(prisma.command.update.mock.calls[0][0].data.status).toBe('EXPIRED');
    });

    // 의도: 실제로 실행이 끝났다는 사실(확인/실패/거부)은 만료와 상관없이 기록해야 한다.
    it('6. 만료 후 도착해도 VERIFIED 결과는 전이 규칙대로 받는다', async () => {
      prisma.command.findUnique.mockResolvedValue(cmd({ status: 'ACCEPTED', expiresAt: new Date(T0 - 1) }));
      await expect(service.result(carPrincipal(), 'cmd-1', { status: 'VERIFIED', attemptNo: 2 })).resolves.toEqual({ commandId: 'cmd-1', status: 'VERIFIED' });
    });

    // 의도: 세션 종료로 취소된 명령이 만료 결과로 덮이면 "왜 안 됐는지"(취소)가 사라진다.
    it('6. 이미 끝난 상태(CANCELLED)인 명령은 만료 후 결과가 와도 EXPIRED 로 덮어쓰지 않는다', async () => {
      prisma.command.findUnique.mockResolvedValue(cmd({ status: 'CANCELLED', expiresAt: new Date(T0 - 1) }));
      await service.result(carPrincipal(), 'cmd-1', { status: 'ACCEPTED', attemptNo: 2 }).catch(() => undefined);
      expect(prisma.command.update).not.toHaveBeenCalled();
    });
  });

  // ── 8.3 만료 ─────────────────────────────────────────────────
  describe('8.3 만료 expireStale', () => {
    // 의도: 차량이 오래 끊겼다가 돌아와서 만료된 명령을 실행하지 않게, 서버가 먼저 만료시키고 알린다.
    it('1. 만료된 QUEUED, DISPATCHED 명령을 EXPIRED 로 바꾸고 알린다', async () => {
      prisma.command.findMany.mockResolvedValue([{ id: 'cmd-1' }, { id: 'cmd-2' }]);

      await service.expireStale();

      expect(prisma.command.findMany).toHaveBeenCalledWith({ where: { status: { in: ['QUEUED', 'DISPATCHED'] }, expiresAt: { lt: new Date(T0) } }, select: { id: true } });
      expect(prisma.command.update).toHaveBeenCalledTimes(2);
      expect(prisma.command.update.mock.calls.map((c) => c[0].data.status)).toEqual(['EXPIRED', 'EXPIRED']);
      expect(events.publish).toHaveBeenCalledTimes(2);
    });
  });

  // ── 8.4 명령 조회 ────────────────────────────────────────────
  describe('8.4 명령 조회 get', () => {
    // 의도: 폰에서 명령 진행 과정을 순서대로 보여준다.
    it('1. attempt 목록을 포함해 응답한다', async () => {
      prisma.command.findUnique.mockResolvedValue({ id: 'cmd-1', vehicleId: 'vehicle-1', status: 'ACCEPTED', attempts: [{ attemptNo: 0 }, { attemptNo: 1 }] });
      const res = await service.get(userPrincipal(), 'cmd-1');
      expect(res.attempts).toHaveLength(2);
      expect(prisma.command.findUnique).toHaveBeenCalledWith({ where: { id: 'cmd-1' }, include: { attempts: { orderBy: { attemptNo: 'asc' } } } });
    });

    // 의도: ACCEPTED 는 SDK 호출이 성공했다는 뜻일 뿐 실제로 바뀌었다는 뜻이 아니다. VERIFIED 만 "확인됨"이다.
    it.each([['VERIFIED', true], ['ACCEPTED', false], ['UNCONFIRMED', false]])('2. 상태가 %s 이면 verified=%s', async (status, verified) => {
      prisma.command.findUnique.mockResolvedValue({ id: 'cmd-1', vehicleId: 'vehicle-1', status, attempts: [] });
      await expect(service.get(userPrincipal(), 'cmd-1')).resolves.toMatchObject({ verified });
    });

    // 의도: 없는 명령 ID 조회.
    it('없는 명령이면 404', async () => {
      prisma.command.findUnique.mockResolvedValue(null);
      await expectApiError(service.get(userPrincipal(), 'cmd-1'), 'NOT_FOUND', 404);
    });
  });
});
