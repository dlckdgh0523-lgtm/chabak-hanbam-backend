import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { createConfig, createPrismaMock, expectApiError, PrismaMock } from '../testing/helpers';
import { PrismaService } from '../prisma/prisma.service';

// [이 파일의 의도]
// 인증 서비스: 로그인, refresh 토큰 회전, 차량 등록(enroll).
// 토큰 "원문"은 응답에 한 번만 나가고 서버는 해시만 저장한다는 원칙을 여러 테스트에서 같이 확인한다.
describe('AuthService', () => {
  let prisma: PrismaMock;
  let tokens: TokenService;

  const build = (env: Record<string, string | undefined> = { DEV_LOGIN_ENABLED: 'true' }) => {
    const cfg = createConfig(env);
    tokens = new TokenService(new JwtService(), cfg);
    return new AuthService(prisma as unknown as PrismaService, tokens, cfg);
  };

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  // ── 2.1 로그인 POST /v1/auth/sessions ─────────────────────────
  describe('2.1 로그인 createSession', () => {
    // 의도: 데모용 로그인. access 토큰(짧은 TTL)과 refresh 토큰이 같이 나와야 앱이 만료 후 다시 로그인하지 않고 갱신할 수 있다.
    //       refresh 원문을 DB 에 저장하면 DB 유출만으로 남의 세션을 이어갈 수 있으므로 해시만 저장하는지도 본다.
    it('1. provider: DEV 로그인 시 accessToken 과 refreshToken 을 발급한다', async () => {
      const service = build();
      prisma.user.upsert.mockResolvedValue({ id: 'user-1' });
      prisma.refreshToken.create.mockResolvedValue({});

      const res = await service.createSession({ provider: 'DEV', credential: 'alice' } as never);

      expect(res.userId).toBe('user-1');
      expect(tokens.verifyUserAccess(res.accessToken)).toMatchObject({ sub: 'user-1', scope: 'user' });
      expect(res.refreshToken).toMatch(/^rft_/);
      expect(prisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { authSubject: 'dev:alice' } }));
      // 서버는 refresh 토큰 원문이 아니라 해시만 저장한다 (2.3.4)
      const saved = prisma.refreshToken.create.mock.calls[0][0].data;
      expect(saved.tokenHash).toBe(tokens.hash(res.refreshToken));
      expect(JSON.stringify(saved)).not.toContain(res.refreshToken);
    });

    // 의도: DEV 로그인은 credential 문자열만으로 아무 계정이나 될 수 있다. 운영에서 열리면 누구나 다른 사람으로 로그인한다.
    it('2. production 환경이면 DEV 로그인은 403', async () => {
      const service = build({ NODE_ENV: 'production', DEV_LOGIN_ENABLED: 'true' });
      await expectApiError(service.createSession({ provider: 'DEV', credential: 'a' } as never), 'FORBIDDEN', 403);
      expect(prisma.user.upsert).not.toHaveBeenCalled();
    });

    // 의도: 설정 실수('TRUE', '1')로 DEV 로그인이 열리지 않게, 정확히 'true' 일 때만 허용하는지 본다.
    it.each([undefined, 'false', 'TRUE', '1'])('2. DEV_LOGIN_ENABLED=%p 이면 (정확히 "true" 가 아니면) 403', async (flag) => {
      const service = build({ DEV_LOGIN_ENABLED: flag });
      await expectApiError(service.createSession({ provider: 'DEV', credential: 'a' } as never), 'FORBIDDEN', 403);
    });
  });

  // ── 2.2 토큰 갱신 POST /v1/auth/refresh ───────────────────────
  describe('2.2 토큰 갱신 refresh', () => {
    const future = () => new Date(Date.now() + 60_000);

    // 의도: refresh 토큰 회전: 쓴 토큰은 usedAt 으로 표시해야 나중에 같은 토큰이 다시 오면 "재사용"을 알아챌 수 있다.
    //       새 토큰도 같은 familyId 로 묶어야, 재사용이 감지됐을 때 그 계열 전체를 끊을 수 있다.
    it('1. 유효한 refresh 토큰이면 새 accessToken·refreshToken 을 발급하고, 사용한 토큰은 usedAt 을 기록한다', async () => {
      const service = build();
      prisma.refreshToken.findUnique.mockResolvedValue({ id: 'rt-1', userId: 'user-1', familyId: 'fam-1', expiresAt: future(), usedAt: null, revokedAt: null });

      const res = await service.refresh('rft_old');

      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({ where: { tokenHash: tokens.hash('rft_old') } });
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({ where: { id: 'rt-1' }, data: { usedAt: expect.any(Date) } });
      expect(res.refreshToken).not.toBe('rft_old');
      // 같은 계열(familyId)로 새 토큰을 만든다
      expect(prisma.refreshToken.create.mock.calls[0][0].data).toMatchObject({ userId: 'user-1', familyId: 'fam-1' });
    });

    // 의도: 이미 쓴 토큰이 다시 왔다 = 누군가 토큰을 훔쳤을 수 있다. 공격자와 사용자 중 누가 정상인지 모르므로 계열 전체를 폐기한다.
    it('2. 이미 사용한 refresh 토큰이 오면 401 과 함께 같은 계열 토큰을 전부 폐기한다', async () => {
      const service = build();
      prisma.refreshToken.findUnique.mockResolvedValue({ id: 'rt-1', userId: 'user-1', familyId: 'fam-1', expiresAt: future(), usedAt: new Date(), revokedAt: null });

      await expectApiError(service.refresh('rft_used'), 'UNAUTHENTICATED', 401);

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { familyId: 'fam-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    // 의도: 위조되었거나 잘못 입력된 토큰.
    it('3. refresh 토큰이 없으면 401', async () => {
      const service = build();
      prisma.refreshToken.findUnique.mockResolvedValue(null);
      await expectApiError(service.refresh('rft_x'), 'UNAUTHENTICATED', 401);
    });

    // 의도: TTL 이 지나면 다시 로그인해야 한다. 오래된 토큰이 영원히 쓰이지 않게.
    it('3. 만료된 refresh 토큰이면 401', async () => {
      const service = build();
      prisma.refreshToken.findUnique.mockResolvedValue({ id: 'rt', userId: 'u', familyId: 'f', expiresAt: new Date(Date.now() - 1), usedAt: null, revokedAt: null });
      await expectApiError(service.refresh('rft_x'), 'UNAUTHENTICATED', 401);
    });

    // 의도: 로그아웃/탈퇴/재사용 감지로 폐기된 토큰. 폐기 검사가 재사용 검사보다 먼저여서 계열 폐기 쿼리를 다시 돌리지 않는다.
    it('3. 폐기된 refresh 토큰이면 401 이고 계열 폐기를 다시 하지 않는다', async () => {
      const service = build();
      prisma.refreshToken.findUnique.mockResolvedValue({ id: 'rt', userId: 'u', familyId: 'f', expiresAt: future(), usedAt: new Date(), revokedAt: new Date() });
      await expectApiError(service.refresh('rft_x'), 'UNAUTHENTICATED', 401);
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });

  // ── 3.1 차량 등록 POST /v1/devices/vehicle/enroll ─────────────
  describe('3.1 차량 등록 enrollVehicleDevice', () => {
    beforeEach(() => {
      prisma.vehicle.create.mockResolvedValue({ id: 'vehicle-1' });
      prisma.device.create.mockResolvedValue({ id: 'car-1' });
      prisma.vehicleStateCache.create.mockResolvedValue({});
    });

    // 의도: 셋 중 일부만 생기면 "상태 캐시가 없는 차량"처럼 반쪽짜리 데이터가 남는다. 하나의 트랜잭션이어야 한다.
    it('1. 공유키가 맞으면 Vehicle, 자동차 장치, 빈 상태 캐시를 하나의 트랜잭션으로 생성한다', async () => {
      const service = build();
      await service.enrollVehicleDevice({ enrollSecret: 'enroll-secret', displayName: '내 차', powertrain: 'BEV' } as never);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.vehicle.create).toHaveBeenCalledWith({ data: expect.objectContaining({ displayName: '내 차', powertrain: 'BEV' }) });
      expect(prisma.device.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'CAR', enrolledVehicleId: 'vehicle-1' }) });
      expect(prisma.vehicleStateCache.create).toHaveBeenCalledWith({ data: { vehicleId: 'vehicle-1', metrics: {} } });
    });

    // 의도: 장치 토큰 원문은 이 응답 한 번뿐이다. 서버는 해시만 가지므로 분실하면 재등록해야 한다.
    it('2. 성공하면 { deviceId, vehicleId, deviceToken, scope: vehicle } 로 응답하고, 서버에는 토큰 해시만 저장한다', async () => {
      const service = build();
      const res = await service.enrollVehicleDevice({ enrollSecret: 'enroll-secret', displayName: '내 차' } as never);

      expect(res).toEqual({ deviceId: 'car-1', vehicleId: 'vehicle-1', deviceToken: expect.stringMatching(/^dvt_/), scope: 'vehicle' });
      const saved = prisma.device.create.mock.calls[0][0].data;
      expect(saved.tokenHash).toBe(tokens.hash(res.deviceToken));
      expect(JSON.stringify(saved)).not.toContain(res.deviceToken);
    });

    // 의도: 설치 비밀 없이 누구나 차량을 등록해서 장치 토큰(vehicle scope)을 얻지 못하게 한다.
    it('3. 공유키가 맞지 않으면 403 이고 아무것도 만들지 않는다', async () => {
      const service = build();
      await expectApiError(service.enrollVehicleDevice({ enrollSecret: 'wrong', displayName: 'x' } as never), 'FORBIDDEN', 403);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // 의도: 모르는 값을 EV 로 가정하지 않는다. UNKNOWN 이면 preflight 에서 BLOCK 되어, 엔진 차량(배기가스 위험)이 실수로 통과하지 않는다.
    it('4. powertrain 을 주지 않으면 UNKNOWN 으로 저장한다', async () => {
      const service = build();
      await service.enrollVehicleDevice({ enrollSecret: 'enroll-secret', displayName: 'x' } as never);
      expect(prisma.vehicle.create.mock.calls[0][0].data.powertrain).toBe('UNKNOWN');
    });
  });
});
