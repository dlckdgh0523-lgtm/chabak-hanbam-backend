import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentPrincipal, DevicePrincipal, Principal, Scopes } from '../auth/principal';
import { CapabilityReportDto, HeartbeatDto, TelemetryBatchDto } from './vehicles.dto';
import { VehiclesService } from './vehicles.service';

@Controller('vehicles/:vehicleId')
export class VehiclesController {
  constructor(private readonly svc: VehiclesService) {}

  @Get('capabilities') @Scopes('user', 'vehicle')
  capabilities(@CurrentPrincipal() p: Principal, @Param('vehicleId', ParseUUIDPipe) vehicleId: string) {
    return this.svc.getCapabilities(p, vehicleId);
  }

  @Post('capability-reports') @Scopes('vehicle')
  report(@CurrentPrincipal() p: DevicePrincipal, @Param('vehicleId', ParseUUIDPipe) vehicleId: string, @Body() dto: CapabilityReportDto) {
    return this.svc.reportCapabilities(p, vehicleId, dto);
  }

  @Post('telemetry-batches') @Scopes('vehicle', 'sensor') @HttpCode(202)
  telemetry(@CurrentPrincipal() p: DevicePrincipal, @Param('vehicleId', ParseUUIDPipe) vehicleId: string, @Body() dto: TelemetryBatchDto) {
    return this.svc.ingestTelemetry(p, vehicleId, dto);
  }

  @Post('heartbeats') @Scopes('vehicle') @HttpCode(200)
  heartbeat(@CurrentPrincipal() p: DevicePrincipal, @Param('vehicleId', ParseUUIDPipe) vehicleId: string, @Body() dto: HeartbeatDto) {
    return this.svc.heartbeat(p, vehicleId, dto);
  }

  @Get('state') @Scopes('user', 'vehicle')
  state(@CurrentPrincipal() p: Principal, @Param('vehicleId', ParseUUIDPipe) vehicleId: string) {
    return this.svc.getState(p, vehicleId);
  }
}
