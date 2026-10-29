import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import request from 'supertest';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MONGO_IMAGE, mongoUri, startValkey } from './global-setup.js';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';

// Each dependency gets its own container here, because these tests stop it.

describe('MongoDB outage', () => {
  const original = { ...process.env };
  let mongo: StartedMongoDBContainer;
  let t: TestApp;

  beforeAll(async () => {
    mongo = await new MongoDBContainer(MONGO_IMAGE).start();
    process.env['MONGO_MAIN_URI'] = mongoUri(mongo.getConnectionString(), 'helium');
    process.env['MONGO_MESSAGING_URI'] = mongoUri(mongo.getConnectionString(), 'helium_messaging');
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
    process.env = { ...original };
  });

  it('turns readiness red while liveness stays green', async () => {
    expect((await request(t.http).get('/health/ready')).status).toBe(200);

    await mongo.stop();

    const ready = await request(t.http).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect((await request(t.http).get('/health/live')).status).toBe(200);
  });

  it('refuses to start when MongoDB is unreachable, instead of retrying for long', async () => {
    const started = Date.now();

    await expect(createTestApp()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe('Redis outage', () => {
  const original = { ...process.env };
  let valkey: StartedTestContainer;
  let t: TestApp;

  beforeAll(async () => {
    const started = await startValkey();
    valkey = started.container;
    process.env['REDIS_URL'] = started.url;
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
    process.env = { ...original };
  });

  it('turns readiness red while liveness stays green', async () => {
    expect((await request(t.http).get('/health/ready')).status).toBe(200);

    await valkey.stop();

    const ready = await request(t.http).get('/health/ready');
    expect(ready.status).toBe(503);
    expect((await request(t.http).get('/health/live')).status).toBe(200);
  });

  it('refuses to start when Redis is unreachable', async () => {
    const started = Date.now();

    await expect(createTestApp()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
