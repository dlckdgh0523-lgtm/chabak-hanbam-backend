import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard } from './auth.guard';
import { TokenService } from './token.service';
import { PUBLIC_KEY, SCOPES_KEY, Scope } from './principal';
import { PrismaService } from '../prisma/prisma.service';
import { createConfig, createPrismaMock, expectApiError, PrismaMock } from '../testing/helpers';

// 2.3 요청 인증, scope (guard 는 서비스는 아니지만 2.3.1~2.3.3 요구사항이 여기에 있다)
// [이 파일의 의도]
// 모든 요청의 입구. 토큰 폐기(연결 해제, 재발급, 탈퇴)가 "실제로 효력을 갖는 곳"이 여기다.
describe('AuthGuard', () => {
  let prisma: PrismaMock;
  let tokens: TokenService;
  let guard: AuthGuard;
  let meta: { isPublic?: boolean; scopes?: Scope[] };

  const ctx = (authorization?: string) => {
    const req: Record<string, unknown> = { headers: authorization ? { authorization } : {} };
    const c = {
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { c, req };
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.device.update.mockResolvedValue({});
    tokens = new TokenService(new JwtService(), createConfig());
    meta = {};
    const reflector = { getAllAndOverride: (key: string) => (key === PUBLIC_KEY ? meta.isPublic : key === SCOPES_KEY ? meta.scopes : undefined) } as unknown as Reflector;
    guard = new AuthGuard(reflector, tokens, prisma as unknown as PrismaService);
  });

  describe('2.3.1 Authorization 헤더', () => {
    // 의도: 토큰 없는 요청은 누구인지 모르므로 거부.
    it('Bearer 헤더가 없으면 401', async () => {
      await expectApiError(guard.canActivate(ctx().c), 'UNAUTHENTICATED', 401);
      await expectApiError(guard.canActivate(ctx('Basic abc').c), 'UNAUTHENTICATED', 401);
    });

    // 의도: 형식이 틀리거나 위조된 토큰.
    it('잘못된 토큰이면 401', async () => {
      await expectApiError(guard.canActivate(ctx('Bearer garbage').c), 'UNAUTHENTICATED', 401);
    });

    // 의도: 연결 해제·재발급·탈퇴 후에 그 장치 토큰이 계속 통하면 폐기가 의미 없다.
    it('폐기된 장치 토큰이면 401', async () => {
      prisma.device.findUnique.mockResolvedValue({ id: 'car-1', type: 'CAR', userId: null, revokedAt: new Date() });
      await expectApiError(guard.canActivate(ctx('Bearer dvt_x').c), 'UNAUTHENTICATED', 401);
    });

    // 의도: 원문이 아니라 해시로 조회해야 DB 에 원문을 둘 필요가 없다.
    it('없는 장치 토큰이면 401 (해시로 조회한다)', async () => {
      prisma.device.findUnique.mockResolvedValue(null);
      await expectApiError(guard.canActivate(ctx('Bearer dvt_x').c), 'UNAUTHENTICATED', 401);
      expect(prisma.device.findUnique).toHaveBeenCalledWith({ where: { tokenHash: tokens.hash('dvt_x') } });
    });

    // 의도: 로그인, 차량 등록, 헬스체크는 토큰 없이 호출된다.
    it('@Public 이면 헤더 없이 통과한다', async () => {
      meta.isPublic = true;
      await expect(guard.canActivate(ctx().c)).resolves.toBe(true);
    });
  });

  describe('2.3.2 scope', () => {
    // 의도: @Scopes 를 깜빡한 API 가 장치 토큰에 열리지 않게, 기본값을 가장 좁게(user) 둔다.
    it('기본 scope 는 user 만 허용한다 (장치 토큰은 403)', async () => {
      prisma.device.findUnique.mockResolvedValue({ id: 'car-1', type: 'CAR', userId: null, revokedAt: null });
      await expectApiError(guard.canActivate(ctx('Bearer dvt_x').c), 'FORBIDDEN', 403);
    });

    // 의도: 사용자가 차량 전용 API(명령 결과 보고 등)를 호출해 차량인 척하지 못하게.
    it('허용 scope 에 없으면 403 (사용자 토큰으로 vehicle 전용 API 호출)', async () => {
      meta.scopes = ['vehicle'];
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', deletionRequestedAt: null });
      await expectApiError(guard.canActivate(ctx(`Bearer ${tokens.signUserAccess('user-1')}`).c), 'FORBIDDEN', 403);
    });

    // 의도: 서비스는 req.principal 로 "누가 호출했는지" 판단하므로 정확히 채워져야 한다.
    it('허용 scope 에 있으면 통과하고 req.principal 을 채운다', async () => {
      meta.scopes = ['vehicle', 'sensor'];
      prisma.device.findUnique.mockResolvedValue({ id: 'sensor-1', type: 'SENSOR', userId: 'user-1', revokedAt: null });
      const { c, req } = ctx('Bearer dvt_x');
      await expect(guard.canActivate(c)).resolves.toBe(true);
      expect(req.principal).toMatchObject({ kind: 'DEVICE', deviceId: 'sensor-1', scopes: ['sensor'] });
    });

    // 의도: 정상 경로 기준.
    it('유효한 사용자 토큰은 user scope 로 통과한다', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', deletionRequestedAt: null });
      const { c, req } = ctx(`Bearer ${tokens.signUserAccess('user-1')}`);
      await expect(guard.canActivate(c)).resolves.toBe(true);
      expect(req.principal).toMatchObject({ kind: 'USER', userId: 'user-1', scopes: ['user'] });
    });
  });

  describe('2.3.3 탈퇴 사용자', () => {
    // 의도: access 토큰이 아직 만료 전이어도 탈퇴 즉시 차단해야 한다.
    it('탈퇴를 요청한 사용자의 토큰은 401', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', deletionRequestedAt: new Date() });
      await expectApiError(guard.canActivate(ctx(`Bearer ${tokens.signUserAccess('user-1')}`).c), 'UNAUTHENTICATED', 401);
    });
  });
});
