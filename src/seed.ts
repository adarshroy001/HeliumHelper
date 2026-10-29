import mongoose from 'mongoose';
import { appConfig, databaseConfig } from './config/index.js';
import { mongoDriverOptions } from './infrastructure/database/index.js';
import { createProcessLogger } from './infrastructure/logger/process-logger.js';

// pnpm seed: sample data for a developer's machine. Refuses to run anywhere but APP_ENV=local.
//
// The `main` database is today's Helium database, owned by the storefront. Locally it starts empty, so this adds
// customers shaped like the storefront's `users` collection (src/models/User.model.ts in Helium-Production),
// which campaign audiences read. Running it again changes nothing: documents are upserted by phone.

const logger = createProcessLogger();

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Env files are optional.
  }
}

/** Fake numbers in a range no real subscriber uses (+91 90000 000xx). */
const SAMPLE_USERS = [
  { name: 'Asha Verma', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
  { name: 'Ravi Kumar', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
  { name: 'Meera Iyer', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' },
  { name: 'Arjun Singh', city: 'Delhi', state: 'Delhi', pincode: '110001' },
  { name: 'Fatima Khan', city: 'Hyderabad', state: 'Telangana', pincode: '500001' },
  { name: 'Kabir Das', city: 'Kolkata', state: 'West Bengal', pincode: '700001' },
].map((user, index) => ({
  phone: `+9190000000${String(index + 1).padStart(2, '0')}`,
  name: user.name,
  email: `${user.name.toLowerCase().replace(' ', '.')}@example.com`,
  address: {
    addressLine1: `${String(index + 1)} Sample Street`,
    city: user.city,
    state: user.state,
    pincode: user.pincode,
  },
}));

async function seed(): Promise<void> {
  const app = appConfig();
  if (app.appEnv !== 'local') {
    throw new Error(`Seed data is for local development only (APP_ENV=${app.appEnv})`);
  }
  const db = databaseConfig();

  const main = await mongoose.createConnection(db.mainUri, mongoDriverOptions(db)).asPromise();
  try {
    const now = new Date();
    const result = await main.collection('users').bulkWrite(
      SAMPLE_USERS.map((user) => ({
        updateOne: {
          filter: { phone: user.phone },
          update: { $set: { ...user, updatedAt: now }, $setOnInsert: { createdAt: now } },
          upsert: true,
        },
      })),
    );
    logger.info(
      { collection: 'main.users', added: result.upsertedCount, total: SAMPLE_USERS.length },
      'seeded',
    );
  } finally {
    await main.close();
  }
}

seed().catch((err: unknown) => {
  logger.fatal({ err }, 'seed failed');
  process.exit(1);
});
