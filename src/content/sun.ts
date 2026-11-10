/**
 * 일출 시각·방위각 — NOAA 근사식 구현 (라이브러리 의존 없음). 오차 ±2분 수준.
 * 일출이 없는 날짜(극지방)는 null.
 */
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function sunrise(lat: number, lng: number, dateIso: string, timezone: string) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const jd = julianDay(y, m, d) + 0.5; // 정오 기준 JD
  const n = jd - 2451545.0 + 0.0008;
  const jStar = n - lng / 360;
  const M = ((357.5291 + 0.98560028 * jStar) % 360 + 360) % 360;
  const C = 1.9148 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 0.0003 * Math.sin(rad(3 * M));
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(rad(M)) - 0.0069 * Math.sin(rad(2 * lambda));
  const delta = Math.asin(Math.sin(rad(lambda)) * Math.sin(rad(23.4397)));
  const cosOmega = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * Math.sin(delta)) / (Math.cos(rad(lat)) * Math.cos(delta));
  if (cosOmega > 1 || cosOmega < -1) return { sunriseAt: null, azimuthDeg: null, reason: 'no sunrise on this date at this latitude' };
  const omega = deg(Math.acos(cosOmega));
  const jRise = jTransit - omega / 360;
  const sunriseUtc = new Date((jRise - 2440587.5) * 86400000);
  // 방위각 (일출 시 고도≈0): cos(az) = sin(δ)/cos(φ)
  const az = deg(Math.acos(Math.sin(delta) / Math.cos(rad(lat))));
  return {
    sunriseAt: sunriseUtc.toISOString(),
    sunriseLocal: sunriseUtc.toLocaleString('sv-SE', { timeZone: timezone }),
    azimuthDeg: Math.round(az * 10) / 10,
    algorithm: 'noaa-approx-v1',
    note: '정차 GPS 진행방향은 차체 방위로 신뢰 불가. 지도·사용자 확인 필요 (S5)',
  };
}

function julianDay(y: number, m: number, d: number) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}
