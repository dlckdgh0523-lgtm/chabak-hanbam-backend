import { ContentService } from './content.service';
import { AccessService } from '../auth/access.service';
import { PrismaService } from '../prisma/prisma.service';
import { PLACE_FIXTURES } from './fixtures';
import { ApiError } from '../common/errors';
import { createAccessMock, createPrismaMock, expectApiError, P2002, PrismaMock, userPrincipal } from '../testing/helpers';

const T0 = new Date('2026-11-13T03:00:00.000Z').getTime();

// 위도 0.1° ≈ 11.1km → 시속 40km 로 약 16.7분
const place = (id: string, lat: number, over: Record<string, unknown> = {}) => ({
  id, providerId: `fx-${id}`, name: `장소 ${id}`, lat, lng: 0, campingStatus: 'ALLOWED', cookingStatus: 'ALLOWED', meta: {}, sourceUrl: null, verifiedAt: null, ...over,
});

// [이 파일의 의도]
// 콘텐츠(장소, 기상, 일출, 전력, 후기)는 지금 DEMO fixture 다. 실제 데이터로 오인되지 않게 출처를 표시한다.
// 허가 상태 UNKNOWN 은 허용으로 보지 않는다(단속·과태료 위험).
describe('ContentService', () => {
  let prisma: PrismaMock;
  let access: ReturnType<typeof createAccessMock>;
  let service: ContentService;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    prisma = createPrismaMock();
    access = createAccessMock();
    service = new ContentService(prisma as unknown as PrismaService, access as unknown as AccessService);
  });
  afterEach(() => jest.useRealTimers());

  // ── 11.1 장소 검색 ───────────────────────────────────────────
  describe('11.1 장소 검색 search', () => {
    // 의도: 재시작할 때마다 덮어쓰면 그동안 바뀐 장소 데이터가 사라진다. 없을 때만 넣는다.
    it('1. 서버가 시작할 때 DEMO 장소 5곳을 넣고, 이미 있으면 그대로 둔다', async () => {
      await service.onModuleInit();
      expect(prisma.place.upsert).toHaveBeenCalledTimes(5);
      for (const [arg] of prisma.place.upsert.mock.calls) expect(arg.update).toEqual({});
      expect(prisma.place.upsert.mock.calls.map((c) => c[0].where.providerId)).toEqual(PLACE_FIXTURES.map((f) => f.providerId));
    });

    // 의도: "파주"만 입력해도 찾을 수 있게. 다음 페이지가 있는지 알려고 하나 더 조회한다.
    it('2. 이름 부분 일치(대소문자 무시)로 검색하고 20개씩 응답한다', async () => {
      prisma.place.findMany.mockResolvedValue(Array.from({ length: 21 }, (_, i) => place(`p${String(i).padStart(2, '0')}`, 0)));

      const res = await service.search('파주');

      expect(prisma.place.findMany).toHaveBeenCalledWith({ where: { name: { contains: '파주', mode: 'insensitive' } }, orderBy: { id: 'asc' }, take: 21 });
      expect(res.places).toHaveLength(20);
      expect(res.nextCursor).toBe('p19');
    });

    // 의도: 현재 위치에서 가까운 곳부터 보여준다.
    it('3. lat, lng 를 주면 거리(km)를 계산해 가까운 순으로 정렬한다', async () => {
      prisma.place.findMany.mockResolvedValue([place('far', 1), place('near', 0.1), place('mid', 0.5)]);
      const res = await service.search(undefined, 0, 0);
      expect(res.places.map((p) => p.id)).toEqual(['near', 'mid', 'far']);
      expect(res.places[0].distanceKm).toBeCloseTo(11.12, 1);
    });

    // 의도: 위치를 모르면 거리를 0 으로 꾸며내지 않는다.
    it('3. 좌표가 없으면 distanceKm 는 null 이다', async () => {
      prisma.place.findMany.mockResolvedValue([place('a', 0)]);
      expect((await service.search()).places[0].distanceKm).toBeNull();
    });
  });

  // ── 11.2 장소 브리핑 ─────────────────────────────────────────
  describe('11.2 장소 브리핑 briefing', () => {
    // 의도: 없는 장소 ID.
    it('2. 없는 장소면 404', async () => {
      prisma.place.findUnique.mockResolvedValue(null);
      await expectApiError(service.briefing('nope'), 'NOT_FOUND', 404);
    });

    // 의도: 비공개(PRIVATE) 후기는 브리핑에 나오면 안 된다. DEMO 후기는 출처를 붙여 실제 후기와 구분한다.
    it('1. 허가 상태, 공개 사용자 후기와 DEMO 후기(출처 표시), 기상, 일출, 불확실성 목록을 응답한다', async () => {
      prisma.place.findUnique.mockResolvedValue(place('p2', 37.78, { providerId: 'fx-002', campingStatus: 'CONDITIONAL' }));
      prisma.review.findMany.mockResolvedValue([{ rating: 5, text: '좋아요', createdAt: new Date() }]);

      const res = await service.briefing('p2');

      expect(prisma.review.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { placeId: 'p2', visibility: 'PUBLIC' } }));
      expect(res.permits).toMatchObject({ camping: 'CONDITIONAL', source: 'UNVERIFIED' });
      expect(res.reviews.items.map((r) => r.source)).toEqual(['USER', 'DEMO', 'DEMO']);
      expect(res.weather.provider).toBe('fixture');
      expect(res.sun.sunriseAt).toEqual(expect.any(String));
      expect(res.uncertainty.length).toBeGreaterThan(0);
    });
  });

  // ── 11.3 대체 장소 ───────────────────────────────────────────
  describe('11.3 대체 장소 alternatives', () => {
    beforeEach(() => prisma.place.findUnique.mockResolvedValue(place('origin', 0)));

    // 의도: 없는 장소 ID.
    it('없는 장소면 404', async () => {
      prisma.place.findUnique.mockResolvedValue(null);
      await expectApiError(service.alternatives('nope', [], [], 30), 'NOT_FOUND', 404);
    });

    // 의도: 너무 먼 곳은 대안이 아니다. 왜 빠졌는지 사유를 같이 준다.
    it('1. 추가 이동 시간(시속 40km 가정)이 maxExtraMin 을 넘으면 사유와 함께 제외한다', async () => {
      prisma.place.findMany.mockResolvedValue([place('17min', 0.1), place('50min', 0.3)]);
      const res = await service.alternatives('origin', [], [], 30);
      expect(res.candidates.map((c) => c.id)).toEqual(['17min']);
      expect(res.rejected).toEqual([{ id: '50min', name: '장소 50min', reason: expect.stringMatching(/^추가 50분 > 30/) }]);
      expect(prisma.place.findMany).toHaveBeenCalledWith({ where: { id: { not: 'origin' } } });
    });

    // 의도: "모름"을 "허용"으로 추천하면 사용자가 단속에 걸릴 수 있다. 조건부(CONDITIONAL)도 필수 조건은 통과 못 한다.
    it('2. 필수 조건은 ALLOWED 만 통과하고 UNKNOWN 은 제외한다', async () => {
      prisma.place.findMany.mockResolvedValue([
        place('ok', 0.1),
        place('unknownCamp', 0.1, { campingStatus: 'UNKNOWN' }),
        place('condCook', 0.1, { cookingStatus: 'CONDITIONAL' }),
      ]);
      const res = await service.alternatives('origin', [], ['camping', 'cooking'], 30);
      expect(res.candidates.map((c) => c.id)).toEqual(['ok']);
      expect(res.rejected.map((r) => r.reason)).toEqual(['camping=UNKNOWN', 'cooking=CONDITIONAL']);
    });

    // 의도: 정렬은 우선순위일 뿐 후보를 빼지 않는다(필터와 분리).
    it('4. rank 순서에 가중치를 주어 정렬하고, 정렬은 필터와 별개다', async () => {
      prisma.place.findMany.mockResolvedValue([
        place('none', 0.1, { meta: {} }),
        place('evOnly', 0.1, { meta: { ev: true } }),
        place('toiletOnly', 0.1, { meta: { toilet: true } }),
        place('both', 0.1, { meta: { toilet: true, ev: true } }),
      ]);
      const res = await service.alternatives('origin', ['toilet', 'ev'], [], 30);
      expect(res.candidates.map((c) => [c.id, c.score])).toEqual([['both', 3], ['toiletOnly', 2], ['evOnly', 1], ['none', 0]]);
      expect(res.rejected).toEqual([]);
    });

    // 의도: 후보가 없다고 조건을 몰래 완화해 엉뚱한 곳을 추천하지 않는다.
    it('5. 후보가 0개여도 그대로 응답한다', async () => {
      prisma.place.findMany.mockResolvedValue([place('far', 1)]);
      const res = await service.alternatives('origin', [], [], 30);
      expect(res.candidates).toEqual([]);
      expect(res.note).toBeDefined();
    });
  });

  // ── 11.4 기상, 일출 ──────────────────────────────────────────
  describe('11.4 기상, 일출', () => {
    // 의도: 잘못된 입력으로 엉뚱한 날짜·위치 결과를 주지 않는다.
    it.each([
      ['날짜 형식이 틀림', 37.7, 126.7, '2026/11/13'],
      ['lat 이 숫자가 아님', NaN, 126.7, '2026-11-13'],
      ['lng 가 숫자가 아님', 37.7, NaN, '2026-11-13'],
    ])('1. 밤 기상·일출 모두 %s 이면 400', (_l, lat, lng, date) => {
      expect(() => service.weatherNight(lat, lng, date, 'Asia/Seoul')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
      expect(() => service.sun(lat, lng, date, 'Asia/Seoul')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    });

    // 의도: 근사식 오차(±2분)를 감안해 실제 일출과 5분 이내인지 본다.
    it('2. 일출 시각은 NOAA 근사식으로 계산한다 (파주 11/14 일출 ≈ 07:13 KST, ±5분)', () => {
      const res = service.sun(37.78, 126.78, '2026-11-14', 'Asia/Seoul');
      const kst = new Date(res.sunriseAt as string).getTime() + 9 * 3600_000;
      const minutes = new Date(kst).getUTCHours() * 60 + new Date(kst).getUTCMinutes();
      expect(Math.abs(minutes - (7 * 60 + 13))).toBeLessThanOrEqual(5);
      expect(res.azimuthDeg).toBeGreaterThan(90); // 겨울엔 남동쪽에서 뜬다
    });

    // 의도: 계산이 안 되는 날에 이상한 시각을 만들어내지 않는다.
    it('3. 일출이 없는 날(극지방)은 null 이다', () => {
      expect(service.sun(80, 0, '2026-12-21', 'UTC')).toMatchObject({ sunriseAt: null, azimuthDeg: null });
    });
  });

  // ── 11.5 전력 계획 ───────────────────────────────────────────
  describe('11.5 전력 계획 powerPlan', () => {
    // 8시간, 목표 20℃ / 외기 5℃ → 예상 5.2~10.4kWh, 예비량 = 50km*0.22 + 77.4*10% = 18.74kWh
    const dto = { vehicleId: 'vehicle-1', nightHours: 8, people: 2, targetTempC: 20, outsideTempC: 5, returnDistanceKm: 50 };
    const soc = (value: number | null, quality = 'VALID') => ({ metrics: { evSocPct: { value, quality } } });

    beforeEach(() => {
      prisma.powerPlan.create.mockImplementation(async ({ data }) => ({ id: 'pp-1', ...data }));
    });

    // 의도: 남의 차량 배터리 상태로 계산하지 못하게.
    it('1. 차량에 접근할 수 있어야 한다', async () => {
      access.assertVehicle.mockRejectedValue(Object.assign(new Error(), { code: 'NOT_FOUND' }));
      await expect(service.powerPlan(userPrincipal(), dto)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // 의도: 추정치는 가정에 따라 크게 달라지므로 가정값을 모두 보여준다. 예상값은 범위(최소~최대)로 준다.
    it('2·3. 배터리 용량 기본 77.4kWh, 예상 사용량(최소~최대)·예비량·가정값을 응답에 담는다', async () => {
      prisma.vehicleStateCache.findUnique.mockResolvedValue(soc(60));
      const res = await service.powerPlan(userPrincipal(), dto);
      expect(res).toMatchObject({ estimateMinKwh: 5.2, estimateMaxKwh: 10.4, reserveKwh: 18.74, socPct: 60, availableKwh: 27.7 });
      expect(res.assumptions).toMatchObject({ batteryKwh: 77.4, returnKwhPerKm: 0.22, reservePct: 10 });
    });

    // 의도: 예비량(귀가 + 10%)을 뺀 사용 가능량을 예상 범위와 비교한 결론.
    it.each([
      ['쓸 수 있는 양이 최대 예상 이상', 60, 'OK'],
      ['최소 예상 이상', 35, 'MARGINAL'],
      ['그 외', 30, 'INSUFFICIENT'],
    ])('4. %s 이면 %s', async (_l, pct, verdict) => {
      prisma.vehicleStateCache.findUnique.mockResolvedValue(soc(pct));
      await expect(service.powerPlan(userPrincipal(), dto)).resolves.toMatchObject({ verdict });
    });

    // 의도: 배터리를 모르면 "충분하다"고 하지 않는다. 오래된 SOC 도 모르는 것으로 본다.
    it('4·5. SOC 를 모르면 SOC_UNVERIFIED, 신뢰도 LOW', async () => {
      prisma.vehicleStateCache.findUnique.mockResolvedValue(soc(60, 'STALE'));
      await expect(service.powerPlan(userPrincipal(), dto)).resolves.toMatchObject({ verdict: 'SOC_UNVERIFIED', socPct: null, confidence: 'LOW' });
    });

    // 의도: 추정은 시간이 지나면 의미가 없어지므로 유효시간을 둔다.
    it('5. SOC 가 있으면 신뢰도 MEDIUM 이고 6시간 동안 유효하다', async () => {
      prisma.vehicleStateCache.findUnique.mockResolvedValue(soc(60));
      const res = await service.powerPlan(userPrincipal(), dto);
      expect(res.confidence).toBe('MEDIUM');
      expect((res.expiresAt as Date).getTime()).toBe(T0 + 6 * 3600_000);
    });

    // 의도: 난방을 안 쓰는 사람에게 난방 전력까지 더해 겁주지 않는다.
    it('난방을 안 하면(targetTempC 없음) 대기 전력만 계산한다', async () => {
      prisma.vehicleStateCache.findUnique.mockResolvedValue(null);
      const { targetTempC: _t, ...noHeat } = dto;
      await expect(service.powerPlan(userPrincipal(), noHeat)).resolves.toMatchObject({ estimateMinKwh: 1.6, estimateMaxKwh: 3.2 });
    });
  });

  // ── 11.6 후기 ────────────────────────────────────────────────
  describe('11.6 후기', () => {
    // 의도: 가보지 않은 장소에 후기를 쓰지 못하게.
    it('1. 본인 예약에만 쓸 수 있다', async () => {
      access.assertTrip.mockRejectedValue(Object.assign(new Error(), { code: 'NOT_FOUND' }));
      await expect(service.createReview(userPrincipal(), { tripId: 'trip-1', rating: 5, text: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    // 의도: 차박 후기에는 어디서 언제 잤는지가 담긴다. 자동 공개하면 안전 문제가 생긴다.
    it('1. 기본 공개 범위는 PRIVATE 다 (서비스가 visibility 를 정하지 않아 DB 기본값 PRIVATE 가 쓰인다)', async () => {
      access.assertTrip.mockResolvedValue({ id: 'trip-1', placeId: 'place-1' });
      await service.createReview(userPrincipal('user-1'), { tripId: 'trip-1', rating: 5, text: '좋아요' });
      const data = prisma.review.create.mock.calls[0][0].data;
      expect(data).toEqual({ userId: 'user-1', tripId: 'trip-1', placeId: 'place-1', rating: 5, text: '좋아요' });
      expect(data.visibility).toBeUndefined();
    });

    // 의도: DB 오류(500)가 그대로 나가면 클라이언트는 서버 장애인지 중복인지 구분할 수 없다.
    it('1. 예약당 하나다: 두 번째 후기는 1장 에러 형식(ApiError, 4xx)으로 거부한다 — DB 오류(500)가 그대로 나가면 안 된다', async () => {
      access.assertTrip.mockResolvedValue({ id: 'trip-1', placeId: 'place-1' });
      prisma.review.findFirst.mockResolvedValue({ id: 'r-1', tripId: 'trip-1' });
      prisma.review.findUnique.mockResolvedValue({ id: 'r-1', tripId: 'trip-1' });
      prisma.review.create.mockRejectedValue(P2002); // tripId @unique

      const err = await service.createReview(userPrincipal(), { tripId: 'trip-1', rating: 5, text: 'x' }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).getStatus()).toBeGreaterThanOrEqual(400);
      expect((err as ApiError).getStatus()).toBeLessThan(500);
    });

    // 의도: 두 기기에서 동시에 수정할 때 덮어쓰기 방지.
    it('2. 본인 후기이고 expectedVersion 이 맞을 때만 수정되며 버전이 1 오른다', async () => {
      prisma.review.updateMany.mockResolvedValue({ count: 1 });
      prisma.review.findUniqueOrThrow.mockResolvedValue({ id: 'r-1', version: 2 });
      await expect(service.patchReview(userPrincipal('user-1'), 'r-1', { text: '수정', expectedVersion: 1 })).resolves.toMatchObject({ version: 2 });
      expect(prisma.review.updateMany).toHaveBeenCalledWith({ where: { id: 'r-1', userId: 'user-1', version: 1 }, data: { text: '수정', version: { increment: 1 } } });
    });

    // 의도: 남의 후기를 수정할 수 없다.
    it('2. 버전이 다르거나 남의 후기면 409', async () => {
      prisma.review.updateMany.mockResolvedValue({ count: 0 });
      await expectApiError(service.patchReview(userPrincipal(), 'r-1', { text: 'x', expectedVersion: 1 }), 'VERSION_CONFLICT', 409);
    });
  });
});
