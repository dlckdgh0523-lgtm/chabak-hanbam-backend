import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ApiError, notFound } from '../common/errors';
import { DevicePrincipal, UserPrincipal } from '../auth/principal';
import { TokenService } from '../auth/token.service';
import { EventsService } from '../events/events.service';
import { consumeSmsQuota } from '../common/sms-quota';

/** 연락처 at-rest 암호화. 키는 DEVICE_TOKEN_PEPPER 파생(시연용). 운영은 KMS 로 교체. */
@Injectable()
export class AccountService {
  private readonly log = new Logger(AccountService.name);
  private readonly key: Buffer;

  constructor(private readonly prisma: PrismaService, private readonly cfg: ConfigService, private readonly tokens: TokenService, private readonly events: EventsService) {
    this.key = createHash('sha256').update('contacts:' + cfg.getOrThrow('DEVICE_TOKEN_PEPPER')).digest();
  }

  private enc(plain: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv.toString('base64url'), ct.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
  }
  private dec(blob: string) {
    const [iv, ct, tag] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
  private mask(phone: string) {
    const digits = phone.replace(/\D/g, '');
    let keep = Math.max(0, digits.length - 4), i = 0;
    return phone.replace(/\d/g, (c) => (i++ < keep ? '*' : c));
  }

  listConsents(userId: string) {
    return this.prisma.consentEvent.findMany({ where: { userId }, orderBy: { occurredAt: 'desc' }, take: 200 });
  }
  recordConsent(userId: string, dto: { purpose: string; version: string; decision: 'GRANTED' | 'DENIED' | 'WITHDRAWN'; deviceId?: string }) {
    // append-only. 철회도 새 이벤트.
    return this.prisma.consentEvent.create({ data: { userId, purpose: dto.purpose, policyVersion: dto.version, decision: dto.decision, deviceId: dto.deviceId } });
  }

  async getContacts(userId: string) {
    const [u, rows] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { contactsVersion: true } }),
      this.prisma.emergencyContact.findMany({ where: { userId }, orderBy: { priority: 'asc' } }),
    ]);
    return { version: u.contactsVersion, contacts: rows.map((r) => ({ id: r.id, priority: r.priority, name: this.dec(r.nameEncrypted), maskedPhone: this.mask(this.dec(r.phoneEncrypted)) })) };
  }

  async putContacts(userId: string, contacts: { id?: string; name: string; phone?: string }[], expectedVersion: number) {
    const version = expectedVersion + 1;
    await this.prisma.$transaction(async (tx) => {
      await this.prisma.lock(tx, `contacts:${userId}`);
      const u = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { contactsVersion: true } });
      if (u.contactsVersion !== expectedVersion) throw new ApiError('VERSION_CONFLICT', `expectedVersion ${expectedVersion} != ${u.contactsVersion}`);
      const old = new Set((await tx.emergencyContact.findMany({ where: { userId }, select: { id: true } })).map((r) => r.id));
      // 기존 id 는 유지(SMS 기록의 contact:<id> 가 끊기지 않게), 모르는 id 는 새 연락처로 본다
      const keep = contacts.map((c) => (c.id && old.has(c.id) ? c.id : undefined));
      if (new Set(keep.filter(Boolean)).size !== keep.filter(Boolean).length) throw new ApiError('VALIDATION_FAILED', 'duplicate contact id');
      if (contacts.some((c, i) => !keep[i] && c.phone === undefined)) throw new ApiError('VALIDATION_FAILED', 'phone required for new contact');
      await tx.emergencyContact.deleteMany({ where: { userId, id: { notIn: keep.filter((k): k is string => !!k) } } });
      // (userId, priority) unique 를 피해 순서를 바꾸려고 먼저 음수로 옮긴다
      for (let i = 0; i < keep.length; i++) if (keep[i]) await tx.emergencyContact.update({ where: { id: keep[i] }, data: { priority: -(i + 1) } });
      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        const data = { priority: i + 1, nameEncrypted: this.enc(c.name), version, ...(c.phone !== undefined ? { phoneEncrypted: this.enc(c.phone) } : {}) };
        if (keep[i]) await tx.emergencyContact.update({ where: { id: keep[i] }, data });
        else await tx.emergencyContact.create({ data: { ...data, userId, phoneEncrypted: this.enc(c.phone!) } });
      }
      await tx.user.update({ where: { id: userId }, data: { contactsVersion: version } });
    });
    return this.getContacts(userId);
  }

  async testSms(userId: string, contactId: string, userActionId: string) {
    const c = await this.prisma.emergencyContact.findFirst({ where: { id: contactId, userId } });
    if (!c) throw notFound('contact');
    await this.prisma.$transaction((tx) => consumeSmsQuota(this.prisma, tx, userId, 1));
    const jobId = randomUUID();
    const provider = this.cfg.get('SMS_PROVIDER') ?? 'log';
    // 공급자 접수 ≠ 수신자 읽음 (명세 7.2). log 공급자는 접수만 흉내.
    this.log.log(`[SMS:${provider}] test job=${jobId} to=${this.mask(this.dec(c.phoneEncrypted))} userActionId=${userActionId}`);
    return { jobId, provider, stage: 'ACCEPTED_BY_PROVIDER', note: 'provider acceptance is not delivery' };
  }

  async registerPushToken(p: UserPrincipal | DevicePrincipal, token: string, platform: string) {
    const pushTokenEncrypted = this.enc(token);
    if (p.kind === 'DEVICE') {
      await this.prisma.device.update({ where: { id: p.deviceId }, data: { pushTokenEncrypted, pushPlatform: platform } });
      return { deviceId: p.deviceId };
    }
    // 폰: 토큰 해시로 같은 장치 재등록 구분
    const h = createHash('sha256').update(token).digest('hex').slice(0, 32);
    const existing = await this.prisma.device.findFirst({ where: { userId: p.userId, type: 'PHONE', displayName: `phone:${h}` } });
    const d = existing
      ? await this.prisma.device.update({ where: { id: existing.id }, data: { pushTokenEncrypted, pushPlatform: platform, lastSeenAt: new Date() } })
      : await this.prisma.device.create({ data: { userId: p.userId, type: 'PHONE', displayName: `phone:${h}`, pushTokenEncrypted, pushPlatform: platform, lastSeenAt: new Date() } });
    return { deviceId: d.id };
  }

  /** 폰 센서 역할용 장치 토큰 발급 (scope=sensor). 텔레메트리 업로드는 이 토큰으로. */
  async issueSensorToken(p: UserPrincipal, vehicleId: string) {
    const link = await this.prisma.vehicleLink.findFirst({ where: { userId: p.userId, vehicleId, status: 'ACTIVE' } });
    if (!link) throw notFound('vehicle');
    const t = this.tokens.newDeviceToken();
    const d = await this.prisma.$transaction(async (tx) => {
      await this.prisma.lock(tx, vehicleId);
      if (await tx.sleepSession.findFirst({ where: { vehicleId, status: 'ACTIVE' }, select: { id: true } })) throw new ApiError('PRECONDITION_FAILED', 'sleep session ACTIVE; stop it before replacing the sensor');
      // 차량당 센서 1대: 다른 사용자가 발급한 센서도 폐기 (명세 4.3.2)
      const old = await tx.vehicleLink.findMany({ where: { vehicleId, status: 'ACTIVE', device: { type: 'SENSOR' } }, select: { id: true, deviceId: true } });
      if (old.length) {
        await tx.vehicleLink.updateMany({ where: { id: { in: old.map((l) => l.id) } }, data: { status: 'REVOKED', revokedAt: new Date() } });
        await tx.device.updateMany({ where: { id: { in: old.map((l) => l.deviceId) } }, data: { revokedAt: new Date(), tokenHash: null } });
      }
      const d = await tx.device.create({ data: { userId: p.userId, type: 'SENSOR', displayName: 'phone-sensor', tokenHash: t.hash } });
      await tx.vehicleLink.create({ data: { userId: p.userId, vehicleId, deviceId: d.id, role: 'PHONE_DEVICE', status: 'ACTIVE' } });
      return { d, old };
    });
    if (d.old.length) this.events.bus.emit('revoked', { principals: d.old.map((l) => `DEVICE:${l.deviceId}`) });
    return { deviceId: d.d.id, deviceToken: t.raw, scope: 'sensor' as const };
  }

  async requestDeletion(userId: string, reauth: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.authSubject !== `dev:${reauth}`) throw new ApiError('UNAUTHENTICATED', 'reauthentication failed');
    const revoked = await this.prisma.$transaction(async (tx) => {
      const linked = await tx.vehicleLink.findMany({ where: { userId, status: 'ACTIVE' }, select: { deviceId: true } });
      await tx.user.update({ where: { id: userId }, data: { deletionRequestedAt: new Date() } });
      await tx.vehicleLink.updateMany({ where: { userId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
      // 같은 차를 쓰는 다른 사용자가 끊기지 않도록 차량 장치는 남은 ACTIVE 연결이 없을 때만 폐기
      const orphanCars = [];
      for (const id of new Set(linked.map((l) => l.deviceId))) if ((await tx.vehicleLink.count({ where: { deviceId: id, status: 'ACTIVE' } })) === 0) orphanCars.push(id);
      const devices = await tx.device.findMany({ where: { OR: [{ userId, type: { not: 'CAR' } }, { id: { in: orphanCars } }] }, select: { id: true } });
      await tx.device.updateMany({ where: { id: { in: devices.map((d) => d.id) } }, data: { revokedAt: new Date(), tokenHash: null, pushTokenEncrypted: null } });
      await tx.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
      await tx.emergencyContact.deleteMany({ where: { userId } });
      return devices;
    });
    this.events.bus.emit('revoked', { principals: [`USER:${userId}`, ...revoked.map((d) => `DEVICE:${d.id}`)] });
    return { status: 'DELETION_SCHEDULED', retention: 'summaries purged after retention window (policy TBD)' };
  }
}
