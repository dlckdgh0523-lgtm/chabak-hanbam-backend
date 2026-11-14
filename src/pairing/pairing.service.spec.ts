import { JwtService } from '@nestjs/jwt';
import { PairingService } from './pairing.service';
import { TokenService } from '../auth/token.service';
import { AccessService } from '../auth/access.service';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { carPrincipal, createAccessMock, createConfig, createEventsMock, createPrismaMock, expectApiError, PrismaMock, sensorPrincipal, userPrincipal } from '../testing/helpers';

// [이 파일의 의도]
// QR 페어링을 3단계(생성 → claim → confirm)로 나누는 이유:
// QR 만 찍으면 연결되면, 창문 너머로 QR 을 찍은 사람도 차량에 접근할 수 있다. 차량에서 직접 승인해야 연결된다.
describe('PairingService', () => {
  let prisma: PrismaMock;
  let tokens: TokenService;
  let access: ReturnType<typeof createAccessMock>;
  let events: ReturnType<typeof createEventsMock>;
  let service: PairingService;

  beforeEach(() => {
    prisma = createPrismaMock();
    tokens = new TokenService(new JwtService(), createConfig());
    access = createAccessMock();
    events = createEventsMock();
    service = new PairingService(prisma as unknown as PrismaService, tokens, access as unknown as AccessService, events as unknown as EventsService);
  });

  // ── 3.2.1 QR(챌린지) 생성 ─────────────────────────────────────
  describe('3.2.1 QR 생성 create', () => {
    // 의도: 센서/폰이 QR 을 만들 수 있으면, 다른 사람을 자기가 만든 페어링으로 유도할 수 있다.
    it('1. 자동차 장치가 아니면 403', async () => {
      await expectApiError(service.create(sensorPrincipal()), 'FORBIDDEN', 403);
      expect(prisma.pairingChallenge.create).not.toHaveBeenCalled();
    });

    // 의도: 짧은 유효기간: 사진 찍힌 QR 을 나중에 재사용할 수 있는 시간을 줄인다. secret 은 해시로만 저장한다.
    it('2. QR 은 120초 동안 유효하고, secret 원문은 qrPayload 에만 있고 서버는 해시만 저장한다', async () => {
      prisma.pairingChallenge.create.mockImplementation(async ({ data }) => ({ id: 'pair-1', ...data }));
      const before = Date.now();

      const res = await service.create(carPrincipal('car-1'));

      const payload = JSON.parse(res.qrPayload);
      expect(payload).toMatchObject({ v: 1, pairingId: 'pair-1', secret: expect.stringMatching(/^pair_/) });
      const saved = prisma.pairingChallenge.create.mock.calls[0][0].data;
      expect(saved).toMatchObject({ carDeviceId: 'car-1', vehicleId: 'vehicle-1', secretHash: tokens.hash(payload.secret) });
      expect(JSON.stringify(saved)).not.toContain(payload.secret);
      const ttl = saved.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThanOrEqual(120_000);
      expect(ttl).toBeLessThan(121_000);
    });
  });

  // ── 3.2.2 claim ──────────────────────────────────────────────
  describe('3.2.2 claim', () => {
    // 의도: 검사 조건을 where 에 넣어 UPDATE 한 번으로 처리해야 "확인 → 변경" 사이에 다른 요청이 끼어들 틈이 없다.
    it('1. secret 이 맞고 미만료·미claim·미사용일 때만 성공하고 PENDING_VEHICLE_CONFIRM 을 응답한다', async () => {
      prisma.pairingChallenge.updateMany.mockResolvedValue({ count: 1 });
      prisma.pairingChallenge.findUniqueOrThrow.mockResolvedValue({ id: 'pair-1', vehicleId: 'vehicle-1', expiresAt: new Date(Date.now() + 60_000) });

      const res = await service.claim(userPrincipal('user-1'), 'pair-1', 'pair_secret');

      expect(res.status).toBe('PENDING_VEHICLE_CONFIRM');
      // 조건을 where 절에 넣어 한 번의 UPDATE 로 처리해야 동시 요청에서도 안전하다
      expect(prisma.pairingChallenge.updateMany).toHaveBeenCalledWith({
        where: { id: 'pair-1', secretHash: tokens.hash('pair_secret'), claimedAt: null, usedAt: null, expiresAt: { gt: expect.any(Date) } },
        data: { claimedBy: 'user-1', claimedAt: expect.any(Date) },
      });
    });

    // 의도: 실패 이유(만료/이미 claim/secret 불일치)를 구분해 알려주지 않아 정보 노출을 줄인다.
    it('1. 조건에 맞는 챌린지가 없으면 (secret 불일치·만료·이미 claim/사용) 422', async () => {
      prisma.pairingChallenge.updateMany.mockResolvedValue({ count: 0 });
      await expectApiError(service.claim(userPrincipal(), 'pair-1', 'wrong'), 'PRECONDITION_FAILED', 422);
      expect(events.publish).not.toHaveBeenCalled();
    });

    // 의도: 같은 QR 을 여러 폰이 동시에 찍어도 차량 승인 대기에 올라가는 사람은 한 명이어야 한다.
    it('2. 동시에 여러 명이 스캔해도 한 명만 성공한다', async () => {
      // DB 의 조건부 UPDATE 를 흉내: 처음 한 번만 count 1
      let claimed = false;
      prisma.pairingChallenge.updateMany.mockImplementation(async () => {
        await Promise.resolve();
        if (claimed) return { count: 0 };
        claimed = true;
        return { count: 1 };
      });
      prisma.pairingChallenge.findUniqueOrThrow.mockResolvedValue({ id: 'pair-1', vehicleId: 'vehicle-1', expiresAt: new Date(Date.now() + 60_000) });

      const results = await Promise.allSettled([
        service.claim(userPrincipal('a'), 'pair-1', 's'),
        service.claim(userPrincipal('b'), 'pair-1', 's'),
        service.claim(userPrincipal('c'), 'pair-1', 's'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    });

    // 의도: 차량 화면에 "연결 요청이 왔다"를 띄워야 운전자가 승인할 수 있다.
    it('3. claim 에 성공하면 차량에 PAIRING_CLAIMED 이벤트를 보낸다', async () => {
      prisma.pairingChallenge.updateMany.mockResolvedValue({ count: 1 });
      prisma.pairingChallenge.findUniqueOrThrow.mockResolvedValue({ id: 'pair-1', vehicleId: 'vehicle-1', expiresAt: new Date() });

      await service.claim(userPrincipal(), 'pair-1', 's');

      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'PAIRING_CLAIMED', aggregateId: 'vehicle-1' }));
    });

    // 의도: claim 은 "요청"일 뿐이다. 이 단계에서 연결이 생기면 3단계로 나눈 의미가 없다.
    it('4. claim 만 한 사용자는 아직 연결(VehicleLink)이 생기지 않는다', async () => {
      prisma.pairingChallenge.updateMany.mockResolvedValue({ count: 1 });
      prisma.pairingChallenge.findUniqueOrThrow.mockResolvedValue({ id: 'pair-1', vehicleId: 'vehicle-1', expiresAt: new Date() });
      await service.claim(userPrincipal(), 'pair-1', 's');
      expect(prisma.vehicleLink.upsert).not.toHaveBeenCalled();
      expect(prisma.vehicleLink.create).not.toHaveBeenCalled();
    });
  });

  // ── 3.2.3 confirm ────────────────────────────────────────────
  describe('3.2.3 confirm', () => {
    const claimed = (over: Record<string, unknown> = {}) => ({
      id: 'pair-1', carDeviceId: 'car-1', vehicleId: 'vehicle-1', claimedBy: 'user-1', claimedAt: new Date(), usedAt: null, expiresAt: new Date(Date.now() + 60_000), ...over,
    });

    // 의도: 다른 차량의 차량 앱이 남의 claim 을 승인하지 못하게.
    it('1. QR 을 만든 장치가 아니면 404', async () => {
      prisma.pairingChallenge.findUnique.mockResolvedValue(claimed());
      await expectApiError(service.confirm(carPrincipal('car-2'), 'pair-1'), 'NOT_FOUND', 404);
    });

    // 의도: 없는 것과 남의 것을 같은 응답으로.
    it('1. 없는 챌린지면 404', async () => {
      prisma.pairingChallenge.findUnique.mockResolvedValue(null);
      await expectApiError(service.confirm(carPrincipal('car-1'), 'pair-1'), 'NOT_FOUND', 404);
    });

    // 의도: claim 전 승인, 같은 QR 두 번 승인, 만료 후 승인을 모두 막는다.
    it.each([
      ['claim 이전', { claimedBy: null, claimedAt: null }],
      ['이미 사용된 경우', { usedAt: new Date() }],
      ['만료된 경우', { expiresAt: new Date(Date.now() - 1) }],
    ])('1. %s 422', async (_label, over) => {
      prisma.pairingChallenge.findUnique.mockResolvedValue(claimed(over));
      await expectApiError(service.confirm(carPrincipal('car-1'), 'pair-1'), 'PRECONDITION_FAILED', 422);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // 의도: QR 을 사용 처리해야 같은 QR 로 두 번 연결되지 않는다. 예전에 해제했던 연결은 새로 만들지 않고 ACTIVE 로 되살린다.
    it('2. 성공하면 OWNER 연결이 ACTIVE 가 되고 QR 은 사용 처리된다', async () => {
      prisma.pairingChallenge.findUnique.mockResolvedValue(claimed());
      prisma.vehicleLink.upsert.mockResolvedValue({ id: 'link-1' });

      const res = await service.confirm(carPrincipal('car-1'), 'pair-1');

      expect(res).toEqual({ linkId: 'link-1', vehicleId: 'vehicle-1', userId: 'user-1', status: 'ACTIVE' });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.pairingChallenge.update).toHaveBeenCalledWith({ where: { id: 'pair-1' }, data: { confirmedAt: expect.any(Date), usedAt: expect.any(Date) } });
      expect(prisma.vehicleLink.upsert.mock.calls[0][0].create).toMatchObject({ userId: 'user-1', vehicleId: 'vehicle-1', deviceId: 'car-1', role: 'OWNER', status: 'ACTIVE' });
      // 예전에 REVOKED 된 연결이면 다시 ACTIVE 로
      expect(prisma.vehicleLink.upsert.mock.calls[0][0].update).toEqual({ status: 'ACTIVE', revokedAt: null });
    });

    // 의도: 폰 앱이 "연결 완료" 화면으로 넘어가는 신호.
    it('3. LINK_HEALTH_CHANGED 이벤트를 보낸다', async () => {
      prisma.pairingChallenge.findUnique.mockResolvedValue(claimed());
      prisma.vehicleLink.upsert.mockResolvedValue({ id: 'link-1' });
      await service.confirm(carPrincipal('car-1'), 'pair-1');
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'LINK_HEALTH_CHANGED', aggregateId: 'vehicle-1', payload: { linkId: 'link-1', status: 'ACTIVE' } }));
    });
  });

  // ── 3.3 연결 해제 ────────────────────────────────────────────
  describe('3.3 연결 해제 revokeLink', () => {
    // 의도: 연결만 끊고 토큰이 살아 있으면, 해제된 차량 앱이 계속 서버에 접근한다.
    it('1. 연결을 REVOKED 로 바꾸고 장치 토큰을 폐기한다', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-1', userId: 'user-1', deviceId: 'car-1', vehicleId: 'vehicle-1' });

      await service.revokeLink(userPrincipal('user-1'), 'link-1');

      expect(prisma.vehicleLink.update).toHaveBeenCalledWith({ where: { id: 'link-1' }, data: { status: 'REVOKED', revokedAt: expect.any(Date) } });
      expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 'car-1' }, data: { revokedAt: expect.any(Date), tokenHash: null } });
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'LINK_HEALTH_CHANGED', payload: { linkId: 'link-1', status: 'REVOKED' } }));
    });

    // 의도: 남의 연결을 끊어 차량 감시를 멈추게 하는 것을 막는다.
    it('2. 본인의 연결이 아니면 404', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue(null);
      await expectApiError(service.revokeLink(userPrincipal('user-1'), 'link-1'), 'NOT_FOUND', 404);
      expect(prisma.vehicleLink.findFirst).toHaveBeenCalledWith({ where: { id: 'link-1', userId: 'user-1' } });
    });
  });
});
