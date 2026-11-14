import { TripsService } from './trips.service';
import { AccessService } from '../auth/access.service';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { carPrincipal, createAccessMock, createEventsMock, createPrismaMock, expectApiError, PrismaMock, userPrincipal } from '../testing/helpers';

const place = { id: 'place-1', name: '파주 캠핑장', lat: 37.7, lng: 126.7, campingStatus: 'ALLOWED', cookingStatus: 'UNKNOWN' };
const tripRow = (over: Record<string, unknown> = {}) => ({
  id: 'trip-1', userId: 'user-1', vehicleId: 'vehicle-1', placeId: 'place-1', version: 1, status: 'PLANNED',
  startAt: new Date('2026-11-20T10:00:00Z'), endAt: new Date('2026-11-21T01:00:00Z'), timezone: 'Asia/Seoul', people: 2, place, syncs: [], ...over,
});

// [이 파일의 의도]
// 예약은 폰에서 만들고 차량이 내려받아 확인(sync-ack)한다. 버전으로 폰과 차량이 서로의 수정을 덮어쓰지 않게 한다.
describe('TripsService', () => {
  let prisma: PrismaMock;
  let access: ReturnType<typeof createAccessMock>;
  let events: ReturnType<typeof createEventsMock>;
  let service: TripsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    access = createAccessMock();
    events = createEventsMock();
    service = new TripsService(prisma as unknown as PrismaService, access as unknown as AccessService, events as unknown as EventsService);
    prisma.trip.findUniqueOrThrow.mockResolvedValue(tripRow());
  });

  // ── 6.1 예약 생성 ────────────────────────────────────────────
  describe('6.1 예약 생성 create', () => {
    const dto = { vehicleId: 'vehicle-1', placeId: 'place-1', startAt: '2026-11-20T10:00:00Z', endAt: '2026-11-21T01:00:00Z', timezone: 'Asia/Seoul', people: 2 };

    // 의도: 남의 차량에 예약을 넣으면 그 차량 앱에 모르는 일정이 동기화된다.
    it('1. 사용자가 접근할 수 없는 차량이면 404', async () => {
      access.assertVehicle.mockRejectedValue(Object.assign(new Error(), { code: 'NOT_FOUND' }));
      await expect(service.create(userPrincipal(), dto)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(prisma.trip.create).not.toHaveBeenCalled();
    });

    // 의도: 없는 장소로 예약하면 브리핑·대체 장소 기능이 깨진다.
    it('1. 장소가 없으면 404', async () => {
      prisma.place.findUnique.mockResolvedValue(null);
      await expectApiError(service.create(userPrincipal(), dto), 'NOT_FOUND', 404);
    });

    // 의도: 끝나는 시간이 시작보다 앞이면 목록 필터(종료 후 6시간)와 요약 계산이 틀어진다.
    it.each([
      ['같으면', '2026-11-20T10:00:00Z'],
      ['앞이면', '2026-11-20T09:00:00Z'],
    ])('3. endAt 이 startAt 과 %s 400', async (_l, endAt) => {
      prisma.place.findUnique.mockResolvedValue(place);
      await expectApiError(service.create(userPrincipal(), { ...dto, endAt }), 'VALIDATION_FAILED', 400);
    });

    // 의도: 차량이 새 예약(새 버전)을 내려받아야 한다는 신호.
    it('4. 생성하면 차량에 TRIP_SYNCED(stage SERVER_SAVED) 이벤트를 보낸다', async () => {
      prisma.place.findUnique.mockResolvedValue(place);
      prisma.trip.create.mockResolvedValue(tripRow());

      const res = await service.create(userPrincipal('user-1'), dto);

      expect(prisma.trip.create.mock.calls[0][0].data).toMatchObject({ userId: 'user-1', vehicleId: 'vehicle-1', placeId: 'place-1', people: 2 });
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'TRIP_SYNCED', aggregateId: 'vehicle-1', payload: expect.objectContaining({ stage: 'SERVER_SAVED' }) }));
      expect(res).toMatchObject({ id: 'trip-1', version: 1 });
    });
  });

  // ── 6.2 예약 수정, 취소 ──────────────────────────────────────
  describe('6.2 예약 수정, 취소 patch', () => {
    beforeEach(() => {
      access.assertTrip.mockResolvedValue(tripRow());
    });

    // 의도: 폰과 차량이 동시에 수정하면 나중 저장이 앞의 수정을 모르고 덮어쓴다(낙관적 락).
    it('1. expectedVersion 이 같을 때만 수정되고 버전이 1 오른다', async () => {
      prisma.trip.updateMany.mockResolvedValue({ count: 1 });
      prisma.trip.findUniqueOrThrow.mockResolvedValue(tripRow({ version: 2, people: 3 }));

      const res = await service.patch(userPrincipal(), 'trip-1', { expectedVersion: 1, people: 3 });

      expect(prisma.trip.updateMany).toHaveBeenCalledWith({ where: { id: 'trip-1', version: 1 }, data: expect.objectContaining({ people: 3, version: { increment: 1 } }) });
      expect(res.version).toBe(2);
    });

    // 의도: 충돌을 알려서 클라이언트가 최신 값을 다시 받아 수정하게 한다. 이벤트도 보내지 않는다.
    it('1. 버전이 다르면 409', async () => {
      prisma.trip.updateMany.mockResolvedValue({ count: 0 });
      await expectApiError(service.patch(userPrincipal(), 'trip-1', { expectedVersion: 1 }), 'VERSION_CONFLICT', 409);
      expect(events.publish).not.toHaveBeenCalled();
    });

    // 의도: 사용자가 바꿀 수 있는 상태는 취소뿐이다(나머지는 DTO 에서 막는다).
    it('2. 상태를 CANCELLED 로 바꿀 수 있다', async () => {
      prisma.trip.updateMany.mockResolvedValue({ count: 1 });
      await service.patch(userPrincipal(), 'trip-1', { expectedVersion: 1, status: 'CANCELLED' });
      expect(prisma.trip.updateMany.mock.calls[0][0].data.status).toBe('CANCELLED');
    });

    // 의도: 차량이 가진 예약이 낡았다는 신호.
    it('3. 수정하면 TRIP_SYNCED(stage SERVER_SAVED) 이벤트를 보낸다', async () => {
      prisma.trip.updateMany.mockResolvedValue({ count: 1 });
      prisma.trip.findUniqueOrThrow.mockResolvedValue(tripRow({ version: 2 }));
      await service.patch(userPrincipal(), 'trip-1', { expectedVersion: 1 });
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'TRIP_SYNCED', revision: 2, payload: expect.objectContaining({ stage: 'SERVER_SAVED', version: 2 }) }));
    });

    // 의도: 남의 예약을 수정/취소하지 못하게.
    it('남의 예약이면 404', async () => {
      access.assertTrip.mockRejectedValue(Object.assign(new Error(), { code: 'NOT_FOUND' }));
      await expect(service.patch(userPrincipal(), 'trip-1', { expectedVersion: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // 노션 6.2-4 (확인 필요: 현재는 둘 다 검사하지 않음)
    // 의도: 생성 때만 검사하고 수정에서 빠지면, 수정으로 같은 잘못된 데이터를 만들 수 있다.
    it('4. 수정할 때도 endAt 은 startAt 보다 뒤여야 한다', async () => {
      prisma.trip.updateMany.mockResolvedValue({ count: 1 });
      await expectApiError(service.patch(userPrincipal(), 'trip-1', { expectedVersion: 1, endAt: '2026-11-19T00:00:00Z' }), 'VALIDATION_FAILED', 400);
    });

    // 의도: 취소 후 수정이 되면 취소된 예약이 차량에 다시 동기화되어 되살아난 것처럼 보인다.
    it('4. 취소된 예약은 더 수정할 수 없다', async () => {
      access.assertTrip.mockResolvedValue(tripRow({ status: 'CANCELLED' }));
      prisma.trip.updateMany.mockResolvedValue({ count: 1 });
      await expectApiError(service.patch(userPrincipal(), 'trip-1', { expectedVersion: 1, people: 3 }), 'PRECONDITION_FAILED', 422);
    });
  });

  // ── 6.3 예약 조회, 목록 ──────────────────────────────────────
  describe('6.3.1 예약 단건 조회 get', () => {
    beforeEach(() => access.assertTrip.mockResolvedValue(tripRow()));

    // 의도: 폰에서 "차량이 최신 예약을 가지고 있는지"를 보여준다. STALE 이면 차량에 옛날 일정이 있다는 뜻이다.
    it.each([
      ['동기화 기록이 없으면 NOT_SYNCED', 3, [], 'NOT_SYNCED'],
      ['적용 버전이 같으면 SYNCED', 3, [{ deviceId: 'car-1', appliedVersion: 3 }], 'SYNCED'],
      ['적용 버전이 낮으면 STALE(vN)', 3, [{ deviceId: 'car-1', appliedVersion: 2 }], 'STALE(v2)'],
    ])('1. %s', async (_l, version, syncs, expected) => {
      prisma.trip.findUniqueOrThrow.mockResolvedValue(tripRow({ version, syncs }));
      const res = await service.get(userPrincipal(), 'trip-1');
      expect(res.sync).toEqual({ server: 'SAVED', vehicle: expected });
    });
  });

  describe('6.3.2 다가오는 예약 목록 upcoming', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z') });
    });
    afterEach(() => jest.useRealTimers());

    // 의도: 막 끝난 예약도 아침 요약이나 후기 작성을 위해 6시간 동안 보여준다.
    it('1. PLANNED·ACTIVE 이고 종료 후 6시간이 지나지 않은 예약을 시작 시각 순으로 20개씩 조회한다', async () => {
      prisma.trip.findMany.mockResolvedValue([]);
      await service.upcoming(userPrincipal(), 'vehicle-1');

      const q = prisma.trip.findMany.mock.calls[0][0];
      expect(q.where).toMatchObject({ vehicleId: 'vehicle-1', status: { in: ['PLANNED', 'ACTIVE'] }, endAt: { gte: new Date('2026-11-13T06:00:00Z') } });
      expect(q.orderBy).toEqual([{ startAt: 'asc' }, { id: 'asc' }]);
      expect(q.take).toBe(21); // 다음 페이지 확인용으로 1개 더
    });

    // 의도: 다음 페이지가 있는지 알기 위해 하나 더 조회한다.
    it('1. 21개가 오면 20개만 응답하고 nextCursor 를 준다', async () => {
      const rows = Array.from({ length: 21 }, (_, i) => tripRow({ id: `t-${String(i).padStart(2, '0')}` }));
      prisma.trip.findMany.mockResolvedValue(rows);
      const res = await service.upcoming(userPrincipal(), 'vehicle-1');
      expect(res.trips).toHaveLength(20);
      expect(res.nextCursor).toBe('t-19');
    });

    // 의도: 장치마다 어디까지 받았는지 보여준다.
    it('2. 장치별 동기화 버전도 함께 응답한다', async () => {
      prisma.trip.findMany.mockResolvedValue([tripRow({ syncs: [{ deviceId: 'car-1', appliedVersion: 1 }] })]);
      const res = await service.upcoming(userPrincipal(), 'vehicle-1');
      expect(res.trips[0].syncedVersions).toEqual({ 'car-1': 1 });
      expect(res.nextCursor).toBeNull();
    });

    // 노션 6.3.2-3: 정렬은 startAt 인데 커서는 id 로 자른다
    // 의도: 정렬은 startAt 인데 커서는 id 로 자르면, 다음 페이지에 이미 본 예약이 다시 나오거나 일부가 빠진다.
    //       id 순서와 startAt 순서가 반대인 데이터로 전체 페이지를 넘겨 확인한다.
    it('3. 페이지를 넘겨도 순서가 일관되고 빠지거나 중복되는 예약이 없다', async () => {
      // id 순서와 startAt 순서가 반대인 예약 25개
      const all = Array.from({ length: 25 }, (_, i) =>
        tripRow({ id: `t-${String(i).padStart(2, '0')}`, startAt: new Date(Date.UTC(2026, 11, 30 - i)) }),
      );
      // [백엔드 수정] Prisma 커서 의미(정렬한 뒤 cursor 행부터, skip 만큼 건너뜀)를 흉내 낸다.
      //   원래 mock 은 where.id.gt 만 이해해서, 정렬 키로 자르는 cursor+skip 구현을 표현하지 못했다.
      prisma.trip.findMany.mockImplementation(async ({ where, take, cursor, skip = 0 }) => {
        const sorted = all
          .filter((t) => !where.id || (t.id as string) > where.id.gt)
          .sort((a, b) => (a.startAt as Date).getTime() - (b.startAt as Date).getTime() || (a.id as string).localeCompare(b.id as string));
        const from = cursor ? sorted.findIndex((t) => t.id === cursor.id) : 0;
        return sorted.slice(from + skip, from + skip + take);
      });

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const page = await service.upcoming(userPrincipal(), 'vehicle-1', cursor);
        seen.push(...page.trips.map((t) => t.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
    });
  });

  // ── 6.4 차량 동기화 확인 ─────────────────────────────────────
  describe('6.4 차량 동기화 확인 syncAck', () => {
    beforeEach(() => access.assertTrip.mockResolvedValue(tripRow({ version: 3 })));

    // 의도: 서버에 없는 버전을 적용했다고 하면 버그나 위조다.
    it('2. 적용 버전이 서버 버전보다 크면 400', async () => {
      await expectApiError(service.syncAck(carPrincipal(), 'trip-1', 4), 'VALIDATION_FAILED', 400);
      expect(prisma.tripSync.upsert).not.toHaveBeenCalled();
    });

    // 의도: 차량이 최신 예약을 저장했다는 확인.
    it('2. 같으면 VEHICLE_SYNCED', async () => {
      await expect(service.syncAck(carPrincipal('car-1'), 'trip-1', 3)).resolves.toMatchObject({ stage: 'VEHICLE_SYNCED', serverVersion: 3 });
      expect(prisma.tripSync.upsert.mock.calls[0][0].where).toEqual({ tripId_deviceId: { tripId: 'trip-1', deviceId: 'car-1' } });
    });

    // 의도: 차량이 저장한 사이에 폰에서 다시 수정된 경우. 폰이 "차량에 아직 반영 안 됨"을 보여줄 수 있다.
    it('2. 작으면 VEHICLE_STALE', async () => {
      await expect(service.syncAck(carPrincipal(), 'trip-1', 2)).resolves.toMatchObject({ stage: 'VEHICLE_STALE' });
    });

    // 의도: 폰 화면이 동기화 상태를 실시간으로 갱신한다.
    it('동기화 결과를 TRIP_SYNCED 이벤트로 알린다', async () => {
      await service.syncAck(carPrincipal('car-1'), 'trip-1', 3);
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'TRIP_SYNCED', sourceDeviceId: 'car-1', payload: expect.objectContaining({ stage: 'VEHICLE_SYNCED' }) }));
    });
  });
});
