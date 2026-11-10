/** 외부 공급자 연결 전 fixture. 전부 DEMO 표시 대상. 실제 야영 허가·후기 데이터가 아니다. */
export const PLACE_FIXTURES = [
  { providerId: 'fx-001', name: '임진각 평화누리 주차장 (DEMO)', lat: 37.8894, lng: 126.7399, campingStatus: 'UNKNOWN', cookingStatus: 'PROHIBITED', sourceUrl: null, meta: { toilet: true, ev: 'UNKNOWN', surface: 'asphalt' } },
  { providerId: 'fx-002', name: '파주 마장호수 공영주차장 (DEMO)', lat: 37.7835, lng: 126.9094, campingStatus: 'CONDITIONAL', cookingStatus: 'PROHIBITED', sourceUrl: null, meta: { toilet: true, ev: true, surface: 'asphalt' } },
  { providerId: 'fx-003', name: '감악산 출렁다리 주차장 (DEMO)', lat: 37.9359, lng: 126.9697, campingStatus: 'ALLOWED', cookingStatus: 'CONDITIONAL', sourceUrl: null, meta: { toilet: true, ev: false, surface: 'gravel' } },
  { providerId: 'fx-004', name: '헤이리 예술마을 제2주차장 (DEMO)', lat: 37.7909, lng: 126.6975, campingStatus: 'PROHIBITED', cookingStatus: 'PROHIBITED', sourceUrl: null, meta: { toilet: false, ev: 'UNKNOWN', surface: 'asphalt' } },
  { providerId: 'fx-005', name: '오두산 통일전망대 주차장 (DEMO)', lat: 37.7768, lng: 126.6821, campingStatus: 'UNKNOWN', cookingStatus: 'UNKNOWN', sourceUrl: null, meta: { toilet: true, ev: 'UNKNOWN', surface: 'asphalt' } },
] as const;

export const REVIEW_FIXTURES: Record<string, { rating: number; text: string; at: string }[]> = {
  'fx-002': [{ rating: 4, text: 'DEMO 후기 — 화장실 깨끗, 밤에 조용함', at: '2026-10-12T21:00:00+09:00' }, { rating: 3, text: 'DEMO 후기 — 가로등이 밝아서 가림막 필요', at: '2026-09-30T20:00:00+09:00' }],
  'fx-003': [{ rating: 5, text: 'DEMO 후기 — 일출 방향 탁 트임', at: '2026-10-20T07:00:00+09:00' }],
};

export function weatherFixture(lat: number, lng: number, date: string, timezone: string) {
  const issuedAt = new Date().toISOString();
  return {
    provider: 'fixture',
    issuedAt,
    timezone,
    location: { lat, lng },
    night: { date, minTempC: 4, maxTempC: 11, precipProbPct: 70, windMs: 6, summary: 'DEMO: 밤사이 비, 새벽 기온 4℃' },
    advisories: [
      { id: 'fixture-heavy-rain-1', kind: 'HEAVY_RAIN_WATCH', region: '경기북부', issuedAt, validFrom: `${date}T21:00:00+09:00`, validTo: `${date}T23:59:00+09:00`, text: 'DEMO 호우주의보 — 특보 ≠ 해당 주차장 침수 감지' },
    ],
    note: 'fixture 데이터. 기상청 연결 전.',
  };
}
