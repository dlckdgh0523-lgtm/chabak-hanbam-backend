import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { ApiError } from '../common/errors';
import { Principal, PUBLIC_KEY, Scope, SCOPES_KEY } from './principal';
import { TokenService } from './token.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new ApiError('UNAUTHENTICATED', 'missing bearer token');
    const raw = header.slice(7).trim();

    const principal = await this.resolve(raw);
    if (!principal) throw new ApiError('UNAUTHENTICATED', 'invalid or revoked token');
    req.principal = principal;

    const required = this.reflector.getAllAndOverride<Scope[]>(SCOPES_KEY, [ctx.getHandler(), ctx.getClass()]) ?? ['user'];
    if (!required.some((s) => principal.scopes.includes(s))) {
      throw new ApiError('FORBIDDEN', `requires scope ${required.join('|')}`);
    }
    return true;
  }

  private async resolve(raw: string): Promise<Principal | null> {
    if (this.tokens.isDeviceToken(raw)) {
      const device = await this.prisma.device.findUnique({ where: { tokenHash: this.tokens.hash(raw) } });
      if (!device || device.revokedAt) return null;
      // lastSeenAt 갱신은 best-effort (await 안 함)
      void this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
      return {
        kind: 'DEVICE',
        id: device.id,
        deviceId: device.id,
        deviceType: device.type,
        userId: device.userId,
        scopes: [this.tokens.scopeForDevice(device.type)],
      };
    }
    const payload = this.tokens.verifyUserAccess(raw);
    if (!payload || payload.scope !== 'user') return null;
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, deletionRequestedAt: true } });
    if (!user || user.deletionRequestedAt) return null;
    return { kind: 'USER', id: user.id, userId: user.id, scopes: ['user'] };
  }
}
