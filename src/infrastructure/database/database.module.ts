import { Module } from '@nestjs/common';
import { MongooseModule, type MongooseModuleFactoryOptions } from '@nestjs/mongoose';
import mongoose from 'mongoose';
import { appConfig, type AppConfig, databaseConfig, type DatabaseConfig } from '../../config/index.js';
import { type ConnectionName, DB } from './connections.js';

// A filter on a field the schema doesn't have is an error, not silently dropped (which would match more
// documents than intended).
mongoose.set('strictQuery', 'throw');

function connectionOptions(uri: string, app: AppConfig, db: DatabaseConfig): MongooseModuleFactoryOptions {
  return {
    uri,
    // DocumentDB rejects retryable writes. Local and test connections match it.
    retryWrites: false,
    maxPoolSize: db.poolSize,
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 10_000,
    maxIdleTimeMS: 60_000,
    ...(db.tlsCaFile === undefined ? {} : { tls: true, tlsCAFile: db.tlsCaFile }),
    // Indexes and collections come from migrations (F13). Only a developer's machine builds them from schemas.
    autoIndex: app.appEnv === 'local',
    autoCreate: app.appEnv === 'local',
    // A database that can't be reached at startup fails the start (main.ts exits; the platform restarts us)
    // instead of retrying silently for half a minute.
    retryAttempts: 0,
  };
}

function connection(name: ConnectionName, uriOf: (db: DatabaseConfig) => string) {
  return MongooseModule.forRootAsync({
    connectionName: name,
    inject: [appConfig.KEY, databaseConfig.KEY],
    useFactory: (app: AppConfig, db: DatabaseConfig) => connectionOptions(uriOf(db), app, db),
  });
}

/**
 * Opens the named connections at startup and closes them on shutdown. Connections are available app-wide;
 * a module registers its models with `MongooseModule.forFeature([...], DB.<name>)`.
 */
@Module({
  imports: [connection(DB.main, (db) => db.mainUri), connection(DB.messaging, (db) => db.messagingUri)],
})
export class DatabaseModule {}
