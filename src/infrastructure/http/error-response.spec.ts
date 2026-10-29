import {
  BadRequestException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../../common/errors/index.js';
import { toErrorBody } from './error-response.js';

const INTERNAL = {
  statusCode: 500,
  code: 'INTERNAL_ERROR',
  message: 'Something went wrong. Try again later.',
};

describe('toErrorBody', () => {
  it('keeps an AppError as it is', () => {
    const err = new NotFoundError('THING_NOT_FOUND', 'Thing not found.', { details: { thingId: 't1' } });

    expect(toErrorBody(err)).toEqual({
      statusCode: 404,
      code: 'THING_NOT_FOUND',
      message: 'Thing not found.',
      details: { thingId: 't1' },
    });
  });

  it('leaves out details when an AppError has none', () => {
    expect(toErrorBody(new ConflictError('THING_EXISTS', 'Thing exists.'))).toStrictEqual({
      statusCode: 409,
      code: 'THING_EXISTS',
      message: 'Thing exists.',
    });
  });

  it('gives Nest exceptions a fixed code and message, never their own text', () => {
    expect(toErrorBody(new NotFoundException('Cannot GET /secret-path'))).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
    });
    expect(toErrorBody(new BadRequestException('Unexpected token } in JSON'))).toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('uses a generic code for 4xx statuses it does not list', () => {
    expect(toErrorBody(new HttpException('teapot', 418))).toEqual({
      statusCode: 418,
      code: 'REQUEST_FAILED',
      message: 'The request could not be processed.',
    });
  });

  it('turns everything else into INTERNAL_ERROR', () => {
    expect(toErrorBody(new Error('password=hunter2 at db.internal'))).toEqual(INTERNAL);
    expect(toErrorBody(new ServiceUnavailableException('pool exhausted'))).toEqual(INTERNAL);
    expect(toErrorBody('a thrown string')).toEqual(INTERNAL);
    expect(toErrorBody(undefined)).toEqual(INTERNAL);
  });
});
