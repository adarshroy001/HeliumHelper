import { Module, type Provider } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { destination, type DestinationStream } from 'pino';
import { appConfig, type AppConfig } from '../../config/index.js';
import { httpLoggerOptions } from './http-logger.options.js';

/** Where log lines go. Tests replace it with an in-memory stream to assert on log output. */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

const logDestination: Provider = {
  provide: LOG_DESTINATION,
  inject: [appConfig.KEY],
  useFactory: async (app: AppConfig): Promise<DestinationStream> => {
    if (app.nodeEnv === 'development') {
      // pino-pretty is a dev dependency: load it only on a developer's machine.
      const { default: pretty } = await import('pino-pretty');
      return pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service,env' });
    }
    // Synchronous stdout: nothing is lost if the process crashes. ECS and Lambda ship stdout to CloudWatch.
    return destination({ dest: 1, sync: true });
  },
};

/**
 * JSON logs with pino (ADR-0013): one access log line per request and structured app logs, all carrying
 * `requestId`. For structured logs, inject `PinoLogger` and set its context in the constructor:
 * `constructor(private readonly logger: PinoLogger) { logger.setContext(MyService.name); }`, then
 * `this.logger.info({ campaignId }, 'campaign started')`. Don't use `@InjectPinoLogger`: it only works for
 * classes loaded before this module, so it breaks depending on import order.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      providers: [logDestination],
      inject: [appConfig.KEY, LOG_DESTINATION],
      useFactory: (app: AppConfig, dest: DestinationStream) => ({
        pinoHttp: [httpLoggerOptions(app), dest],
      }),
    }),
  ],
})
export class LoggerModule {}
