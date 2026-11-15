import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { CommandsService } from './commands.service';
import { AlertsService } from './alerts.service';

@Module({ imports: [VehiclesModule], controllers: [SessionsController], providers: [SessionsService, CommandsService, AlertsService], exports: [SessionsService, AlertsService] })
export class SessionsModule implements OnModuleInit {
  private readonly log = new Logger('CommandExpiry');
  constructor(private readonly commands: CommandsService, private readonly prisma: PrismaService) {}
  onModuleInit() {
    // DB 가 잠깐 끊겨도 서버가 죽지 않게 (처리 안 된 rejection 은 프로세스를 종료시킨다). 다른 워커와 같이 한 인스턴스만
    setInterval(() => void this.prisma.runExclusive('worker:command-expiry', () => this.commands.expireStale()).catch((err: Error) => this.log.error(`expire failed: ${err.message}`)), 5000).unref();
  }
}
