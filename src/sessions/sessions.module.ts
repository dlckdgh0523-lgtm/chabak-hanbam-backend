import { Module, OnModuleInit } from '@nestjs/common';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { CommandsService } from './commands.service';
import { AlertsService } from './alerts.service';

@Module({ imports: [VehiclesModule], controllers: [SessionsController], providers: [SessionsService, CommandsService, AlertsService], exports: [SessionsService, AlertsService] })
export class SessionsModule implements OnModuleInit {
  constructor(private readonly commands: CommandsService) {}
  onModuleInit() {
    setInterval(() => void this.commands.expireStale(), 5000);
  }
}
