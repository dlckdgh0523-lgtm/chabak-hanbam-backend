import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ApiError, notFound } from '../common/errors';
import { DevicePrincipal, UserPrincipal } from '../auth/principal';
import { TokenService } from '../auth/token.service';

/** 연락처 at-rest 암호화. 키는 DEVICE_TOKEN_PEPPER 파생(시연용). 운영은 KMS 로 교체. */
@Injectable()
export class AccountService {
  private readonly log = new Logger(AccountService.name);
  private readonly key: Buffer;

  constructor(private readonly prisma: PrismaService, private readonly cfg: ConfigService, private readonly tokens: TokenService) {
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
    const rows = await this.prisma.emergencyContact.findMany({ where: { userId }, orderBy: { priority: 'asc' } });
    const version = rows.reduce((m, r) => Math.max(m, r.version), 0);
    return { version, contacts: rows.map((r) => ({ id: r.id, priority: r.priority, name: this.dec(r.nameEncrypted), maskedPhone: this.mask(this.dec(r.phoneEncrypted)) })) };
  }

  async putContacts(userId: string, contacts: { id?: string; name: string; phone?: string }[], expectedVersion: number) {
    const current = await this.getContacts(userId);
    if (current.version !== expectedVersion) throw new ApiError('VERSION_CONFLICT', `expectedVersion ${expectedVersion} != ${current.version}`);
    const old = new Map((await this.prisma.emergencyContact.findMany({ where: { userId } })).map((r) => [r.id, r.phoneEncrypted]));
    const phones = contacts.map((c) => (c.phone !== undefined ? this.enc(c.phone) : old.get(c.id ?? '')));
    if (phones.some((p) => p === undefined)) throw new ApiError('VALIDATION_FAILED', 'phone required for new contact');
    const version = expectedVersion + 1;
    await this.prisma.$transaction(async (tx) => {
      await tx.emergencyContact.deleteMany({ where: { userId } });
      for (let i = 0; i < contacts.length; i++) {
        await tx.emergencyContact.create({ data: { userId, priority: i + 1, nameEncrypted: this.enc(contacts[i].name), phoneEncrypted: phones[i]!, version } });
      }
    });
    return this.getContacts(userId);
  }

  async testSms(userId: string, contactId: string, userActionId: string) {
    const c = await this.prisma.emergencyContact.findFirst({ where: { id: contactId, userId } });
    if (!c) throw notFound('contact');
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
    const d = await this.prisma.device.create({ data: { userId: p.userId, type: 'SENSOR', displayName: 'phone-sensor', tokenHash: t.hash } });
    await this.prisma.vehicleLink.create({ data: { userId: p.userId, vehicleId, deviceId: d.id, role: 'PHONE_DEVICE', status: 'ACTIVE' } });
    return { deviceId: d.id, deviceToken: t.raw, scope: 'sensor' as const };
  }

  async requestDeletion(userId: string, reauth: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.authSubject !== `dev:${reauth}`) throw new ApiError('UNAUTHENTICATED', 'reauthentication failed');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { deletionRequestedAt: new Date() } }),
      this.prisma.vehicleLink.updateMany({ where: { userId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } }),
      this.prisma.device.updateMany({ where: { userId }, data: { revokedAt: new Date(), tokenHash: null, pushTokenEncrypted: null } }),
      this.prisma.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } }),
      this.prisma.emergencyContact.deleteMany({ where: { userId } }),
    ]);
    return { status: 'DELETION_SCHEDULED', retention: 'summaries purged after retention window (policy TBD)' };
  }
}
