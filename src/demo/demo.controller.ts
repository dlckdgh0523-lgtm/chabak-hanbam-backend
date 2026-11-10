import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsIn, IsUUID } from 'class-validator';
import { CurrentPrincipal, DevicePrincipal, Scopes } from '../auth/principal';
import { VehiclesService } from '../vehicles/vehicles.service';
import { TelemetrySampleDto } from '../vehicles/vehicles.dto';
import { randomUUID } from 'crypto';

/**
 * D1 데모 패널 백엔드. NODE_ENV=production 이면 모듈 자체가 등록되지 않는다.
 * 차량 장치 토큰으로 호출해 MOCK 센서값을 주입한다. 출처는 항상 MOCK 으로 전파.
 */
class ScenarioDto {
  @IsUUID() vehicleId: string;
  @IsUUID() sessionId: string;
  @IsIn(['CO2_RISE', 'CO2_CRITICAL', 'CO_DETECTED', 'SENSOR_DROP', 'NORMAL', 'DOORS_SECURED', 'SOC_LOW']) scenario: string;
}

@Controller('demo')
export class DemoController {
  private seq = new Map<string, number>();
  private bootId = randomUUID();
  constructor(private readonly vehicles: VehiclesService) {}

  @Get('scenarios') @Scopes('vehicle', 'user')
  list() {
    return { scenarios: ['NORMAL', 'DOORS_SECURED', 'CO2_RISE', 'CO2_CRITICAL', 'CO_DETECTED', 'SENSOR_DROP', 'SOC_LOW'], note: 'dev build only; all samples source=MOCK' };
  }

  @Post('scenarios') @Scopes('vehicle')
  async run(@CurrentPrincipal() p: DevicePrincipal, @Body() dto: ScenarioDto) {
    const now = new Date().toISOString();
    const next = () => { const n = (this.seq.get(dto.vehicleId) ?? 0) + 1; this.seq.set(dto.vehicleId, n); return n; };
    const s = (metric: string, value: number | string | null, unit: string): TelemetrySampleDto => ({ metric, value, unit, source: 'MOCK', observedAt: now, seq: next(), bootId: this.bootId });
    const map: Record<string, TelemetrySampleDto[]> = {
      NORMAL: [s('co2Ppm', 800, 'ppm'), s('coPpm', 0, 'ppm'), s('cabinTempC', 19, 'C'), s('evSocPct', 72, '%'), s('fan.level', 2, 'level'), s('recirculation.state', 'FRESH', 'enum')],
      DOORS_SECURED: [s('doorLock.all', 'LOCKED', 'enum'), s('window.all', 'CLOSED', 'enum'), s('evSocPct', 72, '%')],
      CO2_RISE: [s('co2Ppm', 2300, 'ppm')],
      CO2_CRITICAL: [s('co2Ppm', 3800, 'ppm')],
      CO_DETECTED: [s('coPpm', 85, 'ppm')],
      SENSOR_DROP: [s('co2Ppm', null, 'ppm')], // 이후 15초 무수신 → SENSOR_DISCONNECTED
      SOC_LOW: [s('evSocPct', 18, '%')],
    };
    const r = await this.vehicles.ingestTelemetry(p, dto.vehicleId, { sessionId: dto.sessionId, samples: map[dto.scenario] });
    return { scenario: dto.scenario, injected: map[dto.scenario].length, ...r, executionMode: 'MOCK' };
  }
}
