import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';
import { createConfig } from '../testing/helpers';

// 2.3 요청 인증, scope, 토큰 — 토큰 생성·해시 부분
// [이 파일의 의도]
// 토큰 생성/검증/해시. 다른 서비스 테스트들이 "해시만 저장" 을 확인할 때 이 해시 함수를 기준으로 쓴다.
describe('TokenService', () => {
  const tokens = new TokenService(new JwtService(), createConfig());

  // 의도: dvt_ 접두어로 guard 가 JWT 와 장치 토큰을 구분한다. 32바이트 랜덤이라 추측할 수 없어야 한다.
  it('2.3.4 장치 토큰은 dvt_ 로 시작하는 랜덤 값이고 매번 다르다', () => {
    const a = tokens.newDeviceToken();
    const b = tokens.newDeviceToken();
    expect(a.raw).toMatch(/^dvt_[A-Za-z0-9_-]{43}$/);
    expect(a.raw).not.toBe(b.raw);
    expect(tokens.isDeviceToken(a.raw)).toBe(true);
  });

  // 의도: 같은 원문은 항상 같은 해시가 나와야 DB 에서 찾을 수 있고, 저장 값에 원문이 들어 있으면 안 된다.
  it('2.3.4 서버가 저장하는 값은 원문이 아니라 HMAC 해시이고, 같은 원문은 같은 해시가 된다', () => {
    const t = tokens.newDeviceToken();
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.hash).not.toContain(t.raw);
    expect(tokens.hash(t.raw)).toBe(t.hash);
  });

  // 의도: pepper 는 DB 밖(환경변수)에 있다. DB 만 유출되면 해시로 원문을 맞춰볼 수 없게 하는 장치다.
  it('2.3.4 pepper 가 다르면 해시도 달라진다 (DB 만 유출돼도 원문을 맞춰볼 수 없음)', () => {
    const other = new TokenService(new JwtService(), createConfig({ DEVICE_TOKEN_PEPPER: 'other' }));
    expect(other.hash('dvt_same')).not.toBe(tokens.hash('dvt_same'));
  });

  // 의도: refresh 토큰을 Authorization 헤더에 넣어도 장치 토큰으로 오인되어 DB 조회되지 않게.
  it('2.3.4 refresh 토큰은 rft_ 로 시작하고 장치 토큰으로 취급하지 않는다', () => {
    const r = tokens.newRefreshToken();
    expect(r.raw).toMatch(/^rft_/);
    expect(tokens.isDeviceToken(r.raw)).toBe(false);
  });

  // 의도: scope 에 따라 호출 가능한 API 가 갈린다. PHONE 도 sensor 로 매핑된다는 점이 의도된 것인지 눈여겨볼 것.
  it('2.3.5 자동차 장치는 vehicle, 센서/폰 장치는 sensor scope 를 갖는다', () => {
    expect(tokens.scopeForDevice('CAR')).toBe('vehicle');
    expect(tokens.scopeForDevice('SENSOR')).toBe('sensor');
    expect(tokens.scopeForDevice('PHONE')).toBe('sensor');
  });

  // 의도: 서명을 검증하지 않으면 누구나 sub 를 바꿔 다른 사용자가 될 수 있다.
  it('2.3.5 사용자 access 토큰은 scope=user 이고, 다른 비밀키로 서명된 토큰은 거부한다', () => {
    const jwt = tokens.signUserAccess('user-1');
    expect(tokens.verifyUserAccess(jwt)).toMatchObject({ sub: 'user-1', scope: 'user' });

    const forged = new TokenService(new JwtService(), createConfig({ JWT_USER_SECRET: 'attacker' })).signUserAccess('user-1');
    expect(tokens.verifyUserAccess(forged)).toBeNull();
    expect(tokens.verifyUserAccess('not-a-jwt')).toBeNull();
  });

  // 의도: access 토큰은 짧게 쓰고 refresh 로 갱신한다. 만료된 토큰이 통과하면 탈취된 토큰을 계속 쓸 수 있다.
  it('2.3.1 만료된 사용자 토큰은 거부한다', () => {
    const short = new TokenService(new JwtService(), createConfig({ JWT_USER_TTL_SEC: '-10' }));
    expect(tokens.verifyUserAccess(short.signUserAccess('user-1'))).toBeNull();
  });
});
