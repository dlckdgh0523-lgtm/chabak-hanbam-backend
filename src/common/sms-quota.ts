import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApiError } from './errors';

// 연락처는 사용자가 아무 번호나 넣을 수 있다 → 테스트·경보 SMS 를 합쳐 사용자당 하루 상한 (문자 폭탄·비용 악용 방지)
export const SMS_DAILY_LIMIT = 20;

export async function consumeSmsQuota(prisma: PrismaService, tx: Prisma.TransactionClient, userId: string, count: number) {
  await prisma.lock(tx, `sms-quota:${userId}`);
  const day = new Date().toISOString().slice(0, 10);
  const u = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { smsQuotaDay: true, smsQuotaUsed: true } });
  const used = u.smsQuotaDay === day ? u.smsQuotaUsed : 0;
  if (used + count > SMS_DAILY_LIMIT) throw new ApiError('RATE_LIMITED', `daily SMS limit ${SMS_DAILY_LIMIT} reached`);
  await tx.user.update({ where: { id: userId }, data: { smsQuotaDay: day, smsQuotaUsed: used + count } });
}
