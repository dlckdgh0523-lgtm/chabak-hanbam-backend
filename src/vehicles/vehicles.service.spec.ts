import { VehiclesService } from './vehicles.service';
import { AccessService } from '../auth/access.service';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { Observation } from '../common/freshness';
import { TelemetrySampleDto } from './vehicles.dto';
import {
  carPrincipal, createAccessMock, createConfig, createEventsMock, createPrismaMock, expectApiError, inProduction, P2002, PrismaMock, sensorPrincipal, userPrincipal,
} from '../testing/helpers';

const T0 = new Date('2026-11-13T00:00:00.000Z').getTime();
const iso = (offsetMs = 0) => new Date(T0 + offsetMs).toISOString();

const sample = (over: Partial<TelemetrySampleDto> = {}): TelemetrySampleDto => ({
  metric: 'co2Ppm', value: 800, unit: 'ppm', source: 'BLE_SENSOR', observedAt: iso(), seq: 1, bootId: 'boot-1', ...over,
});

const obs = (value: unknown, observedAt = iso(), over: Partial<Observation> = {}): Observation => ({
  value, unit: 'x', source: 'BLE_SENSOR', sourceDeviceId: 'd', observedAt, receivedAt: observedAt, quality: 'VALID', seq: 1, bootId: 'b', ...over,
});

// [이 파일의 의도]
// 차량 상태: 원본 샘플은 모두 저장하고, metric 별 최신값은 상태 캐시에 둔다.
// 캐시의 revision 은 preflight 와 차량 명령이 "사용자가 본 상태"와 "지금 상태"를 비교하는 기준이다.
describe('VehiclesService', () => {
  let prisma: PrismaMock;
  let access: ReturnType<typeof createAccessMock>;
  let events: ReturnType<typeof createEventsMock>;
  let service: VehiclesService;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    prisma = createPrismaMock();
    access = createAccessMock();
    events = createEventsMock();
    service = new VehiclesService(prisma as unknown as PrismaService, access as unknown as AccessService, events as unknown as EventsService, createConfig());
  });
  afterEach(() => jest.useRealTimers());

  // ── 5.1 기능 보고, 조회 ──────────────────────────────────────
  describe('5.1.1 기능 보고 reportCapabilities', () => {
    const dto = { sdkVersion: '1.0', permissions: ['hvac'], features: [{ feature: 'hvac.temperature', supported: true, readAllowed: true, writeAllowed: true, areas: [] }], observedAt: iso(), executionMode: 'PLEOS_EMULATOR' as const };

    // 의도: 기능 보고는 차량 SDK 가 알려주는 값이다. 폰이 보고할 수 있으면 지원하지 않는 기능을 지원한다고 속일 수 있다.
    it('1. 자동차 장치가 아니면 403', async () => {
      await expectApiError(service.reportCapabilities(sensorPrincipal(), 'vehicle-1', dto as never), 'FORBIDDEN', 403);
    });

    // 의도: 다른 차량의 기능 정보를 바꾸지 못하게.
    it('2. 자동차 장치에 연결된 차량이 아니면 404', async () => {
      access.vehicleIdForCarDevice.mockResolvedValue('vehicle-2');
      await expectApiError(service.reportCapabilities(carPrincipal(), 'vehicle-1', dto as never), 'NOT_FOUND', 404);
    });

    // 의도: 명령 요청 시 capabilityRevision 을 비교한다. 기능이 바뀐 뒤 옛 기능 기준으로 만든 명령이 실행되지 않게.
    it('3. 가장 최근 보고의 revision 에 1을 더한 새 보고를 만든다', async () => {
      prisma.capabilityReport.findFirst.mockResolvedValue({ revision: 4 });
      await expect(service.reportCapabilities(carPrincipal('car-1'), 'vehicle-1', dto as never)).resolves.toEqual({ revision: 5 });
      expect(prisma.capabilityReport.create.mock.calls[0][0].data).toMatchObject({ vehicleId: 'vehicle-1', deviceId: 'car-1', revision: 5, features: dto.features });
    });

    // 의도: revision 0 은 "보고 없음"을 뜻한다(조회 테스트 참고).
    it('3. 첫 보고면 revision 1 이다', async () => {
      prisma.capabilityReport.findFirst.mockResolvedValue(null);
      await expect(service.reportCapabilities(carPrincipal(), 'vehicle-1', dto as never)).resolves.toEqual({ revision: 1 });
    });

    // 의도: 폰 앱이 버튼 활성/비활성을 다시 그리는 신호.
    it('4. 보고 후 CAPABILITIES_UPDATED 이벤트를 보낸다', async () => {
      prisma.capabilityReport.findFirst.mockResolvedValue(null);
      await service.reportCapabilities(carPrincipal(), 'vehicle-1', dto as never);
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'CAPABILITIES_UPDATED', aggregateId: 'vehicle-1', revision: 1 }));
    });

    // 의도: 운영에서 가짜 값이 실제처럼 섞이면 안전 판단이 가짜 값에 기대게 된다.
    it('1장. production 에서 MOCK 보고는 403', async () => {
      await inProduction(() => expectApiError(service.reportCapabilities(carPrincipal(), 'vehicle-1', { ...dto, executionMode: 'MOCK' } as never), 'FORBIDDEN', 403));
    });
  });

  describe('5.1.2 기능 조회 getCapabilities', () => {
    // 의도: 남의 차량이 어떤 기능을 지원하는지도 노출하지 않는다.
    it('1. 차량 접근 권한이 없으면 404', async () => {
      access.assertVehicle.mockRejectedValue(Object.assign(new Error(), { code: 'NOT_FOUND' }));
      await expect(service.getCapabilities(userPrincipal(), 'vehicle-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // 의도: 과거 보고가 아니라 최신 보고 기준으로 판단해야 한다.
    it('2. 가장 최근 보고를 응답한다', async () => {
      prisma.capabilityReport.findFirst.mockResolvedValue({ revision: 3, features: [{ feature: 'door.lock' }], permissions: [], sdkVersion: '1' });
      await expect(service.getCapabilities(userPrincipal(), 'vehicle-1')).resolves.toMatchObject({ revision: 3, features: [{ feature: 'door.lock' }] });
      expect(prisma.capabilityReport.findFirst).toHaveBeenCalledWith({ where: { vehicleId: 'vehicle-1' }, orderBy: { revision: 'desc' } });
    });

    // 의도: 차량 앱이 아직 보고 전이어도 에러 대신 "없음"을 명확히 알려준다.
    it('2. 보고가 없으면 revision 0 과 빈 features 를 응답한다', async () => {
      prisma.capabilityReport.findFirst.mockResolvedValue(null);
      await expect(service.getCapabilities(userPrincipal(), 'vehicle-1')).resolves.toMatchObject({ revision: 0, features: [] });
    });
  });

  // ── 5.2 텔레메트리 업로드 ────────────────────────────────────
  describe('5.2 텔레메트리 업로드 ingestTelemetry', () => {
    let cache: { vehicleId: string; metrics: Record<string, Observation>; revision: number };

    beforeEach(() => {
      cache = { vehicleId: 'vehicle-1', metrics: {}, revision: 0 };
      prisma.telemetrySample.create.mockResolvedValue({});
      prisma.vehicleStateCache.upsert.mockImplementation(async () => {
        await Promise.resolve(); // DB 왕복
        return JSON.parse(JSON.stringify(cache));
      });
      prisma.vehicleStateCache.update.mockImplementation(async ({ data }) => {
        await Promise.resolve();
        cache = { ...cache, ...data };
      });
    });

    // 의도: 연결되지 않은 장치가 남의 차량에 값을 넣지 못하게.
    it('1. 차량 접근 검사에 실패하면 404 이고 저장하지 않는다', async () => {
      access.assertVehicle.mockRejectedValue(Object.assign(new Error(), { code: 'NOT_FOUND' }));
      await expect(service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', { samples: [sample()] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(prisma.telemetrySample.create).not.toHaveBeenCalled();
    });

    // 의도: 다른 차량의 세션에 값이 섞이면 그 세션의 경보와 아침 요약이 오염된다.
    it('2. sessionId 가 해당 차량의 세션이 아니면 400', async () => {
      prisma.sleepSession.findFirst.mockResolvedValue(null);
      await expectApiError(service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', { sessionId: 's-other', samples: [sample()] }), 'VALIDATION_FAILED', 400);
      expect(prisma.sleepSession.findFirst).toHaveBeenCalledWith({ where: { id: 's-other', vehicleId: 'vehicle-1' }, select: { id: true } });
    });

    // 의도: 운영 데이터에 가짜 측정값이 섞이지 않게.
    it('3. production 에서 MOCK 출처 샘플은 403', async () => {
      await inProduction(() => expectApiError(service.ingestTelemetry(carPrincipal(), 'vehicle-1', { samples: [sample({ source: 'MOCK' })] }), 'FORBIDDEN', 403));
    });

    // 의도: 데모/에뮬레이터 환경에서는 MOCK 으로 시연해야 한다.
    it('3. production 이 아니면 MOCK 출처 샘플을 받는다', async () => {
      await expect(service.ingestTelemetry(carPrincipal(), 'vehicle-1', { samples: [sample({ source: 'MOCK' })] })).resolves.toMatchObject({ accepted: 1 });
    });

    // 의도: PLEOS 는 차량 SDK 가 읽은 값이다. 폰이 PLEOS 라고 표시해 올리면 차량 실측값으로 위장된다.
    it('4. 샘플 출처가 PLEOS 인데 자동차 장치가 아니면 403', async () => {
      await expectApiError(service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', { samples: [sample({ source: 'PLEOS' })] }), 'FORBIDDEN', 403);
      await expect(service.ingestTelemetry(carPrincipal(), 'vehicle-1', { samples: [sample({ source: 'PLEOS' })] })).resolves.toMatchObject({ accepted: 1 });
    });

    // 의도: 네트워크 재전송으로 같은 묶음이 다시 와도 한 번만 반영한다. 중복이 캐시와 경보를 다시 건드리면 안 된다.
    it('5. 같은 (장치, bootId, seq, metric) 조합은 중복으로 세고 상태 캐시에 반영하지 않는다', async () => {
      prisma.telemetrySample.create.mockResolvedValueOnce({}).mockRejectedValueOnce(P2002);

      const res = await service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', {
        samples: [sample({ metric: 'co2Ppm', seq: 1 }), sample({ metric: 'coPpm', seq: 1, value: 5 })],
      });

      expect(res).toEqual({ accepted: 1, duplicates: 1, lastSeq: 1 });
      expect(Object.keys(cache.metrics)).toEqual(['co2Ppm']);
    });

    // 의도: 다른 오류까지 "중복"으로 삼키면 데이터가 유실되어도 아무도 모른다.
    it('5. 중복이 아닌 DB 오류는 그대로 던진다', async () => {
      prisma.telemetrySample.create.mockRejectedValue(new Error('db down'));
      await expect(service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', { samples: [sample()] })).rejects.toThrow('db down');
    });

    // 의도: 바뀐 게 없는데 revision 이 오르면 preflight/명령의 revision 비교가 이유 없이 실패한다.
    it('5. 묶음이 전부 중복이면 캐시와 revision 을 바꾸지 않고 이벤트도 보내지 않는다', async () => {
      prisma.telemetrySample.create.mockRejectedValue(P2002);
      await service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', { samples: [sample()] });
      expect(prisma.vehicleStateCache.update).not.toHaveBeenCalled();
      expect(events.publish).not.toHaveBeenCalled();
    });

    // 의도: 0 은 정상 측정값(CO 0ppm)이다. 결측은 null 뿐이다. 0 을 결측으로 보면 정상 상태를 "모름"으로 판단한다.
    it.each([
      ['값이 null', null, 'UNKNOWN'],
      ['값이 0 (0은 결측이 아니다)', 0, 'VALID'],
      ['값이 있음', 800, 'VALID'],
    ])('6. quality 를 주지 않고 %s 이면 %s 로 저장한다', async (_l, value, expected) => {
      await service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', { samples: [sample({ value: value as number | null })] });
      expect(prisma.telemetrySample.create.mock.calls[0][0].data.quality).toBe(expected);
    });

    // 의도: 센서가 스스로 INVALID 라고 판단한 값은 서버가 VALID 로 바꾸지 않는다.
    it('6. quality 를 주면 그 값을 쓴다', async () => {
      await service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', { samples: [sample({ quality: 'INVALID' })] });
      expect(prisma.telemetrySample.create.mock.calls[0][0].data.quality).toBe('INVALID');
    });

    // 의도: 오프라인 동안 쌓아둔 값이 나중에 올라오는 경우. 과거 값이 최신값을 덮으면 이미 올라간 CO₂ 가 낮게 보인다.
    it('7. 늦게 도착한 과거 값은 캐시의 최신값을 덮어쓰지 않는다', async () => {
      cache.metrics = { co2Ppm: obs(1500, iso(10_000)) };
      await service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', { samples: [sample({ value: 700, observedAt: iso(5_000) })] });
      expect(cache.metrics.co2Ppm.value).toBe(1500);
    });

    // 의도: 묶음 안 순서가 시간순이 아닐 수 있다. 배열 순서가 아니라 관측 시각으로 판단한다.
    it('7. 한 묶음 안에서도 같은 metric 은 관측 시각이 가장 늦은 값만 반영한다', async () => {
      await service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', {
        samples: [sample({ value: 900, observedAt: iso(2_000), seq: 2 }), sample({ value: 800, observedAt: iso(1_000), seq: 1 })],
      });
      expect(cache.metrics.co2Ppm.value).toBe(900);
    });

    // 의도: 캐시 갱신은 metric 단위 병합이다. 센서가 CO₂ 만 올렸는데 차량 온도가 지워지면 안 된다.
    it('7. 새 값은 반영하고, 다른 metric 은 그대로 둔다', async () => {
      cache.metrics = { cabinTempC: obs(18, iso()) };
      await service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', { samples: [sample({ value: 2300, observedAt: iso(1_000) })] });
      expect(cache.metrics.co2Ppm.value).toBe(2300);
      expect(cache.metrics.cabinTempC.value).toBe(18);
    });

    // 의도: STATE_SNAPSHOT 으로 폰 화면이 갱신되고, 내부 telemetry 이벤트로 경보 서비스가 값을 평가한다.
    it('8. 캐시에 반영하면 revision 이 1 오르고 STATE_SNAPSHOT 이벤트를 보낸다', async () => {
      cache.revision = 10;
      await service.ingestTelemetry(sensorPrincipal('sensor-1'), 'vehicle-1', { samples: [sample()] });

      expect(cache.revision).toBe(11);
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'STATE_SNAPSHOT', aggregateId: 'vehicle-1', revision: 11, sourceDeviceId: 'sensor-1' }));
      // 경보 서비스로 내부 이벤트 전달
      expect(events.bus.emit).toHaveBeenCalledWith('telemetry', expect.objectContaining({ vehicleId: 'vehicle-1', deviceId: 'sensor-1' }));
    });

    // 의도: 클라이언트가 어디까지 보냈는지 알고 다음 전송을 이어간다.
    it('응답의 lastSeq 는 묶음의 가장 큰 seq 다', async () => {
      const res = await service.ingestTelemetry(sensorPrincipal(), 'vehicle-1', { samples: [sample({ seq: 3 }), sample({ seq: 7, metric: 'coPpm' }), sample({ seq: 5, metric: 'cabinTempC' })] });
      expect(res.lastSeq).toBe(7);
    });

    // 의도: 캐시를 "읽기 → 수정 → 전체 저장"할 때 락/트랜잭션이 없으면 나중에 저장한 쪽이 앞의 값을 지운다.
    //       CO₂ 2300 이 지워지고 800 이 남으면 preflight 가 안전하다고 판단한다. 두 업로드가 겹치게 만들어 확인한다.
    it('9. 차량과 센서가 동시에 올려도 서로의 metric 값이 유실되지 않고 revision 이 두 번 오른다', async () => {
      cache = { vehicleId: 'vehicle-1', metrics: { cabinTempC: obs(18.0, iso()), co2Ppm: obs(800, iso()) }, revision: 10 };

      await Promise.all([
        service.ingestTelemetry(carPrincipal('car-1'), 'vehicle-1', { samples: [sample({ metric: 'cabinTempC', value: 18.5, unit: 'C', source: 'PLEOS', observedAt: iso(1_000) })] }),
        service.ingestTelemetry(sensorPrincipal('sensor-1'), 'vehicle-1', { samples: [sample({ metric: 'co2Ppm', value: 2300, observedAt: iso(1_000) })] }),
      ]);

      expect(cache.metrics.cabinTempC.value).toBe(18.5);
      expect(cache.metrics.co2Ppm.value).toBe(2300);
      expect(cache.revision).toBe(12);
    });
  });

  // ── 5.3 heartbeat ────────────────────────────────────────────
  describe('5.3 heartbeat', () => {
    // 의도: 다른 차량의 온라인 상태를 바꾸지 못하게.
    it('1. 차량 접근 검사에 실패하면 404', async () => {
      access.assertVehicle.mockRejectedValue(Object.assign(new Error(), { code: 'NOT_FOUND' }));
      await expect(service.heartbeat(carPrincipal(), 'vehicle-1', { executionMode: 'PLEOS_EMULATOR' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // 의도: 폰이 차량 연결 상태를 실시간으로 보여주고, 차량은 서버 시각으로 시계 차이를 보정한다.
    it('2. LINK_HEALTH_CHANGED 이벤트를 보내고 서버 시각을 응답한다', async () => {
      const res = await service.heartbeat(carPrincipal('car-1'), 'vehicle-1', { executionMode: 'PLEOS_EMULATOR', powerState: 'PARKED' });
      expect(res).toEqual({ ok: true, serverTime: iso() });
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'LINK_HEALTH_CHANGED', aggregateId: 'vehicle-1', payload: { vehicle: 'ONLINE', powerState: 'PARKED' } }));
    });

    // 의도: heartbeat 가 남긴 값을 상태 조회에서 보여줘야 사용자가 어떤 모드로 돌고 있는지 안다.
    it('2. 기록한 executionMode 와 powerState 가 상태 조회에 나온다', async () => {
      prisma.vehicleStateCache.findUnique.mockResolvedValue(null);
      prisma.vehicleLink.findFirst.mockResolvedValue(null);
      await service.heartbeat(carPrincipal(), 'vehicle-1', { executionMode: 'PLEOS_EMULATOR', powerState: 'PARKED' });
      await expect(service.getState(userPrincipal(), 'vehicle-1')).resolves.toMatchObject({ executionMode: 'PLEOS_EMULATOR', powerState: 'PARKED' });
    });

    // 의도: 운영에서 MOCK 차량이 ONLINE 으로 보이면 안 된다.
    it('1장. production 에서 MOCK heartbeat 는 403', async () => {
      await inProduction(() => expectApiError(service.heartbeat(carPrincipal(), 'vehicle-1', { executionMode: 'MOCK' }), 'FORBIDDEN', 403));
    });
  });

  // ── 5.4 상태 조회 ────────────────────────────────────────────
  describe('5.4 상태 조회 getState', () => {
    beforeEach(() => {
      prisma.vehicleStateCache.findUnique.mockResolvedValue({ vehicleId: 'vehicle-1', revision: 7, metrics: {} });
      prisma.vehicleLink.findFirst.mockResolvedValue(null);
    });

    // 의도: heartbeat 는 10초 주기라 두 번 놓쳐도 ONLINE 이다. 30초 정각은 ONLINE 으로 포함한다.
    it('1. 마지막 heartbeat 가 30초 이내면 ONLINE', async () => {
      await service.heartbeat(carPrincipal(), 'vehicle-1', { executionMode: 'PLEOS_EMULATOR' });
      jest.setSystemTime(T0 + 30_000);
      await expect(service.getState(userPrincipal(), 'vehicle-1')).resolves.toMatchObject({ connection: 'ONLINE', revision: 7 });
    });

    // 의도: OFFLINE 이면 preflight 가 막히고 명령이 거부된다. 차량이 받지 못할 명령을 보내지 않기 위해서다.
    it('1. 마지막 heartbeat 가 30초를 넘으면 OFFLINE', async () => {
      await service.heartbeat(carPrincipal(), 'vehicle-1', { executionMode: 'PLEOS_EMULATOR' });
      jest.setSystemTime(T0 + 30_001);
      await expect(service.getState(userPrincipal(), 'vehicle-1')).resolves.toMatchObject({ connection: 'OFFLINE' });
    });

    // 의도: heartbeat 는 메모리에만 있어 서버가 재시작하면 사라진다. 차량 앱의 다른 요청(lastSeenAt)도 살아 있다는 근거로 쓴다.
    it('1. heartbeat 가 없어도 자동차 장치 활동(lastSeenAt)이 30초 이내면 ONLINE', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue({ device: { lastSeenAt: new Date(T0 - 10_000) } });
      await expect(service.getState(userPrincipal(), 'vehicle-1')).resolves.toMatchObject({ connection: 'ONLINE', lastSeenAt: iso(-10_000) });
    });

    // 의도: 모르면 ONLINE 이라고 가정하지 않는다.
    it('1. 기록이 하나도 없으면 OFFLINE 이고 lastSeenAt 은 null', async () => {
      await expect(service.getState(userPrincipal(), 'vehicle-1')).resolves.toMatchObject({ connection: 'OFFLINE', lastSeenAt: null });
    });

    // 의도: 환경마다 네트워크 특성이 달라 설정으로 바꿀 수 있어야 한다.
    it('1. 기준 시간은 VEHICLE_OFFLINE_AFTER_MS 로 바꿀 수 있다', async () => {
      service = new VehiclesService(prisma as unknown as PrismaService, access as unknown as AccessService, events as unknown as EventsService, createConfig({ VEHICLE_OFFLINE_AFTER_MS: '5000' }));
      await service.heartbeat(carPrincipal(), 'vehicle-1', { executionMode: 'PLEOS_EMULATOR' });
      jest.setSystemTime(T0 + 6_000);
      await expect(service.getState(userPrincipal(), 'vehicle-1')).resolves.toMatchObject({ connection: 'OFFLINE' });
    });

    // 의도: 오래된 값을 현재 값처럼 보여주면 사용자가 "지금 안전하다"고 오해한다.
    it('2. OFFLINE 이면 값이 마지막으로 받은 값임을 응답에 표시하고, ONLINE 이면 표시하지 않는다', async () => {
      const offline = await service.getState(userPrincipal(), 'vehicle-1');
      expect(offline.note).toContain('마지막 수신값');

      await service.heartbeat(carPrincipal(), 'vehicle-1', { executionMode: 'PLEOS_EMULATOR' });
      const online = await service.getState(userPrincipal(), 'vehicle-1');
      expect(online.note).toBeUndefined();
    });

    // 의도: 오래된 값으로 경보 해제나 자동 제어를 판단하면 안 된다. 15초 정각은 아직 VALID.
    it('3. 15초 지난 metric 은 STALE, null 이면 UNKNOWN, 최근 값은 VALID', async () => {
      prisma.vehicleStateCache.findUnique.mockResolvedValue({
        vehicleId: 'vehicle-1', revision: 1,
        metrics: { co2Ppm: obs(800, iso(-15_001)), coPpm: obs(null, iso()), cabinTempC: obs(18, iso(-15_000)) },
      });
      const { metrics } = await service.getState(userPrincipal(), 'vehicle-1');
      expect(metrics.co2Ppm.quality).toBe('STALE');
      expect(metrics.coPpm.quality).toBe('UNKNOWN');
      expect(metrics.cabinTempC.quality).toBe('VALID');
    });

    // 의도: 외기 모드 ON 이나 팬 단계가 실제 환기량을 보장하지 않는다. 서버가 "환기됨"이라고 추정하지 않는다.
    it('4. effectiveVentilation 은 항상 UNKNOWN 이고, 외기 순환·팬 값은 VALID 일 때만 보여준다', async () => {
      prisma.vehicleStateCache.findUnique.mockResolvedValue({
        vehicleId: 'vehicle-1', revision: 1,
        metrics: { 'recirculation.state': obs('FRESH', iso()), 'fan.level': obs(3, iso(-20_000)) },
      });
      const { derived } = await service.getState(userPrincipal(), 'vehicle-1');
      expect(derived).toEqual({ effectiveVentilation: 'UNKNOWN', ventilationObserved: { recirculation: 'FRESH', fan: null } });
    });

    // 의도: 캐시가 아직 없어도 에러 없이 빈 상태로 응답한다.
    it('상태 캐시가 없으면 revision 0, 빈 metrics', async () => {
      prisma.vehicleStateCache.findUnique.mockResolvedValue(null);
      await expect(service.getState(userPrincipal(), 'vehicle-1')).resolves.toMatchObject({ revision: 0, metrics: {} });
    });
  });
});
