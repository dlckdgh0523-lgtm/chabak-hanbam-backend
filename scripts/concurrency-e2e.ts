/** 동시성 검증: 서버가 :3000 에 떠 있어야 한다. 빈 DB 기준. */
import { randomUUID } from 'crypto';

const BASE = 'http://localhost:3000/v1';
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✔ ${name}`); } else { fail++; console.log(`  ✘ ${name}`, extra ?? ''); } };
async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const idem = () => ({ 'idempotency-key': randomUUID() });

(async () => {
  // ── 준비: 차량·사용자·페어링·예약·세션 2개 ──
  const enroll = await call('POST', '/devices/vehicle/enroll', undefined, { enrollSecret: 'change-me-enroll-secret', displayName: 'EMU', powertrain: 'EV' });
  const CAR = enroll.body.deviceToken, vehicleId = enroll.body.vehicleId;
  const USER = (await call('POST', '/auth/sessions', undefined, { provider: 'DEV', credential: 'conc' })).body.accessToken;
  const qr = JSON.parse((await call('POST', '/pairings', CAR)).body.qrPayload);
  await call('POST', `/pairings/${qr.pairingId}/claim`, USER, { secret: qr.secret });
  await call('POST', `/pairings/${qr.pairingId}/confirm`, CAR);
  for (const purpose of ['VEHICLE_STATE', 'SENSOR']) await call('POST', '/consents', USER, { purpose, version: 'v1', decision: 'GRANTED' });
  await call('POST', `/vehicles/${vehicleId}/capability-reports`, CAR, {
    sdkVersion: '2', serviceVersion: '2', emulatorVersion: '2', executionMode: 'PLEOS_EMULATOR', observedAt: new Date().toISOString(), permissions: [],
    features: [{ feature: 'hvac.temperature', supported: true, readAllowed: true, writeAllowed: false, areas: ['ROW_1_LEFT'], min: 16, max: 30, step: 0.5, unit: 'C' }],
  });
  await call('POST', `/vehicles/${vehicleId}/heartbeats`, CAR, { executionMode: 'PLEOS_EMULATOR', powerState: 'PARKED' });
  const place = (await call('GET', '/places/search', USER)).body.places[0];
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const plan = { heatEnabled: true, targetTempC: 20, ventilationPolicy: 'FRESH_AIR_REQUIRED', accessAlertEnabled: true, wakeAt: `${tomorrow}T22:00:00Z`, timezone: 'Asia/Seoul', musicDurationMin: 15 };
  const sessions: string[] = [];
  for (let i = 0; i < 3; i++) {
    const trip = await call('POST', '/trips', USER, { placeId: place.id, vehicleId, startAt: `${tomorrow}T12:00:00Z`, endAt: `${tomorrow}T23:00:00Z`, timezone: 'Asia/Seoul', people: 2 }, idem());
    sessions.push((await call('POST', '/sleep-sessions', USER, { tripId: trip.body.id, desiredPlan: plan, capabilityRevision: 1, executionMode: 'MOCK' }, idem())).body.id);
  }
  await call('POST', '/demo/scenarios', CAR, { vehicleId, sessionId: sessions[0], scenario: 'NORMAL' });
  await call('POST', '/demo/scenarios', CAR, { vehicleId, sessionId: sessions[0], scenario: 'DOORS_SECURED' });

  console.log('\n[A] 센서 토큰 10개 동시 발급 → 살아있는 토큰 1개');
  const toks = await Promise.all(Array.from({ length: 10 }, () => call('POST', `/vehicles/${vehicleId}/sensor-tokens`, USER)));
  const alive = await Promise.all(toks.map((t) => call('POST', `/vehicles/${vehicleId}/telemetry-batches`, t.body.deviceToken, {})));
  const aliveCount = alive.filter((r) => r.status !== 401).length;
  ok(`all issued 201 (${toks.filter((t) => t.status === 201).length}/10)`, toks.every((t) => t.status === 201));
  ok(`exactly 1 sensor token alive (got ${aliveCount})`, aliveCount === 1);
  const SENSOR = toks[alive.findIndex((r) => r.status !== 401)]?.body.deviceToken;

  console.log('\n[B] 차량·센서 동시 업로드 20회 → metric 유실 없음, revision 매번 +2');
  let lost = 0, revSkips = 0;
  for (let i = 0; i < 20; i++) {
    const before = (await call('GET', `/vehicles/${vehicleId}/state`, USER)).body.revision;
    const now = new Date().toISOString();
    const temp = 18 + i / 10, co2 = 800 + i;
    await Promise.all([
      call('POST', `/vehicles/${vehicleId}/telemetry-batches`, CAR, { samples: [{ metric: 'cabinTempC', value: temp, unit: 'C', source: 'PLEOS', observedAt: now, seq: 1000 + i, bootId: 'b-car' }] }),
      call('POST', `/vehicles/${vehicleId}/telemetry-batches`, SENSOR, { samples: [{ metric: 'co2Ppm', value: co2, unit: 'ppm', source: 'BLE_SENSOR', observedAt: now, seq: 1000 + i, bootId: 'b-sen' }] }),
    ]);
    const st = (await call('GET', `/vehicles/${vehicleId}/state`, USER)).body;
    if (st.metrics.cabinTempC?.value !== temp || st.metrics.co2Ppm?.value !== co2) lost++;
    if (st.revision !== before + 2) revSkips++;
  }
  ok(`no lost metric (lost ${lost}/20)`, lost === 0);
  ok(`revision +2 every round (wrong ${revSkips}/20)`, revSkips === 0);

  // preflight 는 클라이언트가 본 revision 이 필요 — 센서 업로드 직후 최신 값으로
  const pf = async (sid: string) => {
    const rev = (await call('GET', `/vehicles/${vehicleId}/state`, USER)).body.revision;
    return (await call('POST', `/sleep-sessions/${sid}/preflight`, USER, { stateRevision: rev })).body;
  };
  const start = (sid: string, preflightId: string, ua: string) => call('POST', `/sleep-sessions/${sid}/start`, USER, { preflightId, planVersion: 1, userConfirmed: true, userActionId: ua });

  console.log('\n[C] 서로 다른 세션 2개 동시 start → ACTIVE 1개');
  const [p0, p1] = [await pf(sessions[0]), await pf(sessions[1])];
  ok('both preflights READY', p0.readiness === 'READY' && p1.readiness === 'READY', [p0.blockers, p1.blockers]);
  const both = await Promise.all([start(sessions[0], p0.preflightId, 'c0'), start(sessions[1], p1.preflightId, 'c1')]);
  ok(`exactly one 200 (got ${both.map((r) => r.status).join(',')})`, both.filter((r) => r.status === 200).length === 1);

  console.log('\n[D] 같은 세션 동시 start 5번 → 200 최대 1개');
  const winner = both.findIndex((r) => r.status === 200);
  if (winner >= 0) await call('POST', `/sleep-sessions/${sessions[winner]}/stop`, USER, { reason: 'USER_STOP' });
  const p2 = await pf(sessions[2]);
  const five = await Promise.all(Array.from({ length: 5 }, (_, i) => start(sessions[2], p2.preflightId, `d${i}`)));
  ok(`exactly one 200 (got ${five.map((r) => r.status).join(',')})`, five.filter((r) => r.status === 200).length === 1);

  console.log('\n[E] 같은 Idempotency-Key 동시 5번 → 예약 1건만 생성');
  const key = randomUUID();
  const tripBody = { placeId: place.id, vehicleId, startAt: `${tomorrow}T12:00:00Z`, endAt: `${tomorrow}T23:00:00Z`, timezone: 'Asia/Seoul', people: 1 };
  const same = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/trips', USER, tripBody, { 'idempotency-key': key })));
  const ids = new Set(same.filter((r) => r.status === 201).map((r) => r.body.id));
  ok(`one trip created (ids ${ids.size}, statuses ${same.map((r) => r.status).join(',')})`, ids.size === 1 && same.every((r) => r.status === 201 || r.status === 409));

  console.log('\n[F] 같은 경보 SMS 동시 5번(키 다름) → 202 1개');
  const cv = (await call('GET', '/emergency-contacts', USER)).body.version;
  const contactId = (await call('PUT', '/emergency-contacts', USER, { expectedVersion: cv, contacts: [{ name: 'a', phone: '010-0000-0000' }] })).body.contacts[0].id;
  const alertId = (await call('POST', '/alerts/test', USER, { vehicleId, kind: 'PUSH' })).body.alertId;
  const sms = await Promise.all(Array.from({ length: 5 }, (_, i) => call('POST', `/alerts/${alertId}/contact-notifications`, USER, { recipients: [contactId], template: 'ACCESS_HELP', userActionId: `f${i}` }, idem())));
  ok(`exactly one 202 (got ${sms.map((r) => r.status).join(',')})`, sms.filter((r) => r.status === 202).length === 1);

  console.log('\n[G] 연락처 같은 버전 동시 PUT 5번 → 200 1개');
  const v = (await call('GET', '/emergency-contacts', USER)).body.version;
  const puts = await Promise.all(Array.from({ length: 5 }, (_, i) => call('PUT', '/emergency-contacts', USER, { expectedVersion: v, contacts: [{ name: `n${i}`, phone: '010-1111-1111' }] })));
  ok(`exactly one 200 (got ${puts.map((r) => r.status).join(',')})`, puts.filter((r) => r.status === 200).length === 1);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
