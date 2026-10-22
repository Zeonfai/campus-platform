import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import type { Request, Response, NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import { AppModule } from './app.module.js';
import { ApiErrorFilter } from './platform/api-error.filter.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService);
  app.use(helmet());
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.url.startsWith('/api/')) res.setHeader('cache-control', 'no-store');
    next();
  });
  app.enableCors({ origin: config.getOrThrow<string[]>('FRONTEND_ORIGINS'), credentials: false });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableShutdownHooks();
  if (config.get<boolean>('API_DOCS_ENABLED')) {
    const spec = JSON.parse(
      readFileSync(new URL(import.meta.resolve('@campus/contracts/openapi')), 'utf8'),
    ) as OpenAPIObject;
    spec.paths = Object.fromEntries(
      Object.entries(spec.paths).filter(
        ([, item]) =>
          item &&
          Object.values(item).some(
            (value: unknown) =>
              typeof value === 'object' &&
              value !== null &&
              (value as Record<string, unknown>)['x-service'] === 'workflow',
          ),
      ),
    );
    spec.info.title += ' / workflow';
    SwaggerModule.setup('docs', app, spec);
  }
  await app.listen(config.getOrThrow<number>('PORT'), config.get<string>('HOST') ?? '127.0.0.1');
}
bootstrap().catch(() => {
  console.error('Service startup failed; check required environment configuration.');
  process.exitCode = 1;
});
