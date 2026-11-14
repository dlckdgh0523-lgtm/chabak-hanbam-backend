/**
 * 프론트 live 모드용 데모 데이터: 장소 4곳(고정 id) + 차량 enroll → 페어링 완료 + 동의 + 연락처 + 센서 토큰 + 예약 + 취침 세션(PLANNED).
 * 서버(:3000)가 떠 있어야 하고, 장소는 DB 에 직접 넣으므로 서버와 같은 DATABASE_URL 이 필요하다. 개발 환경 전용.
 *   npm run seed:demo -- [--out ../live-seed.json] [--keepalive]
 * --keepalive: 이미 만든 seed 파일이 있으면 그 차량을 재사용(없으면 새로 만듦)하고, 5초마다 차량 heartbeat + MOCK 센서/차량 값을 올려 OFFLINE·센서 단절로 preflight 가 막히지 않게 한다.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const BASE = process.env.BASE ?? 'http://localhost:3000/v1';
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const out = arg('out') ?? '../live-seed.json';
const USER_CREDENTIAL = 'demo-user'; // 프론트는 POST /auth/sessions {provider:'DEV', credential:'demo-user'} 로 같은 사용자를 얻는다

// 프론트 화면의 장소 이름 ↔ 고정 id (DEMO 좌표)
export const SEED_PLACES = [
  { id: '5e0d0000-0000-4000-8000-000000000001', providerId: 'seed-solnae', name: '솔내 해변 노지', lat: 37.8051, lng: 128.9087, campingStatus: 'ALLOWED', cookingStatus: 'CONDITIONAL', meta: { toilet: true, ev: true, surface: 'sand', demo: true } },
  { id: '5e0d0000-0000-4000-8000-000000000002', providerId: 'seed-najeong', name: '나정 모래 해변', lat: 37.7312, lng: 128.9601, campingStatus: 'CONDITIONAL', cookingStatus: 'PROHIBITED', meta: { toilet: true, ev: false, surface: 'sand', demo: true } },
  { id: '5e0d0000-0000-4000-8000-000000000003', providerId: 'seed-bukhang', name: '북항 방파제 공터', lat: 37.8890, lng: 128.8301, campingStatus: 'UNKNOWN', cookingStatus: 'PROHIBITED', meta: { toilet: false, ev: 'UNKNOWN', surface: 'asphalt', demo: true } },
  { id: '5e0d0000-0000-4000-8000-000000000004', providerId: 'seed-galma', name: '갈마 솔숲 쉼터', lat: 37.7633, lng: 128.9282, campingStatus: 'ALLOWED', cookingStatus: 'ALLOWED', meta: { toilet: true, ev: true, surface: 'gravel', demo: true } },
] as const;

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return json;
}
const idem = () => ({ 'idempotency-key': randomUUID() });

async function seed() {
  const prisma = new PrismaClient();
  for (const p of SEED_PLACES) await prisma.place.upsert({ where: { providerId: p.providerId }, create: p, update: { name: p.name, lat: p.lat, lng: p.lng } });
  await prisma.$disconnect();

  const car = await call('POST', '/devices/vehicle/enroll', undefined, { enrollSecret: process.env.VEHICLE_ENROLL_SECRET, displayName: '차박하루 데모차', powertrain: 'EV', installationId: 'demo-cid' });
  const CAR = car.deviceToken as string, vehicleId = car.vehicleId as string;
  const USER = (await call('POST', '/auth/sessions', undefined, { provider: 'DEV', credential: USER_CREDENTIAL })).accessToken as string;
  const qr = JSON.parse((await call('POST', '/pairings', CAR)).qrPayload);
  await call('POST', `/pairings/${qr.pairingId}/claim`, USER, { secret: qr.secret });
  const { linkId } = await call('POST', `/pairings/${qr.pairingId}/confirm`, CAR);
  for (const purpose of ['LOCATION', 'CONTACTS', 'SENSOR', 'VEHICLE_STATE', 'EXTERNAL_AI']) await call('POST', '/consents', USER, { purpose, version: 'v1', decision: 'GRANTED' });
  await call('POST', `/vehicles/${vehicleId}/capability-reports`, CAR, {
    sdkVersion: 'emu', serviceVersion: 'emu', emulatorVersion: 'emu', executionMode: 'MOCK', observedAt: new Date().toISOString(), permissions: [],
    features: [{ feature: 'hvac.temperature', supported: true, readAllowed: true, writeAllowed: true, areas: ['ROW_1_LEFT'], min: 16, max: 30, step: 0.5, unit: 'C' }, { feature: 'hvac.recirculation', supported: true, readAllowed: true, writeAllowed: true, areas: [] }],
  });
  const contacts = await call('PUT', '/emergency-contacts', USER, { expectedVersion: (await call('GET', '/emergency-contacts', USER)).version, contacts: [{ name: '엄마', phone: '010-1234-5678' }, { name: '친구', phone: '010-9876-5432' }] });
  const SENSOR = (await call('POST', `/vehicles/${vehicleId}/sensor-tokens`, USER)).deviceToken as string;
  const day = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const trip = await call('POST', '/trips', USER, { placeId: SEED_PLACES[0].id, vehicleId, startAt: `${day}T09:00:00Z`, endAt: `${day}T23:00:00Z`, timezone: 'Asia/Seoul', people: 2 }, idem());
  const plan = { heatEnabled: true, targetTempC: 20, ventilationPolicy: 'FRESH_AIR_REQUIRED', accessAlertEnabled: true, wakeAt: `${day}T22:00:00Z`, timezone: 'Asia/Seoul', musicDurationMin: 30 };
  const session = await call('POST', '/sleep-sessions', USER, { tripId: trip.id, desiredPlan: plan, capabilityRevision: 1, executionMode: 'MOCK' }, idem());

  const seed = {
    note: 'dev 전용 데모 값. 장치 토큰은 비밀이므로 커밋·공유 금지. 서버 DB 를 새로 만들면 다시 생성',
    baseUrl: BASE, wsUrl: BASE.replace(/^http/, 'ws') + '/ws',
    user: { login: { provider: 'DEV', credential: USER_CREDENTIAL } },
    carDeviceToken: CAR, sensorDeviceToken: SENSOR,
    vehicleId, linkId, tripId: trip.id, sleepSessionId: session.id,
    places: Object.fromEntries(SEED_PLACES.map((p) => [p.name, p.id])),
    contacts: contacts.contacts.map((c: { id: string; name: string; priority: number }) => ({ id: c.id, name: c.name, priority: c.priority })),
  };
  writeFileSync(out, JSON.stringify(seed, null, 2) + '\n');
  console.log(`seed written → ${out}\n  vehicleId=${vehicleId}\n  tripId=${trip.id}\n  sleepSessionId=${session.id}`);
  return seed;
}

(async () => {
  if (process.env.NODE_ENV === 'production') throw new Error('seed is dev only');
  const keepalive = process.argv.includes('--keepalive');
  const { vehicleId, carDeviceToken: CAR, sensorDeviceToken: SENSOR } = keepalive && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : await seed();
  if (!keepalive) return;
  console.log('keepalive: 5초마다 heartbeat + MOCK 값 (Ctrl+C 로 종료)');
  let seq = 0;
  const tick = async () => {
    const now = new Date().toISOString(), s = (metric: string, value: number | string, unit: string) => ({ metric, value, unit, source: 'MOCK', observedAt: now, seq: ++seq, bootId: 'seed-keepalive' });
    await call('POST', `/vehicles/${vehicleId}/heartbeats`, CAR, { executionMode: 'MOCK', powerState: 'PARKED' });
    await call('POST', `/vehicles/${vehicleId}/telemetry-batches`, CAR, { samples: [s('doorLock.all', 'LOCKED', 'enum'), s('window.all', 'CLOSED', 'enum'), s('evSocPct', 72, '%'), s('batt12vVolt', 12.6, 'V'), s('cabinTempC', 19, 'C')] });
    await call('POST', `/vehicles/${vehicleId}/telemetry-batches`, SENSOR, { samples: [s('co2Ppm', 800, 'ppm'), s('coPpm', 0, 'ppm')] });
  };
  await tick();
  setInterval(() => void tick().catch((e: Error) => console.error('keepalive:', e.message)), 5000);
})();
