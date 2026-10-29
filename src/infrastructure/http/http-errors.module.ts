import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ExceptionsFilter } from './exceptions.filter.js';

/** Registers the global exception filter, so every error response follows ADR-0008. */
@Module({
  providers: [{ provide: APP_FILTER, useClass: ExceptionsFilter }],
})
export class HttpErrorsModule {}
