import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { validateEnvironment } from './platform/config.js';
import { DatabaseModule } from './platform/database.module.js';
import { HealthController } from './health.controller.js';
import { DModule } from './modules/d/d.module.js';
import { M1Module } from './modules/m1/m1.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        genReqId: (req, res) => {
          const incoming = req.headers['x-request-id'];
          const id =
            typeof incoming === 'string' && /^[0-9a-f-]{36}$/i.test(incoming)
              ? incoming
              : randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        serializers: {
          req: (req: { id?: string; method?: string; url?: string }) => ({
            id: req.id,
            method: req.method,
            path: req.url?.split('?')[0],
          }),
          res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
        },
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-user-authorization',
          'res.headers.set-cookie',
        ],
      },
    }),
    DatabaseModule,
    DModule,
    M1Module,
  ],
  controllers: [HealthController],
})
export class AppModule {}
