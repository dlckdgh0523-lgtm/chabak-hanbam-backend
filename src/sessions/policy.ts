import { Observation, isUsable } from '../common/freshness';

/**
 * 서버 쪽 preflight 규칙. 차량 로컬 LocalPolicyEngine 이 실행 직전 다시 검사한다(명세 7.4).
 * 여기서 READY 라고 해도 차량이 재검증에 실패하면 시작되지 않는다.
 */
export interface Blocker { code: string; message: string; severity: 'BLOCK' | 'WARN' }

export interface PreflightInput {
  powertrain: string;
  connection: 'ONLINE' | 'OFFLINE';
  metrics: Record<string, Observation>;
  plan: { heatEnabled: boolean; targetTempC: number | null };
  capabilities: { feature: string; supported: boolean | null; writeAllowed: boolean; min?: number; max?: number }[];
  consents: Set<string>;
  executionMode: string;
}

function checkSecured(metrics: Record<string, Observation>, prefix: string, ok: (v: unknown) => boolean, label: string): Blocker[] {
  const all = metrics[`${prefix}.all`];
  if (all) {
    if (!isUsable(all)) return [{ code: `${prefix}.all.UNVERIFIED`, message: `${prefix} 상태 미확인 (값 없음/오래됨)`, severity: 'BLOCK' }];
    return ok(all.value) ? [] : [{ code: `${prefix}.all.NOT_SECURED`, message: `${prefix}=${String(all.value)} — 취침 전 수동 ${label} 후 재확인`, severity: 'BLOCK' }];
  }
  const areas = Object.entries(metrics).filter(([k]) => k.startsWith(prefix + '.') && k !== `${prefix}.all`);
  if (areas.length === 0) return [{ code: `${prefix}.all.UNVERIFIED`, message: `${prefix} 관측 없음`, severity: 'BLOCK' }];
  const out: Blocker[] = [];
  for (const [k, o] of areas) {
    if (!isUsable(o)) out.push({ code: `${k}.UNVERIFIED`, message: `${k} 미확인`, severity: 'BLOCK' });
    else if (!ok(o.value)) out.push({ code: `${k}.NOT_SECURED`, message: `${k}=${String(o.value)} — ${label} 아님`, severity: 'BLOCK' });
  }
  return out;
}

export function evaluatePreflight(i: PreflightInput): { readiness: 'READY' | 'BLOCKED'; blockers: Blocker[] } {
  const b: Blocker[] = [];

  // D14: ICE 와 엔진 자동 시동 가능한 HEV/PHEV 는 자동 취침 제어 범위 제외
  if (['ICE', 'HEV', 'PHEV'].includes(i.powertrain)) b.push({ code: 'POWERTRAIN_EXCLUDED', message: `${i.powertrain} 차량은 자동 취침 제어 대상이 아닙니다 (배기가스/엔진 자동 가동 위험)`, severity: 'BLOCK' });
  if (i.powertrain === 'UNKNOWN') b.push({ code: 'POWERTRAIN_UNKNOWN', message: '파워트레인 미확인 — EV 라도 자동 통과하지 않습니다', severity: 'BLOCK' });

  if (i.connection !== 'ONLINE') b.push({ code: 'VEHICLE_OFFLINE', message: '차량 연결 없음', severity: 'BLOCK' });

  // 필수 상태 미확인이면 자동 관리 진입 차단 (D6: 잠금과 닫힘 구분, 미지원은 미확인)
  // 집계값(doorLock.all='LOCKED' / window.all='CLOSED') 또는 영역별 값(doorLock.<area>=true, window.<area>=0) 둘 다 허용.
  // ⚠ window 0=닫힘 은 Pleos Window 범위(0..10 보고됨)에서의 추정 — 스윕 결과로 확정 전까지 가정.
  b.push(...checkSecured(i.metrics, 'doorLock', (v) => v === 'LOCKED' || v === true, '잠금'));
  b.push(...checkSecured(i.metrics, 'window', (v) => v === 'CLOSED' || v === 0, '닫힘'));

  // CO 는 CO₂ 로 추론 금지. 센서 없으면 '미측정' 경고(차단은 아님 — 측정 자체가 선택 장비)
  if (!isUsable(i.metrics['coPpm'])) b.push({ code: 'CO_UNMEASURED', message: 'CO 미측정 — 독립 CO 경보기 필요. CO₂ 측정기는 대체품이 아님', severity: 'WARN' });
  if (!isUsable(i.metrics['co2Ppm'])) b.push({ code: 'CO2_UNMEASURED', message: 'CO₂ 센서 없음/끊김 — 환기 경보 불가', severity: 'WARN' });

  // 배터리: 구동/12V 구분
  const soc = i.metrics['evSocPct'];
  if (!isUsable(soc)) b.push({ code: 'SOC_UNVERIFIED', message: '구동 배터리 SOC 미확인', severity: 'BLOCK' });
  else if (typeof soc.value === 'number' && soc.value < 30) b.push({ code: 'SOC_LOW', message: `SOC ${soc.value}% — 귀가 예비량 미달 가능`, severity: 'BLOCK' });
  if (!isUsable(i.metrics['batt12vVolt'])) b.push({ code: 'BATT12V_UNVERIFIED', message: '12V 데이터 없음 — 미확인', severity: 'WARN' });

  // 난방 목표: UI 14~24 와 capability min/max 교집합
  if (i.plan.heatEnabled && i.plan.targetTempC !== null) {
    const cap = i.capabilities.find((c) => c.feature === 'hvac.temperature');
    if (!cap || cap.supported !== true) b.push({ code: 'HVAC_UNSUPPORTED', message: 'hvac.temperature capability 미확인', severity: 'BLOCK' });
    else {
      if (!cap.writeAllowed) b.push({ code: 'HVAC_WRITE_DENIED', message: '공조 제어 권한 없음 — 난방은 사용자 수동 설정 + 읽기 확인으로 대체', severity: i.executionMode === 'MOCK' ? 'WARN' : 'BLOCK' });
      if (cap.min !== undefined && cap.max !== undefined && (i.plan.targetTempC < cap.min || i.plan.targetTempC > cap.max))
        b.push({ code: 'HVAC_RANGE', message: `목표 ${i.plan.targetTempC}℃ 가 차량 범위 ${cap.min}~${cap.max} 밖`, severity: 'BLOCK' });
    }
  }

  if (!i.consents.has('VEHICLE_STATE')) b.push({ code: 'CONSENT_VEHICLE_STATE', message: '차량 상태 조회 동의 없음', severity: 'BLOCK' });

  return { readiness: b.some((x) => x.severity === 'BLOCK') ? 'BLOCKED' : 'READY', blockers: b };
}

/** 경보 규칙 (서버 측, 보조). 차량 로컬 경보가 1차. */
export const ALERT_RULES = {
  co2WarnPpm: 2000,
  co2CriticalPpm: 3500,
  coWarnPpm: 30,
  coCriticalPpm: 70,
};
