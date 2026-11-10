import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../auth/access.service';
import { EventsService } from '../events/events.service';
import { ApiError, notFound } from '../common/errors';
import { DevicePrincipal, Principal, UserPrincipal } from '../auth/principal';
import { CreateTripDto, PatchTripDto } from './trips.controller';

@Injectable()
export class TripsService {
  constructor(private readonly prisma: PrismaService, private readonly access: AccessService, private readonly events: EventsService) {}

  async create(p: UserPrincipal, dto: CreateTripDto) {
    await this.access.assertVehicle(p, dto.vehicleId);
    const place = await this.prisma.place.findUnique({ where: { id: dto.placeId } });
    if (!place) throw notFound('place');
    if (Date.parse(dto.endAt) <= Date.parse(dto.startAt)) throw new ApiError('VALIDATION_FAILED', 'endAt must be after startAt');
    const trip = await this.prisma.trip.create({
      data: { userId: p.userId, vehicleId: dto.vehicleId, placeId: dto.placeId, startAt: new Date(dto.startAt), endAt: new Date(dto.endAt), timezone: dto.timezone, people: dto.people },
    });
    this.events.publish({ type: 'TRIP_SYNCED', aggregateId: dto.vehicleId, revision: trip.version, payload: { tripId: trip.id, version: trip.version, stage: 'SERVER_SAVED' } });
    return this.view(trip.id);
  }

  async get(p: Principal, id: string) {
    await this.access.assertTrip(p, id);
    return this.view(id);
  }

  async patch(p: UserPrincipal, id: string, dto: PatchTripDto) {
    const t = await this.access.assertTrip(p, id);
    // 폰·차가 동시에 수정해도 조용히 덮어쓰지 않는다
    const r = await this.prisma.trip.updateMany({
      where: { id, version: dto.expectedVersion },
      data: {
        startAt: dto.startAt ? new Date(dto.startAt) : undefined, endAt: dto.endAt ? new Date(dto.endAt) : undefined,
        people: dto.people, status: dto.status, version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ApiError('VERSION_CONFLICT', `expectedVersion ${dto.expectedVersion} is stale (current ${t.version})`);
    const v = await this.view(id);
    this.events.publish({ type: 'TRIP_SYNCED', aggregateId: t.vehicleId, revision: v.version, payload: { tripId: id, version: v.version, stage: 'SERVER_SAVED' } });
    return v;
  }

  async upcoming(p: Principal, vehicleId: string, cursor?: string) {
    await this.access.assertVehicle(p, vehicleId);
    const take = 20;
    const rows = await this.prisma.trip.findMany({
      where: { vehicleId, status: { in: ['PLANNED', 'ACTIVE'] }, endAt: { gte: new Date(Date.now() - 6 * 3600_000) }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }], take: take + 1, include: { place: true, syncs: true },
    });
    const page = rows.slice(0, take);
    return {
      trips: page.map((t) => ({
        id: t.id, version: t.version, status: t.status, startAt: t.startAt, endAt: t.endAt, timezone: t.timezone, people: t.people,
        place: { id: t.place.id, name: t.place.name, lat: t.place.lat, lng: t.place.lng, campingStatus: t.place.campingStatus, cookingStatus: t.place.cookingStatus },
        syncedVersions: Object.fromEntries(t.syncs.map((s) => [s.deviceId, s.appliedVersion])),
      })),
      nextCursor: rows.length > take ? page[page.length - 1].id : null,
    };
  }

  async syncAck(p: DevicePrincipal, tripId: string, appliedVersion: number) {
    const t = await this.access.assertTrip(p, tripId);
    if (appliedVersion > t.version) throw new ApiError('VALIDATION_FAILED', 'appliedVersion ahead of server');
    await this.prisma.tripSync.upsert({
      where: { tripId_deviceId: { tripId, deviceId: p.deviceId } },
      create: { tripId, deviceId: p.deviceId, appliedVersion }, update: { appliedVersion, appliedAt: new Date() },
    });
    const stage = appliedVersion === t.version ? 'VEHICLE_SYNCED' : 'VEHICLE_STALE';
    this.events.publish({ type: 'TRIP_SYNCED', aggregateId: t.vehicleId, revision: t.version, sourceDeviceId: p.deviceId, payload: { tripId, appliedVersion, serverVersion: t.version, stage } });
    return { tripId, appliedVersion, serverVersion: t.version, stage };
  }

  private async view(id: string) {
    const t = await this.prisma.trip.findUniqueOrThrow({ where: { id }, include: { place: true, syncs: true } });
    const carSync = t.syncs.find(() => true);
    return {
      id: t.id, version: t.version, status: t.status, vehicleId: t.vehicleId, placeId: t.placeId, place: { name: t.place.name, campingStatus: t.place.campingStatus, cookingStatus: t.place.cookingStatus },
      startAt: t.startAt, endAt: t.endAt, timezone: t.timezone, people: t.people,
      sync: { server: 'SAVED', vehicle: carSync ? (carSync.appliedVersion === t.version ? 'SYNCED' : `STALE(v${carSync.appliedVersion})`) : 'NOT_SYNCED' },
    };
  }
}
