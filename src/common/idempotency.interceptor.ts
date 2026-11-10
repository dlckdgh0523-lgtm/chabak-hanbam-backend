import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { ApiError } from './errors';
import { principalKey } from '../auth/principal';

export const IDEMPOTENT_KEY = 'idempotent';
/** 명령·예약·문자 요청 등 부작용 있는 POST 에 붙인다. Idempotency-Key 헤더 필수. */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

const TTL_MS = 24 * 3600 * 1000;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const on = this.reflector.get<boolean>(IDEMPOTENT_KEY, ctx.getHandler());
    if (!on) return next.handle();

    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const key: string | undefined = req.headers['idempotency-key'];
    if (!key || key.length > 128) throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key header required (<=128 chars)');

    const principal = principalKey(req.principal);
    const route = `${req.method} ${req.route?.path ?? req.path}`;
    const requestHash = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');

    return from(this.prisma.idempotencyRecord.findUnique({ where: { principal_route_key: { principal, route, key } } })).pipe(
      switchMap((rec) => {
        if (rec) {
          if (rec.requestHash !== requestHash) throw new ApiError('IDEMPOTENCY_CONFLICT', 'same Idempotency-Key with different body');
          res.status(rec.statusCode);
          res.setHeader('idempotent-replayed', 'true');
          return of(rec.response);
        }
        return next.handle().pipe(
          tap((body) => {
            void this.prisma.idempotencyRecord
              .create({
                data: { principal, route, key, requestHash, statusCode: res.statusCode, response: body ?? {}, expiresAt: new Date(Date.now() + TTL_MS) },
              })
              .catch(() => undefined); // 동시 요청 race: 첫 기록만 남는다
          }),
        );
      }),
    );
  }
}
