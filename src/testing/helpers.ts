/**
 * 단위 테스트 공통 헬퍼.
 * Spring 의 Mockito 처럼, 서비스 생성자에 mock 을 직접 넣어서 테스트한다 (DB 없이 실행).
 */
import { ConfigService } from '@nestjs/config';
import { ApiError, ErrorCode } from '../common/errors';
import { DevicePrincipal, UserPrincipal } from '../auth/principal';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ModelMock = Record<string, jest.Mock>;
export type PrismaMock = Record<string, ModelMock> & { $transaction: jest.Mock; lock: jest.Mock };

/**
 * prisma.<model>.<method> 를 처음 접근할 때 jest.fn() 을 만들어 준다.
 * 예) prisma.user.findUnique.mockResolvedValue({...})
 * $transaction 은 콜백형이면 같은 mock 을 tx 로 넘기고, 배열형이면 Promise.all 로 실행한다.
 */
export function createPrismaMock(): PrismaMock {
  const models = new Map<string, ModelMock>();
  const target: any = {};
  const prisma: any = new Proxy(target, {
    get(_t, key: string | symbol) {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      if (key === '$transaction') return transaction;
      if (key === 'lock') return lock;
      if (key === 'runExclusive') return runExclusive;
      if (!models.has(key)) {
        models.set(
          key,
          new Proxy({} as ModelMock, {
            get(m, method: string | symbol) {
              if (typeof method === 'symbol' || method === 'then') return undefined;
              return (m[method] ??= jest.fn());
            },
          }),
        );
      }
      return models.get(key);
    },
  });
  // PrismaService.lock(tx, key) = pg_advisory_xact_lock: 같은 key 는 트랜잭션이 끝날 때까지 직렬화한다
  const held = new Map<string, Promise<void>>();
  const releases = new WeakMap<object, (() => void)[]>();
  const lock = jest.fn(async (tx: object, key: string) => {
    const prev = held.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    held.set(key, prev.then(() => mine));
    const list = releases.get(tx);
    if (list) list.push(release); else release();
    await prev;
  });
  const runExclusive = jest.fn(async (_key: string, fn: () => Promise<unknown>) => { await fn(); }); // 단일 인스턴스: 항상 잡힌다
  const transaction = jest.fn(async (arg: unknown) => {
    if (typeof arg !== 'function') return Promise.all(arg as unknown[]);
    const tx = new Proxy(prisma, {}); // 트랜잭션마다 다른 tx (같은 mock 을 가리킴)
    releases.set(tx, []);
    try {
      return await (arg as (tx: unknown) => unknown)(tx);
    } finally {
      releases.get(tx)!.forEach((r) => r());
    }
  });
  return prisma as PrismaMock;
}

export function createConfig(values: Record<string, string | undefined> = {}): ConfigService {
  const all: Record<string, string | undefined> = {
    JWT_USER_SECRET: 'test-jwt-secret',
    DEVICE_TOKEN_PEPPER: 'test-pepper',
    VEHICLE_ENROLL_SECRET: 'enroll-secret',
    ...values,
  };
  return {
    get: (k: string) => all[k],
    getOrThrow: (k: string) => {
      if (all[k] === undefined) throw new Error(`missing config ${k}`);
      return all[k];
    },
  } as unknown as ConfigService;
}

export function createEventsMock() {
  return { publish: jest.fn(), bus: { emit: jest.fn(), on: jest.fn() } };
}

export function createAccessMock() {
  return {
    assertVehicle: jest.fn().mockResolvedValue({ id: 'link-1', userId: 'user-1', deviceId: 'car-1' }),
    vehicleIdForCarDevice: jest.fn().mockResolvedValue('vehicle-1'),
    assertSession: jest.fn(),
    assertTrip: jest.fn(),
  };
}

export const userPrincipal = (userId = 'user-1'): UserPrincipal => ({ kind: 'USER', id: userId, userId, scopes: ['user'] });

export const carPrincipal = (deviceId = 'car-1', userId: string | null = null): DevicePrincipal => ({
  kind: 'DEVICE', id: deviceId, deviceId, deviceType: 'CAR', userId, scopes: ['vehicle'],
});

export const sensorPrincipal = (deviceId = 'sensor-1', userId: string | null = 'user-1'): DevicePrincipal => ({
  kind: 'DEVICE', id: deviceId, deviceId, deviceType: 'SENSOR', userId, scopes: ['sensor'],
});

/** ApiError 의 code 와 HTTP 상태를 같이 확인한다. */
export async function expectApiError(promise: Promise<unknown> | (() => unknown), code: ErrorCode, status?: number) {
  let err: unknown;
  let result: unknown;
  try {
    result = await (typeof promise === 'function' ? promise() : promise);
  } catch (e) {
    err = e;
  }
  if (err === undefined) {
    throw new Error(`요구사항 위반: ${code}${status ? ` (${status})` : ''} 에러가 나야 하는데 정상 처리됨. 응답: ${JSON.stringify(result)?.slice(0, 200)}`);
  }
  if (!(err instanceof ApiError)) {
    throw new Error(`요구사항 위반: ${code}${status ? ` (${status})` : ''} 에러가 나야 하는데 다른 예외가 남: ${String(err)}`);
  }
  expect((err as ApiError).code).toBe(code);
  if (status !== undefined) expect((err as ApiError).getStatus()).toBe(status);
  return err as ApiError;
}

/** production 환경에서만 도는 테스트용 */
export async function inProduction<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = prev;
  }
}

export const P2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
