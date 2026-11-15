import { evaluatePreflight, PreflightInput } from './policy';
import { Observation } from '../common/freshness';

const ok = (value: unknown, quality: Observation['quality'] = 'VALID'): Observation => ({
  value, unit: 'x', source: 'PLEOS', sourceDeviceId: 'car-1', observedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), quality, seq: 1, bootId: 'b',
});

/** 모든 규칙을 통과하는 기본 입력. 테스트마다 하나씩 바꿔서 그 규칙만 확인한다. */
const base = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  powertrain: 'EV',
  connection: 'ONLINE',
  metrics: {
    'doorLock.all': ok('LOCKED'), 'window.all': ok('CLOSED'),
    evSocPct: ok(50), batt12vVolt: ok(12.6), coPpm: ok(0), co2Ppm: ok(800),
  },
  plan: { heatEnabled: false, targetTempC: null },
  capabilities: [],
  consents: new Set(['VEHICLE_STATE']),
  executionMode: 'PLEOS_EMULATOR',
  ...over,
});
const withMetrics = (patch: Record<string, Observation | undefined>) => {
  const m = { ...base().metrics, ...patch } as Record<string, Observation | undefined>;
  for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
  return m as Record<string, Observation>;
};
const codes = (i: PreflightInput) => evaluatePreflight(i).blockers.map((b) => `${b.severity}:${b.code}`);

// 7.2.4 안전 규칙
// [이 파일의 의도]
// preflight 안전 규칙. base() 는 모든 규칙을 통과하는 입력이고, 각 테스트는 값 하나만 바꿔서 "그 규칙만" 확인한다.
// 그래서 결과가 정확히 그 blocker 하나여야 한다(다른 규칙이 같이 걸리면 테스트가 무엇을 보는지 흐려진다).
describe('evaluatePreflight (7.2.4 안전 규칙)', () => {
  // 의도: 기준 입력이 정말 READY 여야 아래 테스트들이 "규칙 하나만" 검사한다는 게 보장된다.
  it('모든 조건을 만족하면 READY 이고 blocker 가 없다', () => {
    expect(evaluatePreflight(base())).toEqual({ readiness: 'READY', blockers: [] });
  });

  // 의도: WARN 은 알려주기만 하고 시작은 막지 않는다. BLOCK 은 하나만 있어도 시작하지 않는다.
  it('4. BLOCK 이 하나라도 있으면 BLOCKED, WARN 만 있으면 READY', () => {
    expect(evaluatePreflight(base({ connection: 'OFFLINE' })).readiness).toBe('BLOCKED');
    const warnOnly = evaluatePreflight(base({ metrics: withMetrics({ coPpm: undefined }) }));
    expect(warnOnly.readiness).toBe('READY');
    expect(warnOnly.blockers).toHaveLength(1);
  });

  describe('1. 차량', () => {
    // 의도: 엔진이 있는 차는 자동으로 시동이 걸릴 수 있어, 밀폐된 차 안에서 배기가스(CO) 중독 위험이 있다.
    it.each(['ICE', 'HEV', 'PHEV'])('파워트레인이 %s 면 BLOCK (POWERTRAIN_EXCLUDED)', (pt) => {
      expect(codes(base({ powertrain: pt }))).toEqual(['BLOCK:POWERTRAIN_EXCLUDED']);
    });
    // 의도: 모르는 차량을 EV 라고 가정하지 않는다.
    it('파워트레인이 UNKNOWN 이면 BLOCK (POWERTRAIN_UNKNOWN)', () => {
      expect(codes(base({ powertrain: 'UNKNOWN' }))).toEqual(['BLOCK:POWERTRAIN_UNKNOWN']);
    });
    // 의도: 서버가 차량 상태를 모르는 채 시작하면 차량은 계획을 받지도 못한다.
    it('차량이 OFFLINE 이면 BLOCK (VEHICLE_OFFLINE)', () => {
      expect(codes(base({ connection: 'OFFLINE' }))).toEqual(['BLOCK:VEHICLE_OFFLINE']);
    });
  });

  describe('2. 문, 창문', () => {
    // 의도: 자는 동안 외부 침입 위험.
    it('doorLock.all 이 LOCKED 가 아니면 BLOCK (NOT_SECURED)', () => {
      expect(codes(base({ metrics: withMetrics({ 'doorLock.all': ok('UNLOCKED') }) }))).toEqual(['BLOCK:doorLock.all.NOT_SECURED']);
    });
    // 의도: 오래전에 "잠김"이었다는 건 지금 잠김이라는 뜻이 아니다.
    it('doorLock.all 값이 오래되면(STALE) BLOCK (UNVERIFIED)', () => {
      expect(codes(base({ metrics: withMetrics({ 'doorLock.all': ok('LOCKED', 'STALE') }) }))).toEqual(['BLOCK:doorLock.all.UNVERIFIED']);
    });
    // 의도: 미지원 = 미확인. 확인할 수 없으면 안전하다고 보지 않는다.
    it('문 값이 아예 없으면 BLOCK (UNVERIFIED)', () => {
      expect(codes(base({ metrics: withMetrics({ 'doorLock.all': undefined }) }))).toEqual(['BLOCK:doorLock.all.UNVERIFIED']);
    });
    // 의도: 어느 문이 문제인지 알려줘야 사용자가 그 문만 잠그고 다시 확인할 수 있다.
    it('집계값이 없으면 영역별 값을 본다: 하나라도 잠김이 아니면 그 영역만 BLOCK', () => {
      const metrics = withMetrics({ 'doorLock.all': undefined, 'doorLock.driver': ok(true), 'doorLock.rear': ok(false) });
      expect(codes(base({ metrics }))).toEqual(['BLOCK:doorLock.rear.NOT_SECURED']);
    });
    // 의도: true 와 LOCKED 두 표현을 모두 잠김으로 인정한다.
    it('영역별 문 값이 모두 잠김이면 통과', () => {
      const metrics = withMetrics({ 'doorLock.all': undefined, 'doorLock.driver': ok(true), 'doorLock.rear': ok('LOCKED') });
      expect(codes(base({ metrics }))).toEqual([]);
    });
    // 의도: 창문이 열린 채 자면 침입과 추위 위험.
    it('window.all 이 CLOSED 가 아니면 BLOCK', () => {
      expect(codes(base({ metrics: withMetrics({ 'window.all': ok('OPEN') }) }))).toEqual(['BLOCK:window.all.NOT_SECURED']);
    });
    // 의도: 0 = 닫힘. 열린 창문과 오래된 값을 구분해서 알려준다.
    it('영역별 창문 값이 0 이 아니면 BLOCK, 오래된 값이면 UNVERIFIED', () => {
      const metrics = withMetrics({ 'window.all': undefined, 'window.fl': ok(0), 'window.fr': ok(3), 'window.rl': ok(0, 'STALE') });
      expect(codes(base({ metrics }))).toEqual(['BLOCK:window.fr.NOT_SECURED', 'BLOCK:window.rl.UNVERIFIED']);
    });
  });

  describe('3. 배터리', () => {
    // 의도: 밤새 난방 후 배터리가 바닥나면 난방이 멈추고 귀가도 못 한다. 모르면 시작하지 않는다.
    it('SOC 를 확인할 수 없으면 BLOCK (SOC_UNVERIFIED)', () => {
      expect(codes(base({ metrics: withMetrics({ evSocPct: undefined }) }))).toEqual(['BLOCK:SOC_UNVERIFIED']);
      expect(codes(base({ metrics: withMetrics({ evSocPct: ok(null, 'UNKNOWN') }) }))).toEqual(['BLOCK:SOC_UNVERIFIED']);
    });
    // 의도: 경계값: 30% 는 통과, 29.9% 는 차단.
    it('SOC 30% 미만이면 BLOCK (SOC_LOW), 30% 는 통과', () => {
      expect(codes(base({ metrics: withMetrics({ evSocPct: ok(29.9) }) }))).toEqual(['BLOCK:SOC_LOW']);
      expect(codes(base({ metrics: withMetrics({ evSocPct: ok(30) }) }))).toEqual([]);
    });
    // 의도: 12V 가 방전되면 시동이 안 걸리지만, 12V 를 못 읽는 차량이 많아 경고만 한다.
    it('12V 배터리 값이 없으면 WARN (BATT12V_UNVERIFIED)', () => {
      expect(codes(base({ metrics: withMetrics({ batt12vVolt: undefined }) }))).toEqual(['WARN:BATT12V_UNVERIFIED']);
    });
  });

  describe('4. 공기질 센서', () => {
    // 의도: CO₂ 가 정상이어도 CO 는 다른 원인으로 생길 수 있다. CO₂ 측정기는 CO 경보기를 대신하지 못한다.
    //       센서는 선택 장비라 차단이 아니라 경고다.
    it('CO 값이 없으면 WARN (CO_UNMEASURED) — CO₂ 가 있어도 CO 를 추론하지 않는다', () => {
      expect(codes(base({ metrics: withMetrics({ coPpm: undefined }) }))).toEqual(['WARN:CO_UNMEASURED']);
    });
    // 의도: CO₂ 센서가 없으면 환기 경보를 줄 수 없다는 것을 사용자가 알아야 한다.
    it('CO₂ 값이 없으면 WARN (CO2_UNMEASURED)', () => {
      expect(codes(base({ metrics: withMetrics({ co2Ppm: undefined }) }))).toEqual(['WARN:CO2_UNMEASURED']);
    });
  });

  describe('5. 공조(난방)', () => {
    const heat = { heatEnabled: true, targetTempC: 20 };
    const hvac = (over = {}) => [{ feature: 'hvac.temperature', supported: true, writeAllowed: true, min: 16, max: 28, ...over }];

    // 의도: 난방 계획인데 차량이 온도 제어를 못 하면 밤에 추위에 노출된다.
    it('난방을 켰는데 hvac.temperature 기능이 없거나 지원되지 않으면 BLOCK (HVAC_UNSUPPORTED)', () => {
      expect(codes(base({ plan: heat, capabilities: [] }))).toEqual(['BLOCK:HVAC_UNSUPPORTED']);
      expect(codes(base({ plan: heat, capabilities: hvac({ supported: null }) }))).toEqual(['BLOCK:HVAC_UNSUPPORTED']);
    });
    // 의도: 데모(MOCK)에서는 시연을 위해 경고만, 실제 모드에서는 난방을 할 수 없으므로 차단.
    it('난방을 켰는데 쓰기 권한이 없으면 MOCK 은 WARN, 그 외는 BLOCK (HVAC_WRITE_DENIED)', () => {
      expect(codes(base({ plan: heat, capabilities: hvac({ writeAllowed: false }), executionMode: 'MOCK' }))).toEqual(['WARN:HVAC_WRITE_DENIED']);
      expect(codes(base({ plan: heat, capabilities: hvac({ writeAllowed: false }), executionMode: 'PLEOS_EMULATOR' }))).toEqual(['BLOCK:HVAC_WRITE_DENIED']);
    });
    // 의도: 차량이 지원하지 않는 온도를 계획하면 실행 단계에서 실패한다. 경계값(min, max)은 통과.
    it('목표 온도가 차량 기능 min~max 밖이면 BLOCK (HVAC_RANGE), 경계값은 통과', () => {
      expect(codes(base({ plan: { heatEnabled: true, targetTempC: 15 }, capabilities: hvac() }))).toEqual(['BLOCK:HVAC_RANGE']);
      expect(codes(base({ plan: { heatEnabled: true, targetTempC: 16 }, capabilities: hvac() }))).toEqual([]);
      expect(codes(base({ plan: { heatEnabled: true, targetTempC: 28 }, capabilities: hvac() }))).toEqual([]);
    });
    // 의도: 난방을 안 쓰는 사람까지 공조 기능 때문에 막히면 안 된다.
    it('난방을 끄면 공조 기능을 검사하지 않는다', () => {
      expect(codes(base({ plan: { heatEnabled: false, targetTempC: 20 }, capabilities: [] }))).toEqual([]);
    });
  });

  describe('6. 동의', () => {
    // 의도: 동의 없이 차량 상태를 밤새 수집하면 안 된다.
    it('VEHICLE_STATE 동의가 없으면 BLOCK (CONSENT_VEHICLE_STATE)', () => {
      expect(codes(base({ consents: new Set(['LOCATION']) }))).toEqual(['BLOCK:CONSENT_VEHICLE_STATE']);
    });
  });
});
