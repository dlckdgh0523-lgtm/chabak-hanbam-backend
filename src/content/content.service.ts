import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../auth/access.service';
import { ApiError, notFound } from '../common/errors';
import { Principal, UserPrincipal } from '../auth/principal';
import { PLACE_FIXTURES, REVIEW_FIXTURES, weatherFixture } from './fixtures';
import { sunrise } from './sun';

const POWER_MODEL_VERSION = 'heuristic-v0.2'; // 임시 계산식 아님을 가장하지 않는다 — 가정과 범위를 전부 노출

@Injectable()
export class ContentService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService, private readonly access: AccessService) {}

  async onModuleInit() {
    for (const f of PLACE_FIXTURES) {
      await this.prisma.place.upsert({ where: { providerId: f.providerId }, create: { ...f, meta: f.meta }, update: {} });
    }
  }

  async search(q?: string, lat?: number, lng?: number, cursor?: string) {
    const rows = await this.prisma.place.findMany({
      where: { ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}), ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' }, take: 21,
    });
    const scored = rows.slice(0, 20).map((p) => ({ ...p, distanceKm: lat !== undefined && lng !== undefined ? haversine(lat, lng, p.lat, p.lng) : null }));
    if (lat !== undefined) scored.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
    return { provider: 'fixture', places: scored, nextCursor: rows.length > 20 ? rows[19].id : null };
  }

  async briefing(id: string) {
    const p = await this.prisma.place.findUnique({ where: { id } });
    if (!p) throw notFound('place');
    const demoReviews = REVIEW_FIXTURES[p.providerId] ?? [];
    const userReviews = await this.prisma.review.findMany({ where: { placeId: id, visibility: 'PUBLIC' }, orderBy: { createdAt: 'desc' }, take: 10 });
    const date = new Date().toISOString().slice(0, 10);
    return {
      place: { id: p.id, name: p.name, lat: p.lat, lng: p.lng, meta: p.meta },
      permits: { camping: p.campingStatus, cooking: p.cookingStatus, source: p.sourceUrl ?? 'UNVERIFIED', verifiedAt: p.verifiedAt, note: 'UNKNOWN 은 허용이 아니다' },
      reviews: { summary: demoReviews.length ? `DEMO 후기 ${demoReviews.length}건` : '후기 없음', items: [...userReviews.map((r) => ({ rating: r.rating, text: r.text, at: r.createdAt, source: 'USER' })), ...demoReviews.map((r) => ({ ...r, source: 'DEMO' }))] },
      weather: weatherFixture(p.lat, p.lng, date, 'Asia/Seoul'),
      sun: sunrise(p.lat, p.lng, date, 'Asia/Seoul'),
      generatedAt: new Date().toISOString(),
      uncertainty: ['허가 상태 출처 미검증', '후기는 DEMO fixture', '기상은 fixture'],
    };
  }

  async alternatives(id: string, rank: string[], require: string[], maxExtraMin: number) {
    const origin = await this.prisma.place.findUnique({ where: { id } });
    if (!origin) throw notFound('place');
    const all = await this.prisma.place.findMany({ where: { id: { not: id } } });
    const rejected: { id: string; name: string; reason: string }[] = [];
    const candidates = all.filter((p) => {
      const extraMin = (haversine(origin.lat, origin.lng, p.lat, p.lng) / 40) * 60; // 40km/h 가정
      if (extraMin > maxExtraMin) { rejected.push({ id: p.id, name: p.name, reason: `추가 ${Math.round(extraMin)}분 > ${maxExtraMin}` }); return false; }
      // 필수 필터: UNKNOWN 을 허용으로 처리 금지
      if (require.includes('camping') && p.campingStatus !== 'ALLOWED') { rejected.push({ id: p.id, name: p.name, reason: `camping=${p.campingStatus}` }); return false; }
      if (require.includes('cooking') && p.cookingStatus !== 'ALLOWED') { rejected.push({ id: p.id, name: p.name, reason: `cooking=${p.cookingStatus}` }); return false; }
      return true;
    });
    // 우선 정렬: 필터와 분리 (D4)
    const score = (p: (typeof all)[number]) => rank.reduce((s, k, i) => {
      const m = (p.meta ?? {}) as Record<string, unknown>;
      const w = rank.length - i;
      if (k === 'toilet' && m.toilet === true) s += w;
      if (k === 'ev' && m.ev === true) s += w;
      return s;
    }, 0);
    candidates.sort((a, b) => score(b) - score(a));
    return { origin: origin.name, rank, require, candidates: candidates.map((p) => ({ id: p.id, name: p.name, campingStatus: p.campingStatus, cookingStatus: p.cookingStatus, meta: p.meta, score: score(p) })), rejected, note: candidates.length === 0 ? '조건을 만족하는 후보 0개 — 그대로 반환' : undefined };
  }

  weatherNight(lat: number, lng: number, date: string, tz: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(lat) || Number.isNaN(lng)) throw new ApiError('VALIDATION_FAILED', 'lat,lng,date(YYYY-MM-DD) required');
    return weatherFixture(lat, lng, date, tz);
  }

  sun(lat: number, lng: number, date: string, tz: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(lat) || Number.isNaN(lng)) throw new ApiError('VALIDATION_FAILED', 'lat,lng,date(YYYY-MM-DD) required');
    return sunrise(lat, lng, date, tz);
  }

  async powerPlan(p: Principal, dto: { vehicleId: string; tripId?: string; nightHours: number; people: number; targetTempC?: number; outsideTempC?: number; returnDistanceKm: number; batteryKwh?: number }) {
    await this.access.assertVehicle(p, dto.vehicleId);
    const batteryKwh = dto.batteryKwh ?? 77.4;
    const heatOn = dto.targetTempC !== undefined;
    const delta = heatOn ? Math.max(0, (dto.targetTempC ?? 20) - (dto.outsideTempC ?? 5)) : 0;
    // 가정: 히트펌프 난방 0.3~0.9 kW/h (온도차 비례), 대기 0.2~0.4 kW/h, 귀가 소비 0.18~0.22 kWh/km
    const heatMin = delta * 0.03 * dto.nightHours, heatMax = delta * 0.06 * dto.nightHours;
    const idleMin = 0.2 * dto.nightHours, idleMax = 0.4 * dto.nightHours;
    const reserveKwh = dto.returnDistanceKm * 0.22 + batteryKwh * 0.1; // 귀가 + 10% 여유
    const estimateMinKwh = round(heatMin + idleMin), estimateMaxKwh = round(heatMax + idleMax);
    const soc = await this.prisma.vehicleStateCache.findUnique({ where: { vehicleId: dto.vehicleId } });
    const socObs = (soc?.metrics as Record<string, { value: unknown; quality: string }> | null)?.['evSocPct'];
    const socPct = socObs?.quality === 'VALID' && typeof socObs.value === 'number' ? socObs.value : null;
    const availableKwh = socPct !== null ? round((socPct / 100) * batteryKwh - reserveKwh) : null;
    const plan = await this.prisma.powerPlan.create({
      data: {
        tripId: dto.tripId, inputs: dto, assumptions: { batteryKwh, heatKwPerDegHour: [0.03, 0.06], idleKwPerHour: [0.2, 0.4], returnKwhPerKm: 0.22, reservePct: 10 },
        estimateMinKwh, estimateMaxKwh, reserveKwh: round(reserveKwh), confidence: socPct === null ? 'LOW' : 'MEDIUM', modelVersion: POWER_MODEL_VERSION, expiresAt: new Date(Date.now() + 6 * 3600_000),
      },
    });
    return {
      planId: plan.id, estimateMinKwh, estimateMaxKwh, reserveKwh: plan.reserveKwh, socPct, availableKwh,
      verdict: availableKwh === null ? 'SOC_UNVERIFIED' : availableKwh >= estimateMaxKwh ? 'OK' : availableKwh >= estimateMinKwh ? 'MARGINAL' : 'INSUFFICIENT',
      assumptions: plan.assumptions, modelVersion: POWER_MODEL_VERSION, confidence: plan.confidence, expiresAt: plan.expiresAt,
      note: '충전소 가용성은 별도 데이터. 12V 방전은 이 추정에 포함되지 않음.',
    };
  }

  async createReview(p: UserPrincipal, dto: { tripId: string; rating: number; text: string }) {
    const t = await this.access.assertTrip(p, dto.tripId);
    // 밤 기록 자동 공개 금지 → PRIVATE 기본
    return this.prisma.review.create({ data: { userId: p.userId, tripId: t.id, placeId: t.placeId, rating: dto.rating, text: dto.text } });
  }

  async patchReview(p: UserPrincipal, id: string, dto: { text: string; expectedVersion: number }) {
    const r = await this.prisma.review.updateMany({ where: { id, userId: p.userId, version: dto.expectedVersion }, data: { text: dto.text, version: { increment: 1 } } });
    if (r.count !== 1) throw new ApiError('VERSION_CONFLICT', 'review version stale or not yours');
    return this.prisma.review.findUniqueOrThrow({ where: { id } });
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371, dLat = ((lat2 - lat1) * Math.PI) / 180, dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
