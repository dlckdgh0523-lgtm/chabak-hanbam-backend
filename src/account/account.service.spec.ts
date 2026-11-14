import { JwtService } from '@nestjs/jwt';
import { AccountService } from './account.service';
import { TokenService } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';
import { carPrincipal, createConfig, createPrismaMock, expectApiError, PrismaMock, userPrincipal } from '../testing/helpers';

type ContactRow = { id: string; userId: string; priority: number; nameEncrypted: string; phoneEncrypted: string; version: number };

// [이 파일의 의도]
// 계정, 동의, 비상연락처, 푸시/센서 토큰, 계정 삭제.
// 개인정보(연락처, 푸시 토큰)는 암호화, 인증 토큰은 해시 — 푸시 토큰은 보낼 때 원문이 필요해서 해시가 아니라 암호화다.
describe('AccountService', () => {
  let prisma: PrismaMock;
  let tokens: TokenService;
  let service: AccountService;
  let contacts: ContactRow[];

  beforeEach(() => {
    prisma = createPrismaMock();
    const cfg = createConfig();
    tokens = new TokenService(new JwtService(), cfg);
    service = new AccountService(prisma as unknown as PrismaService, cfg, tokens);

    // 비상연락처는 암호화 → 복호화까지 확인하려고 메모리 저장소로 흉내낸다
    contacts = [];
    let seq = 0;
    prisma.emergencyContact.findMany.mockImplementation(async ({ where }) =>
      contacts.filter((c) => c.userId === where.userId && (!where.id || where.id.in.includes(c.id))).sort((a, b) => a.priority - b.priority),
    );
    prisma.emergencyContact.deleteMany.mockImplementation(async ({ where }) => {
      contacts = contacts.filter((c) => c.userId !== where.userId);
    });
    prisma.emergencyContact.create.mockImplementation(async ({ data }) => {
      const row = { id: `c-${++seq}`, ...data };
      contacts.push(row);
      return row;
    });
    prisma.emergencyContact.findFirst.mockImplementation(async ({ where }) => contacts.find((c) => c.id === where.id && c.userId === where.userId) ?? null);
  });

  // ── 4.1 동의 ─────────────────────────────────────────────────
  describe('4.1 동의', () => {
    // 의도: "언제 어떤 정책 버전에 동의/철회했는지"가 증빙이다. 덮어쓰면 이력이 사라진다.
    it('1. 동의 기록은 덮어쓰지 않고 새 기록으로 추가한다 (append-only)', async () => {
      await service.recordConsent('user-1', { purpose: 'LOCATION', version: 'v1', decision: 'GRANTED' });

      expect(prisma.consentEvent.create).toHaveBeenCalledWith({ data: { userId: 'user-1', purpose: 'LOCATION', policyVersion: 'v1', decision: 'GRANTED', deviceId: undefined } });
      expect(prisma.consentEvent.update).not.toHaveBeenCalled();
      expect(prisma.consentEvent.upsert).not.toHaveBeenCalled();
    });

    // 의도: 철회도 하나의 기록이다. 마지막 결정이 유효한 동의가 된다(preflight 테스트에서 확인).
    it('2. 동의를 철회해도 새 기록으로 추가한다', async () => {
      await service.recordConsent('user-1', { purpose: 'LOCATION', version: 'v1', decision: 'GRANTED' });
      await service.recordConsent('user-1', { purpose: 'LOCATION', version: 'v1', decision: 'WITHDRAWN' });
      expect(prisma.consentEvent.create).toHaveBeenCalledTimes(2);
      expect(prisma.consentEvent.create.mock.calls[1][0].data.decision).toBe('WITHDRAWN');
    });

    // 의도: 한 번에 너무 많이 내려주지 않게 상한을 둔다.
    it('동의 목록은 최신순으로 최대 200건이다', async () => {
      await service.listConsents('user-1');
      expect(prisma.consentEvent.findMany).toHaveBeenCalledWith({ where: { userId: 'user-1' }, orderBy: { occurredAt: 'desc' }, take: 200 });
    });
  });

  // ── 4.2 비상연락처 ───────────────────────────────────────────
  describe('4.2.1 연락처 저장 putContacts', () => {
    const two = [{ name: '엄마', phone: '010-1234-5678' }, { name: '아빠', phone: '+821098765432' }];

    // 의도: 비상연락처는 사용자 본인이 아닌 제3자의 개인정보다. DB 유출 시에도 읽히지 않아야 한다.
    it('1. 이름과 번호는 암호화해서 저장한다', async () => {
      await service.putContacts('user-1', two, 0);
      const raw = JSON.stringify(contacts);
      expect(raw).not.toContain('엄마');
      expect(raw).not.toContain('010-1234-5678');
      expect(raw).not.toContain('821098765432');
    });

    // 의도: 부분 수정이 아니라 전체 교체라서, 화면에서 지운 연락처가 서버에 남지 않는다.
    it('2. 연락처 전체를 교체한다 (기존 것을 지우고 새로 만든다)', async () => {
      await service.putContacts('user-1', two, 0);
      const res = await service.putContacts('user-1', [{ name: '친구', phone: '01011112222' }], 1);

      expect(res.contacts).toHaveLength(1);
      expect(res.contacts[0].name).toBe('친구');
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    // 의도: 다음 저장 때 expectedVersion 으로 쓸 값이다.
    it('2. 성공하면 버전이 1 오른다', async () => {
      expect((await service.putContacts('user-1', two, 0)).version).toBe(1);
      expect((await service.putContacts('user-1', two, 1)).version).toBe(2);
    });

    // 의도: 두 기기에서 동시에 수정하면 나중에 저장한 쪽이 앞의 수정을 모르고 덮어쓴다(낙관적 락으로 방지).
    it('2. expectedVersion 이 현재 버전과 다르면 409 이고 아무것도 바꾸지 않는다', async () => {
      await service.putContacts('user-1', two, 0);
      await expectApiError(service.putContacts('user-1', [], 0), 'VERSION_CONFLICT', 409);
      expect(contacts).toHaveLength(2);
    });

    // 의도: 위급 시 SMS 를 보낼 순서다.
    it('3. 입력한 배열 순서대로 우선순위(1부터)가 된다', async () => {
      const res = await service.putContacts('user-1', two, 0);
      expect(res.contacts.map((c) => [c.priority, c.name])).toEqual([[1, '엄마'], [2, '아빠']]);
    });
  });

  describe('4.2.2 연락처 조회 getContacts', () => {
    // 의도: 첫 저장은 expectedVersion 0 으로 한다는 약속의 근거.
    it('1. 저장된 연락처가 없으면 버전 0 과 빈 목록이다', async () => {
      await expect(service.getContacts('user-1')).resolves.toEqual({ version: 0, contacts: [] });
    });

    // 의도: 조회 응답·화면·로그에 전체 번호가 노출되지 않게.
    it('2. 전화번호는 마지막 4자리만 보여준다 (하이픈 등 형식은 유지)', async () => {
      await service.putContacts('user-1', [{ name: '엄마', phone: '010-1234-5678' }, { name: '아빠', phone: '+821098765432' }], 0);
      const res = await service.getContacts('user-1');
      expect(res.contacts[0].phoneMasked).toBe('***-****-5678');
      expect(res.contacts[1].phoneMasked).toBe('+********5432');
      expect(JSON.stringify(res)).not.toContain('1234');
    });

    // 의도: 연락처 조회가 userId 로 제한되는지.
    it('다른 사용자의 연락처는 보이지 않는다', async () => {
      await service.putContacts('user-1', [{ name: '엄마', phone: '01012345678' }], 0);
      await expect(service.getContacts('user-2')).resolves.toEqual({ version: 0, contacts: [] });
    });
  });

  describe('4.2.3 테스트 SMS testSms', () => {
    // 의도: 남의 연락처 ID 로 테스트 SMS 를 보내면 스팸 발송 통로가 된다.
    it('1. 본인 연락처가 아니면 404', async () => {
      await service.putContacts('user-1', [{ name: '엄마', phone: '01012345678' }], 0);
      await expectApiError(service.testSms('user-2', contacts[0].id, 'act-1'), 'NOT_FOUND', 404);
    });

    // 의도: "접수됨"을 "전달됨"으로 보여주면 사용자는 가족이 문자를 받았다고 오해한다.
    it('3. 공급자가 접수한 것일 뿐 수신 확인이 아님을 응답에 표시한다', async () => {
      await service.putContacts('user-1', [{ name: '엄마', phone: '01012345678' }], 0);
      const res = await service.testSms('user-1', contacts[0].id, 'act-1');
      expect(res).toMatchObject({ jobId: expect.any(String), stage: 'ACCEPTED_BY_PROVIDER', note: expect.stringContaining('not delivery') });
    });
  });

  // ── 4.3 푸시 토큰, 센서 토큰 ─────────────────────────────────
  describe('4.3.1 푸시 토큰 등록 registerPushToken', () => {
    const PUSH = 'fcm-token-abcdefghijk';

    // 의도: 서버가 폰에 경보 푸시를 보내려면 그 폰이 장치로 등록되어 있어야 한다.
    it('1. 사용자 토큰이면 폰 장치를 새로 만든다', async () => {
      prisma.device.findFirst.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue({ id: 'phone-1' });

      await expect(service.registerPushToken(userPrincipal('user-1'), PUSH, 'ANDROID')).resolves.toEqual({ deviceId: 'phone-1' });
      expect(prisma.device.create.mock.calls[0][0].data).toMatchObject({ userId: 'user-1', type: 'PHONE', pushPlatform: 'ANDROID' });
    });

    // 의도: 앱은 켤 때마다 등록한다. 같은 폰이 장치 여러 개로 쌓이면 같은 경보가 여러 번 온다.
    it('1. 같은 푸시 토큰이면 같은 장치로 보고 갱신한다', async () => {
      prisma.device.findFirst.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue({ id: 'phone-1' });
      await service.registerPushToken(userPrincipal('user-1'), PUSH, 'ANDROID');
      const firstLookup = prisma.device.findFirst.mock.calls[0][0].where;

      prisma.device.findFirst.mockResolvedValue({ id: 'phone-1' });
      prisma.device.update.mockResolvedValue({ id: 'phone-1' });
      await expect(service.registerPushToken(userPrincipal('user-1'), PUSH, 'IOS')).resolves.toEqual({ deviceId: 'phone-1' });

      expect(prisma.device.findFirst.mock.calls[1][0].where).toEqual(firstLookup);
      expect(prisma.device.create).toHaveBeenCalledTimes(1);
      expect(prisma.device.update.mock.calls[0][0]).toMatchObject({ where: { id: 'phone-1' }, data: { pushPlatform: 'IOS' } });
    });

    // 의도: 차량 앱도 푸시를 받는다. 새 장치를 만들지 않고 자기 장치에 붙인다.
    it('2. 자동차 장치 토큰이면 그 장치에 저장한다', async () => {
      await expect(service.registerPushToken(carPrincipal('car-1'), PUSH, 'ANDROID')).resolves.toEqual({ deviceId: 'car-1' });
      expect(prisma.device.update.mock.calls[0][0].where).toEqual({ id: 'car-1' });
      expect(prisma.device.create).not.toHaveBeenCalled();
    });

    // 의도: 푸시 토큰이 있으면 그 기기로 알림을 보낼 수 있다. 유출되면 가짜 경보를 보낼 수 있으므로 암호화한다.
    it('3. 푸시 토큰은 암호화해서 저장한다', async () => {
      await service.registerPushToken(carPrincipal('car-1'), PUSH, 'ANDROID');
      prisma.device.findFirst.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue({ id: 'phone-1' });
      await service.registerPushToken(userPrincipal(), PUSH, 'ANDROID');

      const stored = [prisma.device.update.mock.calls[0][0].data, prisma.device.create.mock.calls[0][0].data];
      for (const d of stored) {
        expect(d.pushTokenEncrypted).toEqual(expect.any(String));
        expect(JSON.stringify(d)).not.toContain(PUSH);
      }
    });
  });

  describe('4.3.2 센서 토큰 발급 issueSensorToken', () => {
    // 의도: 연결되지 않은 차량에 센서를 붙여 남의 차량 상태값을 오염시키지 못하게.
    it('1. 요청한 사용자가 해당 차량에 ACTIVE 연결이 없으면 404', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue(null);
      await expectApiError(service.issueSensorToken(userPrincipal('user-1'), 'vehicle-1'), 'NOT_FOUND', 404);
      expect(prisma.vehicleLink.findFirst).toHaveBeenCalledWith({ where: { userId: 'user-1', vehicleId: 'vehicle-1', status: 'ACTIVE' } });
      expect(prisma.device.create).not.toHaveBeenCalled();
    });

    // 의도: 센서 토큰도 인증 토큰이므로 원문 저장 금지.
    it('2. SENSOR 장치를 만들고 토큰 해시만 저장한다', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.device.create.mockResolvedValue({ id: 'sensor-1' });

      const res = await service.issueSensorToken(userPrincipal('user-1'), 'vehicle-1');

      const saved = prisma.device.create.mock.calls[0][0].data;
      expect(saved).toMatchObject({ userId: 'user-1', type: 'SENSOR', tokenHash: tokens.hash(res.deviceToken) });
      expect(JSON.stringify(saved)).not.toContain(res.deviceToken);
    });

    // 의도: 센서의 차량 접근 검사는 이 연결로 이뤄진다. 원문은 이 응답 한 번뿐이다.
    it('3. PHONE_DEVICE 연결을 만들고 sensor scope 토큰 원문을 한 번만 응답한다', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.device.create.mockResolvedValue({ id: 'sensor-1' });

      const res = await service.issueSensorToken(userPrincipal('user-1'), 'vehicle-1');

      expect(res).toEqual({ deviceId: 'sensor-1', deviceToken: expect.stringMatching(/^dvt_/), scope: 'sensor' });
      expect(prisma.vehicleLink.create).toHaveBeenCalledWith({ data: { userId: 'user-1', vehicleId: 'vehicle-1', deviceId: 'sensor-1', role: 'PHONE_DEVICE', status: 'ACTIVE' } });
    });

    describe('4. 재발급 (DB 상태로 확인)', () => {
      /**
       * [센서 토큰 정책 — 데모 버전 결정]
       *  - 센서 폰은 "차량당 1대"만 ACTIVE 로 둔다. (사용자당이 아니다)
       *  - 새로 발급하면 그 차량의 기존 센서 폰(누가 발급했든)은 토큰 폐기 + 연결 REVOKED.
       *
       * [왜 1대인가]
       *  - 상태 캐시(VehicleStateCache)는 metric 별 "최신값 하나"만 가진다.
       *    센서가 2대면 A 폰의 CO 85ppm 을 B 폰의 0ppm 이 덮어써서 위험 값이 사라질 수 있다.
       *  - 경보 서비스의 단절 감지(SENSOR_DISCONNECTED)는 "vehicleId:metric" 단위라,
       *    한 대가 꺼져도 다른 대가 값을 올리면 단절 경보가 뜨지 않는다.
       *
       * [왜 차량당인가]
       *  - 위 두 문제는 "한 차량에 센서가 여러 대"일 때 생긴다. 사용자당 1대로는
       *    같은 차량에 연결된 사용자 수만큼 센서가 붙으므로 막을 수 없다.
       *
       * [테스트 방식]
       *  - device / vehicleLink 를 메모리 DB 로 흉내내고, 호출 후의 "DB 상태"만 검사한다.
       *    updateMany 로 고치든 트랜잭션 + update 로 고치든, 결과가 정책과 맞으면 통과한다.
       *  - 모든 mock 은 한 번씩 await(tick) 해서 실제 DB 왕복처럼 다른 요청이 끼어들 수 있게 했다 (4-4 동시성 검사용).
       *  - 이전 토큰이 무효인지는 "tokenHash 가 null 이거나 revokedAt 이 있음"으로 본다.
       *    auth.guard 가 tokenHash 로 장치를 찾고 revokedAt 이 있으면 401 을 주기 때문이다.
       */
      type Dev = { id: string; userId: string | null; type: string; tokenHash: string | null; revokedAt: Date | null };
      type Link = { id: string; userId: string; vehicleId: string; deviceId: string; role: string; status: string; revokedAt?: Date | null };
      let devices: Dev[];
      let links: Link[];

      const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean =>
        Object.entries(where).every(([k, v]) => {
          if (v && typeof v === 'object' && !(v instanceof Date)) {
            const cond = v as Record<string, unknown>;
            if ('in' in cond) return (cond.in as unknown[]).includes(row[k]);
            if ('not' in cond) return row[k] !== cond.not;
            if (k === 'device') return matches(devices.find((d) => d.id === row.deviceId) ?? {}, cond);
          }
          return row[k] === v;
        });
      const tick = () => new Promise((r) => setImmediate(r));

      beforeEach(() => {
        devices = [];
        links = [{ id: 'owner-link', userId: 'user-1', vehicleId: 'vehicle-1', deviceId: 'car-1', role: 'OWNER', status: 'ACTIVE' }];
        let n = 0;
        prisma.vehicleLink.findFirst.mockImplementation(async ({ where }) => { await tick(); return links.find((l) => matches(l, where)) ?? null; });
        prisma.vehicleLink.findMany.mockImplementation(async ({ where }) => { await tick(); return links.filter((l) => matches(l, where)); });
        prisma.vehicleLink.create.mockImplementation(async ({ data }) => { await tick(); const l = { id: `link-${++n}`, ...data }; links.push(l); return l; });
        prisma.vehicleLink.updateMany.mockImplementation(async ({ where, data }) => { await tick(); const rows = links.filter((l) => matches(l, where)); rows.forEach((l) => Object.assign(l, data)); return { count: rows.length }; });
        prisma.vehicleLink.update.mockImplementation(async ({ where, data }) => { await tick(); const l = links.find((x) => x.id === where.id)!; Object.assign(l, data); return l; });
        prisma.device.findMany.mockImplementation(async ({ where }) => { await tick(); return devices.filter((d) => matches(d, where)); });
        prisma.device.create.mockImplementation(async ({ data }) => { await tick(); const d = { id: `sensor-${++n}`, revokedAt: null, ...data }; devices.push(d); return d; });
        prisma.device.updateMany.mockImplementation(async ({ where, data }) => { await tick(); const rows = devices.filter((d) => matches(d, where)); rows.forEach((d) => Object.assign(d, data)); return { count: rows.length }; });
        prisma.device.update.mockImplementation(async ({ where, data }) => { await tick(); const d = devices.find((x) => x.id === where.id)!; Object.assign(d, data); return d; });
      });

      const activeSensorLinks = () => links.filter((l) => l.role === 'PHONE_DEVICE' && l.status === 'ACTIVE');

      // 같은 사용자가 재발급하는 가장 기본 경우. 폰을 바꾸거나 앱을 다시 설치했을 때다.
      // 이전 폰이 계속 값을 올리면 새 폰 값과 섞이므로, 이전 토큰은 바로 무효가 되어야 한다.
      it('4. 다시 발급하면 이전 센서 장치의 토큰을 폐기하고 연결을 REVOKED 로 바꾼다', async () => {
        const first = await service.issueSensorToken(userPrincipal('user-1'), 'vehicle-1');
        const second = await service.issueSensorToken(userPrincipal('user-1'), 'vehicle-1');

        const oldDevice = devices.find((d) => d.id === first.deviceId)!;
        const oldLink = links.find((l) => l.deviceId === first.deviceId)!;
        expect(oldLink.status).toBe('REVOKED');
        // 이전 토큰으로는 인증되지 않아야 한다 (guard 는 tokenHash 로 찾고 revokedAt 을 본다)
        expect(oldDevice.tokenHash === null || oldDevice.revokedAt !== null).toBe(true);
        expect(activeSensorLinks().map((l) => l.deviceId)).toEqual([second.deviceId]);
      });

      // 버튼 두 번 누름, 네트워크 재시도 등으로 발급 요청이 겹치는 경우.
      // "기존 센서 조회 → 폐기 → 새로 생성"을 락이나 유니크 제약 없이 하면, 두 요청이 모두 "기존 없음"을 보고
      // ACTIVE 센서가 2대 남는다. 트랜잭션 + 행 잠금 또는 (vehicleId, role=PHONE_DEVICE, status=ACTIVE) 유니크로 막아야 한다.
      it('4-4. 동시에 발급 요청이 와도 ACTIVE 센서 연결은 하나만 남는다', async () => {
        await Promise.all([
          service.issueSensorToken(userPrincipal('user-1'), 'vehicle-1'),
          service.issueSensorToken(userPrincipal('user-1'), 'vehicle-1'),
        ]);
        expect(activeSensorLinks()).toHaveLength(1);
      });

      // 4-1 결정: 차량당 센서 폰은 1대. 재발급을 여러 번 해도 ACTIVE 는 항상 1대다.
      it('4-1. 차량당 센서 폰은 한 대만 허용한다: 몇 번을 발급해도 그 차량의 ACTIVE 센서 연결은 하나다', async () => {
        for (let i = 0; i < 3; i++) await service.issueSensorToken(userPrincipal('user-1'), 'vehicle-1');
        expect(activeSensorLinks().filter((l) => l.vehicleId === 'vehicle-1')).toHaveLength(1);
      });

      // 4-2 결정: 기준은 차량당. 같은 차량에 연결된 다른 사용자(user-2)가 발급해도 user-1 의 센서가 폐기된다.
      // 다른 사람의 센서를 끊을 수 있다는 뜻이므로, 취침 중 재발급(4-3)을 어떻게 할지와 함께 봐야 한다.
      it('4-2. 한 대의 기준은 차량당이다: 같은 차량의 다른 사용자가 발급하면 기존 사용자의 센서가 폐기된다', async () => {
        links.push({ id: 'user2-link', userId: 'user-2', vehicleId: 'vehicle-1', deviceId: 'car-1', role: 'OWNER', status: 'ACTIVE' });

        const a = await service.issueSensorToken(userPrincipal('user-1'), 'vehicle-1');
        const b = await service.issueSensorToken(userPrincipal('user-2'), 'vehicle-1');

        expect(links.find((l) => l.deviceId === a.deviceId)!.status).toBe('REVOKED');
        expect(activeSensorLinks().map((l) => l.deviceId)).toEqual([b.deviceId]);
      });

      // 4-2 결정의 반대 방향 검사: 폐기 범위는 "그 차량"까지만이다.
      // 지금 코드는 아무것도 폐기하지 않아 통과하지만, 고칠 때 "그 사용자의 센서 전부 폐기"처럼
      // 범위를 넓게 잡으면 다른 차량의 감시가 끊기므로 그걸 잡아내려는 테스트다.
      it('4-2. 한 대의 기준은 차량당이다: 다른 차량의 센서 폰은 건드리지 않는다', async () => {
        links.push({ id: 'v2-owner', userId: 'user-1', vehicleId: 'vehicle-2', deviceId: 'car-2', role: 'OWNER', status: 'ACTIVE' });

        const onV2 = await service.issueSensorToken(userPrincipal('user-1'), 'vehicle-2');
        await service.issueSensorToken(userPrincipal('user-1'), 'vehicle-1');

        expect(links.find((l) => l.deviceId === onV2.deviceId)!.status).toBe('ACTIVE');
        expect(activeSensorLinks()).toHaveLength(2); // vehicle-1 에 1대, vehicle-2 에 1대
      });

      // 아래는 기대 동작이 아직 정해지지 않아 테스트로 쓸 수 없다.
      // 4-3: 차량당 1대라서 자는 중에 같은 차량의 누군가가 발급하면 감시 중인 센서가 바로 끊긴다.
      //      "ACTIVE 세션 중에는 재발급 422" 또는 "확인을 받은 뒤에만 교체" 중에 정해야 한다.
      // 4-5: 센서 폰이 하나뿐이라 그 폰이 꺼지면 CO/CO₂ 감시가 전부 멈춘다. 서버만으로는 해결되지 않는 문제다
      //      (차량 앱 경보, 사용자 안내).
      it.todo('4-3. (확인 필요) ACTIVE 세션이 있는 동안 센서 토큰 재발급을 막는가');
      it.todo('4-5. (확인 필요) 센서 폰 단절 시 차량 앱 경보로 보완하는가');
    });
  });

  // ── 4.4 계정 삭제 ────────────────────────────────────────────
  describe('4.4 계정 삭제 requestDeletion', () => {
    beforeEach(() => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: 'user-1', authSubject: 'dev:alice' });
    });

    // 의도: 잠깐 빌린 폰이나 열려 있는 앱으로 남이 계정을 삭제하지 못하게, 삭제 직전에 다시 인증한다.
    it('1. 재인증(dev:{reauth})이 맞지 않으면 401 이고 아무것도 바꾸지 않는다', async () => {
      await expectApiError(service.requestDeletion('user-1', 'bob'), 'UNAUTHENTICATED', 401);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // 의도: 일부만 처리되면 "탈퇴했는데 차량 연결·토큰은 살아 있는" 상태가 된다. 한 트랜잭션이어야 한다.
    it('2. 성공하면 삭제 요청 시각 기록, 연결 REVOKED, 장치·푸시·refresh 토큰 폐기, 연락처 삭제를 한 트랜잭션으로 한다', async () => {
      const res = await service.requestDeletion('user-1', 'alice');

      expect(res.status).toBe('DELETION_SCHEDULED');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { deletionRequestedAt: expect.any(Date) } });
      expect(prisma.vehicleLink.updateMany).toHaveBeenCalledWith({ where: { userId: 'user-1', status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: expect.any(Date) } });
      expect(prisma.device.updateMany).toHaveBeenCalledWith({ where: { userId: 'user-1' }, data: { revokedAt: expect.any(Date), tokenHash: null, pushTokenEncrypted: null } });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'user-1' }, data: { revokedAt: expect.any(Date) } });
      expect(prisma.emergencyContact.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    });

    // 의도: confirm 할 때 CAR 장치의 userId 가 그 사용자로 설정된다. 탈퇴자 이름으로 차량 앱이 계속 동작하지 않게 한다.
    //       단, 같은 차량에 연결된 다른 사용자도 차량 앱을 못 쓰게 되는 부작용이 있어 팀원 확인이 필요한 항목이다.
    it('3. 계정을 삭제하면 그 사용자가 페어링한 자동차 장치의 토큰도 폐기된다', async () => {
      await service.requestDeletion('user-1', 'alice');
      // confirm 시 CAR 장치의 userId 가 그 사용자로 설정된다 (pairing.service). userId 조건이면 CAR 장치도 포함된다.
      const { where, data } = prisma.device.updateMany.mock.calls[0][0];
      expect(where).toEqual({ userId: 'user-1' });
      expect(data).toMatchObject({ revokedAt: expect.any(Date), tokenHash: null });
    });
  });
});
