import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { PairingModule } from './pairing/pairing.module';
import { AccountModule } from './account/account.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { TripsModule } from './trips/trips.module';
import { SessionsModule } from './sessions/sessions.module';
import { ContentModule } from './content/content.module';
import { DemoModule } from './demo/demo.module';
import { ApiExceptionFilter } from './common/http-exception.filter';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { Public } from './auth/principal';
import { PrismaService } from './prisma/prisma.service';

@Controller()
class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Public() @Get('health')
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true, env: process.env.NODE_ENV ?? 'development', time: new Date().toISOString() };
  }
}

const isProd = process.env.NODE_ENV === 'production';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule, AuthModule, EventsModule, PairingModule, AccountModule, VehiclesModule, TripsModule, SessionsModule, ContentModule,
    ...(isProd ? [] : [DemoModule]),
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
