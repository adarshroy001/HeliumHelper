import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { type Connection, mongo } from 'mongoose';
import { DB } from '../../../infrastructure/database/index.js';
import type { AudienceSource } from '../campaigns.schemas.js';
import { cartsFilter, ordersFilter, usersFilter, waitlistFilter } from './audience-filters.js';

/** One person found in a source, before their phone is normalized. */
export interface SourceRecord {
  readonly phone: unknown;
  readonly name?: string;
  readonly email?: string;
  readonly city?: string;
  readonly userId?: string;
}

// The storefront's collections (Mongoose's default names for its models).
const COLLECTIONS = {
  users: 'users',
  orders: 'orders',
  abandoned_carts: 'abandonedcarts',
  waitlist: 'newwaitlists',
} as const;
const READ = { readPreference: mongo.ReadPreference.SECONDARY_PREFERRED };
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * Reads audiences from the main (storefront) database: read-only (R9), from a secondary when there is one, with
 * streaming cursors so a million people never sit in memory.
 */
@Injectable()
export class AudienceSourcesRepository {
  constructor(@InjectConnection(DB.main) private readonly connection: Connection) {}

  /** Everyone a source matches. Orders are grouped by delivery phone, as in HeliumAdmin. */
  async *stream(source: AudienceSource): AsyncGenerator<SourceRecord> {
    if (source.type === 'orders') {
      const cursor = this.collection('orders').aggregate(
        [
          { $match: ordersFilter(source.filters) },
          {
            $group: {
              _id: '$deliveryAddress.phone',
              name: { $first: '$deliveryAddress.name' },
              email: { $first: '$deliveryAddress.email' },
              city: { $first: '$deliveryAddress.city' },
              userId: { $first: '$userId' },
            },
          },
        ],
        { ...READ, allowDiskUse: true, batchSize: 1000 },
      );
      for await (const doc of cursor) yield this.record(doc['_id'], doc);
      return;
    }
    const { filter, projection, map } = this.query(source);
    const cursor = this.collection(source.type).find(filter, { ...READ, projection, batchSize: 1000 });
    for await (const doc of cursor) yield map(doc);
  }

  /** How many a source matches (orders: distinct phones), or `null` when counting takes longer than `maxTimeMS`. */
  async count(source: AudienceSource, maxTimeMS: number): Promise<number | null> {
    try {
      if (source.type === 'orders') {
        const [row] = await this.collection('orders')
          .aggregate<{ n: number }>(
            [
              { $match: ordersFilter(source.filters) },
              { $group: { _id: '$deliveryAddress.phone' } },
              { $count: 'n' },
            ],
            { ...READ, maxTimeMS, allowDiskUse: true },
          )
          .toArray();
        return row?.n ?? 0;
      }
      return await this.collection(source.type).countDocuments(this.query(source).filter, {
        ...READ,
        maxTimeMS,
      });
    } catch (error) {
      if (error instanceof mongo.MongoServerError && error.code === 50) return null; // MaxTimeMSExpired
      throw error;
    }
  }

  /** Values for the filter dropdowns. */
  async options(
    maxTimeMS: number,
  ): Promise<{ productModels: string[]; utmSources: string[]; waitlistSources: string[] }> {
    const distinct = async (name: keyof typeof COLLECTIONS, field: string) => {
      const values: unknown[] = await this.collection(name)
        .distinct(field, {}, { ...READ, maxTimeMS })
        .catch((): unknown[] => []);
      return values.filter((v): v is string => typeof v === 'string' && v !== '').sort();
    };
    const [productModels, utmSources, waitlistSources] = await Promise.all([
      distinct('orders', 'product.model'),
      distinct('abandoned_carts', 'utm.source'),
      distinct('waitlist', 'source'),
    ]);
    return { productModels, utmSources, waitlistSources };
  }

  /** Users by phone (any stored form), for names and emails of individual contacts and CSV rows. */
  async usersByPhones(variants: readonly string[]): Promise<SourceRecord[]> {
    if (variants.length === 0) return [];
    const docs = await this.collection('users')
      .find(
        { phone: { $in: [...variants] } },
        { ...READ, projection: { phone: 1, name: 1, email: 1, 'address.city': 1 } },
      )
      .toArray();
    return docs.map((doc) =>
      this.record(doc['phone'], { ...doc, city: (doc['address'] as { city?: unknown } | undefined)?.city }),
    );
  }

  private query(source: Exclude<AudienceSource, { type: 'orders' }>) {
    switch (source.type) {
      case 'users':
        return {
          filter: usersFilter(source.filters),
          projection: { phone: 1, name: 1, email: 1, 'address.city': 1 },
          map: (doc: mongo.Document) =>
            this.record(doc['phone'], {
              ...doc,
              userId: doc['_id'],
              city: (doc['address'] as { city?: unknown } | undefined)?.city,
            }),
        };
      case 'abandoned_carts':
        return {
          filter: cartsFilter(source.filters),
          projection: { 'customer.phone': 1, 'customer.name': 1, 'customer.email': 1 },
          map: (doc: mongo.Document) => {
            const customer = (doc['customer'] ?? {}) as Record<string, unknown>;
            return this.record(customer['phone'], customer);
          },
        };
      case 'waitlist':
        return {
          filter: waitlistFilter(source.filters),
          projection: { phone: 1, name: 1, email: 1, city: 1 },
          map: (doc: mongo.Document) => this.record(doc['phone'], doc),
        };
    }
  }

  private record(phone: unknown, doc: Record<string, unknown>): SourceRecord {
    const userId = doc['userId'];
    return {
      phone,
      ...(text(doc['name']) === undefined ? {} : { name: text(doc['name']) }),
      ...(text(doc['email']) === undefined ? {} : { email: text(doc['email']) }),
      ...(text(doc['city']) === undefined ? {} : { city: text(doc['city']) }),
      // An ObjectId or a string; stored as its hex string.
      ...(userId === undefined || userId === null
        ? {}
        : { userId: (userId as { toString(): string }).toString() }),
    };
  }

  private collection(name: keyof typeof COLLECTIONS) {
    return this.connection.collection(COLLECTIONS[name]);
  }
}
