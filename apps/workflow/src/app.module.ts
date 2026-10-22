import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { validateEnvironment } from './platform/config.js';
import { DatabaseModule } from './platform/database.module.js';
import { HealthController } from './health.controller.js';
import { M2Module } from './modules/m2/m2.module.js';
import { M3Module } from './modules/m3/m3.module.js';

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
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
      },
    }),
    DatabaseModule,
    M2Module,
    M3Module,
  ],
  controllers: [HealthController],
})
export class AppModule {}
