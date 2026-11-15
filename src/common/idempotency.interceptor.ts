import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { Observable, catchError, concatMap, from, map, of, switchMap, throwError } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { ApiError } from './errors';
import { principalKey } from '../auth/principal';

export const IDEMPOTENT_KEY = 'idempotent';
/** 명령·예약·문자 요청 등 부작용 있는 POST 에 붙인다. Idempotency-Key 헤더 필수. */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

const TTL_MS = 24 * 3600 * 1000;
const PENDING = 0; // 선점만 하고 아직 응답이 없는 기록

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
          if (rec.statusCode === PENDING) throw new ApiError('IDEMPOTENCY_CONFLICT', 'same Idempotency-Key still in progress; retry later');
          res.status(rec.statusCode);
          res.setHeader('idempotent-replayed', 'true');
          return of(rec.response);
        }
        // 실행 전에 키를 선점한다. 동시에 온 같은 키는 unique 충돌로 한 건만 실행된다.
        const where = { principal_route_key: { principal, route, key } };
        const reserve = this.prisma.idempotencyRecord
          .create({ data: { principal, route, key, requestHash, statusCode: PENDING, response: {}, expiresAt: new Date(Date.now() + TTL_MS) } })
          .catch((e: { code?: string }) => {
            if (e.code === 'P2002') throw new ApiError('IDEMPOTENCY_CONFLICT', 'same Idempotency-Key still in progress; retry later');
            throw e;
          });
        return from(reserve).pipe(
          switchMap(() =>
            next.handle().pipe(
              concatMap((body) => from(this.prisma.idempotencyRecord.update({ where, data: { statusCode: res.statusCode, response: body ?? {} } })).pipe(map(() => body))),
              // 실패한 요청은 선점을 풀어 같은 키로 재시도할 수 있게 한다 (선점에 실패한 요청은 여기 오지 않음)
              catchError((e) => from(this.prisma.idempotencyRecord.delete({ where }).catch(() => undefined)).pipe(switchMap(() => throwError(() => e)))),
            ),
          ),
        );
      }),
    );
  }
}
