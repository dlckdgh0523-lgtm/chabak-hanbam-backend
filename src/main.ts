import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { requestIdMiddleware } from './common/request-id.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('v1');
  app.use(requestIdMiddleware);
  app.useWebSocketAdapter(new WsAdapter(app));
  // 프론트 live 모드(로컬 미리보기 서버)용. 운영에서는 열지 않는다.
  if (process.env.NODE_ENV !== 'production') app.enableCors({ origin: ['http://localhost:8080', 'http://127.0.0.1:8080'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, forbidUnknownValues: true }));
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`listening on :${port} (env=${process.env.NODE_ENV ?? 'development'})`);
}
void bootstrap();
