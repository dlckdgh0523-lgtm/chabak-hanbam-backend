/**
 * 시연 경로 e2e — 서버가 :3000 에 떠 있어야 한다.
 * 폰(사용자 JWT) 과 차량(장치 토큰) 두 역할을 번갈아 호출하며, 실패 경로(만료·타인 접근·버전 충돌·UNKNOWN 필터)도 검증한다.
 */
import WebSocket from 'ws';
import { randomUUID } from 'crypto';

const BASE = process.env.BASE ?? 'http://localhost:3000/v1';
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✔ ${name}`); } else { fail++; console.log(`  ✘ ${name}`, extra ?? ''); } };

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const idem = () => ({ 'idempotency-key': randomUUID() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n[0] health');
  ok('health', (await call('GET', '/health')).status === 200);

  console.log('\n[1] 차량 enroll → 장치 토큰');
  const enroll = await call('POST', '/devices/vehicle/enroll', undefined, { enrollSecret: 'change-me-enroll-secret', displayName: 'IONIQ5 EMU', powertrain: 'EV' });
  ok('enroll 201', enroll.status === 201, enroll.body);
  const CAR = enroll.body.deviceToken as string, vehicleId = enroll.body.vehicleId as string;
  ok('token prefix dvt_', CAR.startsWith('dvt_'));
  ok('bad enroll secret → 403', (await call('POST', '/devices/vehicle/enroll', undefined, { enrollSecret: 'x', displayName: 'y' })).status === 403);

  console.log('\n[1b] 페어링 전 차량 장치 단독 보고 (SDK 스파이크 경로)');
  const preHb = await call('POST', `/vehicles/${vehicleId}/heartbeats`, CAR, { executionMode: 'PLEOS_EMULATOR', powerState: 'PARKED' });
  ok('heartbeat before pairing 200', preHb.status === 200, preHb.body);
  const preTel = await call('POST', `/vehicles/${vehicleId}/telemetry-batches`, CAR, { samples: [{ metric: 'cabinTempC', value: 18.5, unit: 'C', source: 'PLEOS', observedAt: new Date().toISOString(), seq: 0, bootId: 'spike-boot' }] });
  ok('telemetry before pairing 202', preTel.status === 202, preTel.body);
  ok('other vehicle id → 404', (await call('POST', `/vehicles/${randomUUID()}/heartbeats`, CAR, { executionMode: 'MOCK' })).status === 404);

  console.log('\n[2] 폰 로그인(DEV) + refresh 회전');
  const login = await call('POST', '/auth/sessions', undefined, { provider: 'DEV', credential: 'changho' });
  ok('login 201', login.status === 201, login.body);
  let USER = login.body.accessToken as string;
  const r1 = await call('POST', '/auth/refresh', undefined, { refreshToken: login.body.refreshToken });
  ok('refresh 200', r1.status === 200);
  USER = r1.body.accessToken;
  const reuse = await call('POST', '/auth/refresh', undefined, { refreshToken: login.body.refreshToken });
  ok('refresh reuse → 401 (family revoked)', reuse.status === 401);
  ok('revoked family cannot refresh', (await call('POST', '/auth/refresh', undefined, { refreshToken: r1.body.refreshToken })).status === 401);
  const relogin = await call('POST', '/auth/sessions', undefined, { provider: 'DEV', credential: 'changho' });
  USER = relogin.body.accessToken;
  const other = (await call('POST', '/auth/sessions', undefined, { provider: 'DEV', credential: 'stranger' })).body.accessToken as string;

  console.log('\n[3] scope 분리');
  ok('user token on vehicle-only route → 403', (await call('POST', '/pairings', USER)).status === 403);
  ok('car token on user-only route → 403', (await call('POST', '/trips', CAR, {}, idem())).status === 403);
  ok('before pairing, user cannot see vehicle → 404', (await call('GET', `/vehicles/${vehicleId}/state`, USER)).status === 404);

  console.log('\n[4] 페어링: QR 1회용·타인 차단·차량 확인');
  const pr = await call('POST', '/pairings', CAR);
  ok('pairing 201', pr.status === 201, pr.body);
  const qr = JSON.parse(pr.body.qrPayload);
  ok('confirm before claim → 422', (await call('POST', `/pairings/${qr.pairingId}/confirm`, CAR)).status === 422);
  ok('wrong secret → 422', (await call('POST', `/pairings/${qr.pairingId}/claim`, USER, { secret: 'pair_wrongwrongwrongwrongwrong' })).status === 422);
  ok('claim 200', (await call('POST', `/pairings/${qr.pairingId}/claim`, USER, { secret: qr.secret })).status === 200);
  ok('second claim (reuse) → 422', (await call('POST', `/pairings/${qr.pairingId}/claim`, other, { secret: qr.secret })).status === 422);
  const cf = await call('POST', `/pairings/${qr.pairingId}/confirm`, CAR);
  ok('vehicle confirm 200 → ACTIVE', cf.status === 200 && cf.body.status === 'ACTIVE', cf.body);
  ok('confirm twice → 422', (await call('POST', `/pairings/${qr.pairingId}/confirm`, CAR)).status === 422);
  ok('stranger still 404 on vehicle', (await call('GET', `/vehicles/${vehicleId}/state`, other)).status === 404);
  ok('owner now sees vehicle', (await call('GET', `/vehicles/${vehicleId}/state`, USER)).status === 200);

  console.log('\n[5] 동의');
  for (const purpose of ['TERMS', 'VEHICLE_STATE', 'SENSOR']) ok(`consent ${purpose}`, (await call('POST', '/consents', USER, { purpose, version: '2026-11-01', decision: 'GRANTED' })).status === 201);
  ok('EXTERNAL_AI denied is fine', (await call('POST', '/consents', USER, { purpose: 'EXTERNAL_AI', version: '2026-11-01', decision: 'DENIED' })).status === 201);

  console.log('\n[6] WSS 구독 (owner only)');
  const events: any[] = [];
  const ws = new WebSocket(`ws://localhost:3000/v1/ws?token=${USER}&vehicleId=${vehicleId}`);
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  ws.on('message', (d) => events.push(JSON.parse(d.toString())));
  const wsBad = new WebSocket(`ws://localhost:3000/v1/ws?token=${other}&vehicleId=${vehicleId}`);
  const badCode = await new Promise<number>((res) => wsBad.on('close', (c) => res(c)));
  ok('stranger ws closed 4403', badCode === 4403, badCode);

  console.log('\n[7] capability 보고 + heartbeat');
  const cap = await call('POST', `/vehicles/${vehicleId}/capability-reports`, CAR, {
    sdkVersion: '2.3.2', serviceVersion: '2.3.21', emulatorVersion: '2.1.0', executionMode: 'PLEOS_EMULATOR', observedAt: new Date().toISOString(),
    permissions: ['pleos.car.permission.CAR_CLIMATE', 'pleos.car.permission.CAR_DOORS', 'pleos.car.permission.CAR_ENERGY'],
    features: [
      { feature: 'hvac.temperature', supported: true, readAllowed: true, writeAllowed: false, reason: 'PERMISSION_DENIED', areas: ['ROW_1_LEFT'], min: 16, max: 30, step: 0.5, unit: 'C' },
      { feature: 'hvac.recirculation', supported: true, readAllowed: true, writeAllowed: false, areas: ['ALL'] },
      { feature: 'door.lock', supported: true, readAllowed: true, writeAllowed: false, reason: 'PERMISSION_DENIED', areas: ['ALL'] },
      { feature: 'ev.soc', supported: true, readAllowed: true, writeAllowed: false, areas: ['ALL'], unit: '%' },
    ],
  });
  ok('capability-report 201 rev1', cap.status === 201 && cap.body.revision === 1, cap.body);
  ok('heartbeat', (await call('POST', `/vehicles/${vehicleId}/heartbeats`, CAR, { executionMode: 'PLEOS_EMULATOR', powerState: 'PARKED' })).status === 200);

  console.log('\n[8] 예약: 폰 → 서버 → 차량 다운로드 → ack');
  const places = await call('GET', '/places/search?lat=37.78&lng=126.9', USER);
  ok('places fixture', places.status === 200 && places.body.places.length >= 3);
  const place = places.body.places.find((p: any) => p.campingStatus === 'CONDITIONAL') ?? places.body.places[0];
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const trip = await call('POST', '/trips', USER, { placeId: place.id, vehicleId, startAt: `${tomorrow}T12:00:00Z`, endAt: `${tomorrow}T23:00:00Z`, timezone: 'Asia/Seoul', people: 2 }, idem());
  ok('trip 201, vehicle NOT_SYNCED', trip.status === 201 && trip.body.sync.vehicle === 'NOT_SYNCED', trip.body);
  ok('trip without Idempotency-Key → 400', (await call('POST', '/trips', USER, { placeId: place.id, vehicleId, startAt: `${tomorrow}T12:00:00Z`, endAt: `${tomorrow}T23:00:00Z`, timezone: 'Asia/Seoul', people: 2 })).status === 400);
  const key = idem();
  const t1 = await call('POST', '/trips', USER, { placeId: place.id, vehicleId, startAt: `${tomorrow}T12:00:00Z`, endAt: `${tomorrow}T23:00:00Z`, timezone: 'Asia/Seoul', people: 3 }, key);
  const t2 = await call('POST', '/trips', USER, { placeId: place.id, vehicleId, startAt: `${tomorrow}T12:00:00Z`, endAt: `${tomorrow}T23:00:00Z`, timezone: 'Asia/Seoul', people: 3 }, key);
  ok('idempotent replay returns same trip', t1.body.id === t2.body.id && t2.headers.get('idempotent-replayed') === 'true');
  ok('same key different body → 409', (await call('POST', '/trips', USER, { placeId: place.id, vehicleId, startAt: `${tomorrow}T12:00:00Z`, endAt: `${tomorrow}T23:00:00Z`, timezone: 'Asia/Seoul', people: 4 }, key)).status === 409);
  const up = await call('GET', `/vehicles/${vehicleId}/trips/upcoming`, CAR);
  ok('vehicle downloads upcoming', up.status === 200 && up.body.trips.some((t: any) => t.id === trip.body.id));
  const ack = await call('POST', `/trips/${trip.body.id}/sync-acks`, CAR, { appliedVersion: 1 });
  ok('sync-ack VEHICLE_SYNCED', ack.body.stage === 'VEHICLE_SYNCED', ack.body);
  ok('patch stale version → 409', (await call('PATCH', `/trips/${trip.body.id}`, USER, { expectedVersion: 99, people: 1 })).status === 409);
  const patched = await call('PATCH', `/trips/${trip.body.id}`, USER, { expectedVersion: 1, people: 1 });
  ok('patch v1→v2, vehicle STALE(v1)', patched.body.version === 2 && patched.body.sync.vehicle === 'STALE(v1)', patched.body.sync);
  ok('patch endAt before startAt → 400', (await call('PATCH', `/trips/${trip.body.id}`, USER, { expectedVersion: 2, endAt: `${tomorrow}T11:00:00Z` })).status === 400);

  console.log('\n[9] 브리핑·비교·전력·일출');
  const br = await call('GET', `/places/${place.id}/briefing`, USER);
  ok('briefing has permits+uncertainty', br.status === 200 && br.body.permits && br.body.uncertainty.length > 0);
  const alt = await call('GET', `/places/${place.id}/alternatives?rank=toilet,ev&require=camping`, USER);
  ok('alternatives: UNKNOWN/CONDITIONAL rejected for require=camping', alt.body.candidates.every((c: any) => c.campingStatus === 'ALLOWED') && alt.body.rejected.length > 0, alt.body);
  const alt0 = await call('GET', `/places/${place.id}/alternatives?require=camping,cooking`, USER);
  ok('alternatives: 0 results returned as-is', alt0.body.candidates.length === 0 && alt0.body.note);
  const sun = await call('GET', `/sun?lat=37.78&lng=126.9&date=${tomorrow}`, USER);
  ok('sunrise computed ~07:xx KST', sun.status === 200 && /T?0[67]:/.test(sun.body.sunriseLocal), sun.body);
  const pp0 = await call('POST', '/power-plans', USER, { vehicleId, tripId: trip.body.id, nightHours: 9, people: 2, targetTempC: 20, outsideTempC: 4, returnDistanceKm: 45 });
  ok('power-plan without SOC → SOC_UNVERIFIED', pp0.body.verdict === 'SOC_UNVERIFIED', pp0.body);

  console.log('\n[10] 취침 세션: preflight 차단 → 상태 갱신 → READY → start');
  const plan = { heatEnabled: true, targetTempC: 20, ventilationPolicy: 'FRESH_AIR_REQUIRED', accessAlertEnabled: true, wakeAt: `${tomorrow}T22:00:00Z`, timezone: 'Asia/Seoul', musicDurationMin: 15 };
  const ss = await call('POST', '/sleep-sessions', USER, { tripId: trip.body.id, desiredPlan: plan, capabilityRevision: 1, executionMode: 'MOCK' }, idem());
  ok('session created PLANNED', ss.status === 201 && ss.body.status === 'PLANNED', ss.body);
  const sid = ss.body.id;
  let st = await call('GET', `/vehicles/${vehicleId}/state`, USER);
  const pf1 = await call('POST', `/sleep-sessions/${sid}/preflight`, USER, { stateRevision: st.body.revision });
  ok('preflight BLOCKED (doors/soc unverified)', pf1.body.readiness === 'BLOCKED' && pf1.body.blockers.some((b: any) => b.code === 'doorLock.all.UNVERIFIED'), pf1.body.blockers?.map((b: any) => b.code));
  ok('start with BLOCKED preflight → 422', (await call('POST', `/sleep-sessions/${sid}/start`, USER, { preflightId: pf1.body.preflightId, planVersion: 1, userConfirmed: true, userActionId: 'ua1' })).status === 422);

  // 차량이 상태 보고 (MOCK 주입)
  ok('demo NORMAL', (await call('POST', '/demo/scenarios', CAR, { vehicleId, sessionId: sid, scenario: 'NORMAL' })).status === 201);
  ok('demo DOORS_SECURED', (await call('POST', '/demo/scenarios', CAR, { vehicleId, sessionId: sid, scenario: 'DOORS_SECURED' })).status === 201);
  st = await call('GET', `/vehicles/${vehicleId}/state`, USER);
  ok('state has evSocPct VALID + effectiveVentilation UNKNOWN', st.body.metrics.evSocPct?.quality === 'VALID' && st.body.derived.effectiveVentilation === 'UNKNOWN', st.body.derived);
  ok('stale stateRevision → 422', (await call('POST', `/sleep-sessions/${sid}/preflight`, USER, { stateRevision: 0 })).status === 422);
  const pf2 = await call('POST', `/sleep-sessions/${sid}/preflight`, USER, { stateRevision: st.body.revision });
  ok('preflight READY with WARN only (CO unmeasured, hvac write denied in MOCK)', pf2.body.readiness === 'READY' && pf2.body.blockers.every((b: any) => b.severity === 'WARN'), pf2.body.blockers);
  const pp1 = await call('POST', '/power-plans', USER, { vehicleId, tripId: trip.body.id, nightHours: 9, people: 2, targetTempC: 20, outsideTempC: 4, returnDistanceKm: 45 });
  ok('power-plan with SOC 72% → OK/MARGINAL', ['OK', 'MARGINAL'].includes(pp1.body.verdict), pp1.body);
  ok('sensor upload after preflight (revision bump)', (await call('POST', '/demo/scenarios', CAR, { vehicleId, sessionId: sid, scenario: 'DOORS_SECURED' })).status === 201);
  const start = await call('POST', `/sleep-sessions/${sid}/start`, USER, { preflightId: pf2.body.preflightId, planVersion: 1, userConfirmed: true, userActionId: 'ua2' });
  ok('session ACTIVE', start.status === 200 && start.body.status === 'ACTIVE', start.body);
  ok('start again → 422 (one ACTIVE per vehicle)', (await call('POST', `/sleep-sessions/${sid}/start`, USER, { preflightId: pf2.body.preflightId, planVersion: 1, userConfirmed: true, userActionId: 'ua2b' })).status === 422);

  console.log('\n[11] 명령 상태기계 + allowlist');
  st = await call('GET', `/vehicles/${vehicleId}/state`, USER);
  const expires = new Date(Date.now() + 30_000).toISOString();
  const cmdReal = await call('POST', `/vehicles/${vehicleId}/commands`, USER, { sessionId: sid, action: { type: 'SET_CLIMATE_TARGET', targetTempC: 20, areaId: 'ROW_1_LEFT' }, expectedStateRevision: st.body.revision, capabilityRevision: 1, expiresAt: expires, userActionId: 'ua3', executionMode: 'REAL' }, idem());
  ok('REAL allowlist empty → 422', cmdReal.status === 422, cmdReal.body);
  const cmdEmu = await call('POST', `/vehicles/${vehicleId}/commands`, USER, { sessionId: sid, action: { type: 'SET_CLIMATE_TARGET', targetTempC: 20, areaId: 'ROW_1_LEFT' }, expectedStateRevision: st.body.revision, capabilityRevision: 1, expiresAt: expires, userActionId: 'ua3', executionMode: 'PLEOS_EMULATOR' }, idem());
  ok('EMULATOR with writeAllowed=false → 422', cmdEmu.status === 422, cmdEmu.body);
  const cmd = await call('POST', `/vehicles/${vehicleId}/commands`, USER, { sessionId: sid, action: { type: 'REQUEST_FRESH_AIR', fanLevel: 3 }, expectedStateRevision: st.body.revision, capabilityRevision: 1, expiresAt: expires, userActionId: 'ua4', executionMode: 'MOCK' }, idem());
  ok('MOCK command DISPATCHED', cmd.status === 202 && cmd.body.status === 'DISPATCHED', cmd.body);
  ok('command field type checked → 400', (await call('POST', `/vehicles/${vehicleId}/commands`, USER, { sessionId: sid, action: { type: 'SET_CLIMATE_TARGET', targetTempC: 'abc', areaId: 'ROW_1_LEFT' }, expectedStateRevision: st.body.revision, capabilityRevision: 1, expiresAt: expires, userActionId: 'ua4b', executionMode: 'MOCK' }, idem())).status === 400);
  ok('older expectedStateRevision still accepted', (await call('POST', `/vehicles/${vehicleId}/commands`, USER, { sessionId: sid, action: { type: 'REQUEST_FRESH_AIR', fanLevel: 2 }, expectedStateRevision: st.body.revision - 1, capabilityRevision: 1, expiresAt: expires, userActionId: 'ua4c', executionMode: 'MOCK' }, idem())).status === 202);
  const cid = cmd.body.commandId;
  ok('illegal transition DISPATCHED→VERIFIED → 422', (await call('POST', `/commands/${cid}/results`, CAR, { status: 'VERIFIED', attemptNo: 1 })).status === 422);
  ok('ACCEPTED', (await call('POST', `/commands/${cid}/results`, CAR, { status: 'ACCEPTED', attemptNo: 1 })).body.status === 'ACCEPTED');
  let g = await call('GET', `/commands/${cid}`, USER);
  ok('accepted ≠ verified', g.body.status === 'ACCEPTED' && g.body.verified === false);
  ok('VERIFIED with observed', (await call('POST', `/commands/${cid}/results`, CAR, { status: 'VERIFIED', attemptNo: 2, observed: { 'fan.level': 3, 'recirculation.state': 'FRESH' } })).body.status === 'VERIFIED');
  ok('duplicate VERIFIED result is idempotent', (await call('POST', `/commands/${cid}/results`, CAR, { status: 'VERIFIED', attemptNo: 2 })).body.duplicate === true);
  ok('user cannot post results → 403', (await call('POST', `/commands/${cid}/results`, USER, { status: 'FAILED', attemptNo: 3 })).status === 403);

  console.log('\n[12] 경보: CO2 상승 → ALERT_RAISED → ack; 센서 단절');
  ok('demo CO2_RISE', (await call('POST', '/demo/scenarios', CAR, { vehicleId, sessionId: sid, scenario: 'CO2_RISE' })).status === 201);
  await sleep(700);
  let alerts = await call('GET', `/sleep-sessions/${sid}/alerts`, USER);
  const co2 = alerts.body.find((a: any) => a.kind === 'CO2_HIGH');
  ok('CO2_HIGH raised (MOCK)', !!co2 && co2.executionMode === 'MOCK', alerts.body.map((a: any) => a.kind));
  ok('receipt DISPLAYED is technical only', (await call('POST', '/delivery-receipts', USER, { eventId: co2.id, stage: 'DISPLAYED', channel: 'WSS', time: new Date().toISOString() })).body.note?.includes('technical'));
  const ackA = await call('POST', `/alerts/${co2.id}/acknowledgements`, USER, { action: 'OK' });
  ok('user ack → ACKED', ackA.body.status === 'ACKED');
  ok('demo CO_DETECTED', (await call('POST', '/demo/scenarios', CAR, { vehicleId, sessionId: sid, scenario: 'CO_DETECTED' })).status === 201);
  await sleep(500);
  alerts = await call('GET', `/sleep-sessions/${sid}/alerts`, USER);
  ok('CO_DETECTED CRITICAL raised', alerts.body.some((a: any) => a.kind === 'CO_DETECTED' && a.severity === 'CRITICAL'));
  ok('ACCESS_DETECTED non-MOCK → 422', (await call('POST', '/alerts', CAR, { sessionId: sid, kind: 'ACCESS_DETECTED', severity: 'WARNING', sourceEventId: 'acc-1', evidence: {}, executionMode: 'PLEOS_EMULATOR' })).status === 422);
  const acc = await call('POST', '/alerts', CAR, { sessionId: sid, kind: 'ACCESS_DETECTED', severity: 'WARNING', sourceEventId: 'acc-2', evidence: { zone: 'REAR', dwellSec: 14 }, executionMode: 'MOCK' });
  ok('ACCESS_DETECTED MOCK ok', acc.status === 201);
  ok('same sourceEventId dedup', (await call('POST', '/alerts', CAR, { sessionId: sid, kind: 'ACCESS_DETECTED', severity: 'WARNING', sourceEventId: 'acc-2', evidence: {}, executionMode: 'MOCK' })).body.duplicate === true);
  await sleep(900);
  const accEvt = events.find((e) => e.type === 'ALERT_RAISED' && e.payload.kind === 'ACCESS_DETECTED');
  ok('WSS ACCESS alert carries 30s user timeout + demo flag', accEvt?.payload.userResponseTimeoutSec === 30 && accEvt?.payload.demo === true, accEvt?.payload);
  const coEvt = events.find((e) => e.type === 'ALERT_RAISED' && e.payload.kind === 'CO_DETECTED');
  ok('WSS CO alert has 0s timeout (immediate)', coEvt?.payload.userResponseTimeoutSec === 0);

  console.log('\n[13] 연락처·문자(사용자 명시 요청만)');
  const cv = (await call('GET', '/emergency-contacts', USER)).body.version as number;
  const c0 = await call('PUT', '/emergency-contacts', USER, { expectedVersion: cv, contacts: [{ name: '엄마', phone: '010-1234-5678' }] });
  ok('contacts saved, phone masked', c0.status === 200 && c0.body.contacts[0].maskedPhone.includes('*'), c0.body);
  const c1 = await call('PUT', '/emergency-contacts', USER, { expectedVersion: c0.body.version, contacts: [{ id: c0.body.contacts[0].id, name: '어머니' }] });
  ok('rename without phone keeps number', c1.status === 200 && c1.body.contacts[0].maskedPhone === c0.body.contacts[0].maskedPhone, c1.body);
  ok('new contact without phone → 400', (await call('PUT', '/emergency-contacts', USER, { expectedVersion: c1.body.version, contacts: [{ name: '친구' }] })).status === 400);
  ok('contacts stale version → 409', (await call('PUT', '/emergency-contacts', USER, { expectedVersion: cv, contacts: [] })).status === 409);
  const sms = await call('POST', `/alerts/${acc.body.alertId}/contact-notifications`, USER, { recipients: [c1.body.contacts[0].id], template: 'ACCESS_HELP', userActionId: 'ua5' }, idem());
  ok('sms job 202', sms.status === 202, sms.body);
  ok('sms rate-limited within 5min → 429', (await call('POST', `/alerts/${acc.body.alertId}/contact-notifications`, USER, { recipients: [c1.body.contacts[0].id], template: 'ACCESS_HELP', userActionId: 'ua6' }, idem())).status === 429);

  const s1 = await call('POST', `/vehicles/${vehicleId}/sensor-tokens`, USER);
  const s2 = await call('POST', `/vehicles/${vehicleId}/sensor-tokens`, USER);
  ok('sensor token reissue revokes previous → 401', (await call('POST', `/vehicles/${vehicleId}/telemetry-batches`, s1.body.deviceToken, {})).status === 401 && (await call('POST', `/vehicles/${vehicleId}/telemetry-batches`, s2.body.deviceToken, {})).status !== 401);

  console.log('\n[14] 센서 단절 (15초 대기)');
  ok('demo SENSOR_DROP', (await call('POST', '/demo/scenarios', CAR, { vehicleId, sessionId: sid, scenario: 'SENSOR_DROP' })).status === 201);
  await sleep(21_000);
  alerts = await call('GET', `/sleep-sessions/${sid}/alerts`, USER);
  ok('SENSOR_DISCONNECTED raised', alerts.body.some((a: any) => a.kind === 'SENSOR_DISCONNECTED'), alerts.body.map((a: any) => a.kind));
  st = await call('GET', `/vehicles/${vehicleId}/state`, USER);
  ok('co2 now STALE/UNKNOWN, not VALID', st.body.metrics.co2Ppm?.quality !== 'VALID', st.body.metrics.co2Ppm);

  console.log('\n[15] stop + summary');
  const stop = await call('POST', `/sleep-sessions/${sid}/stop`, USER, { reason: 'USER_STOP' });
  ok('STOPPED', stop.body.status === 'STOPPED');
  const sum = await call('GET', `/sleep-sessions/${sid}/summary`, USER);
  ok('summary marks missing coverage, not normal', sum.status === 200 && sum.body.coverage.coPpm !== '연속 기록' && sum.body.disclaimer, sum.body.coverage);
  const review = await call('POST', '/reviews', USER, { tripId: trip.body.id, rating: 4, text: '조용했음' });
  ok('review PRIVATE by default', review.body.visibility === 'PRIVATE');
  ok('second review same trip → 409', (await call('POST', '/reviews', USER, { tripId: trip.body.id, rating: 5, text: '또' })).status === 409);

  console.log('\n[16] WSS 이벤트 수신 확인');
  const types = new Set(events.map((e) => e.type));
  ok('received STATE_SNAPSHOT/COMMAND_DISPATCH/ALERT_RAISED/TRIP_SYNCED', ['STATE_SNAPSHOT', 'COMMAND_DISPATCH', 'ALERT_RAISED', 'TRIP_SYNCED'].every((t) => types.has(t)), [...types]);
  ws.close();

  console.log('\n[17] 링크 해제 → 장치 토큰 폐기');
  const link = cf.body.linkId;
  ok('unlink 204', (await call('DELETE', `/vehicle-links/${link}`, USER)).status === 204);
  ok('car token now 401', (await call('GET', `/vehicles/${vehicleId}/state`, CAR)).status === 401);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
