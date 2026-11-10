import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { DeviceType } from '@prisma/client';

export type Scope = 'user' | 'vehicle' | 'sensor';

export type UserPrincipal = { kind: 'USER'; id: string; userId: string; scopes: Scope[] };
export type DevicePrincipal = {
  kind: 'DEVICE';
  id: string; // deviceId
  deviceId: string;
  deviceType: DeviceType;
  userId: string | null;
  scopes: Scope[];
};
export type Principal = UserPrincipal | DevicePrincipal;

export const SCOPES_KEY = 'scopes';
/** 허용 scope 목록. 하나라도 있으면 통과. */
export const Scopes = (...scopes: Scope[]) => SetMetadata(SCOPES_KEY, scopes);

export const PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest().principal;
});

export const principalKey = (p: Principal) => `${p.kind}:${p.id}`;
