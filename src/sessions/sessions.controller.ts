import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601, IsObject, IsString, IsUUID, Length } from 'class-validator';
import { CurrentPrincipal, DevicePrincipal, Principal, Scopes, UserPrincipal } from '../auth/principal';
import { Idempotent } from '../common/idempotency.interceptor';
import { SessionsService } from './sessions.service';
import { CommandsService } from './commands.service';
import { AlertsService } from './alerts.service';
import { CommandRequestDto, CommandResultDto, CreateSessionDto, PatchPlanDto, PreflightDto, StartDto, StopDto } from './sessions.dto';

class RaiseAlertDto {
  @IsUUID() sessionId: string;
  @IsString() @Length(1, 48) kind: string;
  @IsIn(['INFO', 'WARNING', 'CRITICAL']) severity: 'INFO' | 'WARNING' | 'CRITICAL';
  @IsString() @Length(1, 128) sourceEventId: string;
  @IsObject() evidence: Record<string, unknown>;
  @IsIn(['MOCK', 'PLEOS_EMULATOR', 'REAL']) executionMode: 'MOCK' | 'PLEOS_EMULATOR' | 'REAL';
}
class AckDto {
  @IsIn(['OK', 'KNOWN_PERSON', 'REQUEST_HELP', 'SNOOZE']) action: string;
}
class ReceiptDto {
  @IsUUID() eventId: string;
  @IsIn(['RECEIVED', 'DISPLAYED']) stage: 'RECEIVED' | 'DISPLAYED';
  @IsIn(['WSS', 'PUSH', 'LOCAL']) channel: 'WSS' | 'PUSH' | 'LOCAL';
  @IsISO8601() time: string;
}
class ContactNotifyDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @IsUUID('all', { each: true }) recipients: string[];
  @IsIn(['ACCESS_HELP', 'EMERGENCY_HELP']) template: string;
  @IsString() @Length(1, 64) userActionId: string;
}
class TestAlertDto {
  @IsUUID() vehicleId: string;
  @IsIn(['PUSH', 'FULLSCREEN', 'SOUND']) kind: string;
}

@Controller()
export class SessionsController {
  constructor(private readonly sessions: SessionsService, private readonly commands: CommandsService, private readonly alerts: AlertsService) {}

  // ── 취침 세션 ──
  @Post('sleep-sessions') @Scopes('user') @Idempotent()
  create(@CurrentPrincipal() p: UserPrincipal, @Body() dto: CreateSessionDto) { return this.sessions.create(p, dto); }

  @Get('sleep-sessions/:id') @Scopes('user', 'vehicle')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.sessions.get(p, id); }

  @Patch('sleep-sessions/:id/plan') @Scopes('user', 'vehicle')
  patchPlan(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PatchPlanDto) { return this.sessions.patchPlan(p, id, dto.plan, dto.expectedVersion); }

  @Post('sleep-sessions/:id/preflight') @Scopes('user', 'vehicle') @HttpCode(200)
  preflight(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PreflightDto) { return this.sessions.preflight(p, id, dto); }

  @Post('sleep-sessions/:id/start') @Scopes('user') @HttpCode(200)
  start(@CurrentPrincipal() p: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StartDto) { return this.sessions.start(p, id, dto); }

  @Post('sleep-sessions/:id/stop') @Scopes('user', 'vehicle') @HttpCode(200)
  stop(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StopDto) { return this.sessions.stop(p, id, dto); }

  @Get('sleep-sessions/:id/summary') @Scopes('user', 'vehicle')
  summary(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.sessions.summary(p, id); }

  @Get('sleep-sessions/:id/alerts') @Scopes('user', 'vehicle')
  listAlerts(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.alerts.list(p, id); }

  // ── 명령 ──
  @Post('vehicles/:vehicleId/commands') @Scopes('user') @Idempotent() @HttpCode(202)
  command(@CurrentPrincipal() p: UserPrincipal, @Param('vehicleId', ParseUUIDPipe) vehicleId: string, @Body() dto: CommandRequestDto) { return this.commands.request(p, vehicleId, dto); }

  @Get('commands/:id') @Scopes('user', 'vehicle')
  getCommand(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.commands.get(p, id); }

  @Post('commands/:id/results') @Scopes('vehicle') @HttpCode(200)
  commandResult(@CurrentPrincipal() p: DevicePrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CommandResultDto) { return this.commands.result(p, id, dto); }

  // ── 경보 ──
  @Post('alerts') @Scopes('vehicle', 'sensor', 'user')
  raise(@CurrentPrincipal() p: Principal, @Body() dto: RaiseAlertDto) { return this.alerts.raiseExternal(p, dto); }

  @Post('alerts/test') @Scopes('user')
  testAlert(@CurrentPrincipal() p: UserPrincipal, @Body() dto: TestAlertDto) { return this.alerts.test(p, dto.vehicleId, dto.kind); }

  @Post('alerts/:id/acknowledgements') @Scopes('user', 'vehicle')
  ack(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AckDto) { return this.alerts.ack(p, id, dto.action); }

  @Post('alerts/:id/contact-notifications') @Scopes('user') @Idempotent() @HttpCode(202)
  notify(@CurrentPrincipal() p: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ContactNotifyDto) { return this.alerts.contactNotification(p, id, dto); }

  @Post('delivery-receipts') @Scopes('user', 'vehicle', 'sensor') @HttpCode(200)
  receipt(@CurrentPrincipal() p: Principal, @Body() dto: ReceiptDto) { return this.alerts.receipt(p, dto); }
}
