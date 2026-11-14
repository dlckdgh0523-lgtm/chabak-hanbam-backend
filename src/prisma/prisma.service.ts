import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
  /** 같은 key(차량·사용자·경보 id)의 read-modify-write 를 트랜잭션 끝까지 직렬화한다 (서버 여러 대여도 DB 락이라 유효). */
  lock(tx: Prisma.TransactionClient, key: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }
  /** 서버가 여러 대여도 key 를 잡은 한 곳만 fn 을 실행한다 (주기 작업용). 못 잡으면 건너뛴다.
   *  풀 연결을 고정할 수 없어 세션 락 대신 tick 동안만 잡는 트랜잭션 락을 쓴다. */
  async runExclusive(key: string, fn: () => Promise<unknown>) {
    await this.$transaction(async (tx) => {
      const [{ ok }] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS ok`;
      if (ok) await fn();
    }, { timeout: 60_000 });
  }
}
