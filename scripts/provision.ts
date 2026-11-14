/**
 * 차량별 1회용 등록 코드 발급. 원문은 여기서 한 번만 출력되고 DB 에는 HMAC 만 남는다.
 *   npm run provision -- --count 3 --ttl-days 7 --label "시연차"
 * DATABASE_URL, DEVICE_TOKEN_PEPPER 는 서버와 같은 값을 쓴다.
 */
import { PrismaClient } from '@prisma/client';
import { createHmac, randomBytes } from 'crypto';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const count = Number(arg('count') ?? 1), ttlDays = Number(arg('ttl-days') ?? 7), label = arg('label');
if (!Number.isInteger(count) || count < 1 || count > 100 || !(ttlDays > 0)) throw new Error('usage: --count 1..100 [--ttl-days D>0] [--label x]');
const pepper = process.env.DEVICE_TOKEN_PEPPER;
if (!pepper) throw new Error('DEVICE_TOKEN_PEPPER required (same as server)');

(async () => {
  const prisma = new PrismaClient();
  const expiresAt = new Date(Date.now() + ttlDays * 86400_000);
  const codes = Array.from({ length: count }, () => 'prv_' + randomBytes(24).toString('base64url'));
  // TokenService.hash 와 같은 HMAC
  await prisma.provisioningCode.createMany({ data: codes.map((c) => ({ codeHash: createHmac('sha256', pepper).update(c).digest('hex'), label, expiresAt })) });
  await prisma.$disconnect();
  console.log(`# ${count} code(s), expires ${expiresAt.toISOString()}${label ? `, label=${label}` : ''} — 다시 볼 수 없으니 지금 전달하세요`);
  for (const c of codes) console.log(c);
})();
