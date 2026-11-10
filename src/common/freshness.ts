import { Quality, Source } from '@prisma/client';

export interface Observation<T = unknown> {
  value: T | null;
  unit: string;
  source: Source;
  sourceDeviceId: string;
  observedAt: string;
  receivedAt: string;
  quality: Quality;
  seq: number;
  bootId: string;
}

/** 유효기간이 지난 값은 경보 해제·자동 제어 판단에 쓰지 않는다 (명세 9장). */
export function withFreshness<T>(obs: Observation<T>, staleAfterMs: number, now = Date.now()): Observation<T> {
  if (obs.quality === 'INVALID' || obs.value === null) return { ...obs, quality: obs.value === null ? 'UNKNOWN' : obs.quality };
  const age = now - Date.parse(obs.observedAt);
  return age > staleAfterMs ? { ...obs, quality: 'STALE' } : obs;
}

export const isUsable = (o: Observation | undefined | null): boolean => !!o && o.quality === 'VALID' && o.value !== null;
