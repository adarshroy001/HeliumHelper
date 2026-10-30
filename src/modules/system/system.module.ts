import { Module } from '@nestjs/common';
import { HeartbeatConsumer } from './heartbeat.consumer.js';

/** The backend's own housekeeping jobs. Imported by the worker. */
@Module({ providers: [HeartbeatConsumer] })
export class SystemModule {}
