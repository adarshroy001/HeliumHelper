import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { type Connection, mongo } from 'mongoose';
import { DB } from '../../../infrastructure/database/index.js';
import { normalizePhone, phoneLookupVariants } from '../whatsapp/phone.js';

export interface ContactProfile {
  readonly phone: string;
  readonly userId: string;
  readonly name?: string;
  readonly email?: string;
  readonly city?: string;
}

const READ = { readPreference: mongo.ReadPreference.SECONDARY_PREFERRED };
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

function profile(doc: mongo.Document): ContactProfile | null {
  const phone = normalizePhone(typeof doc['phone'] === 'string' ? doc['phone'] : null);
  if (phone === null) return null;
  const name = text(doc['name']);
  const email = text(doc['email']);
  const city = text((doc['address'] as { city?: unknown } | undefined)?.city);
  return {
    phone,
    userId: (doc['_id'] as { toString(): string }).toString(),
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
    ...(city === undefined ? {} : { city }),
  };
}

/** Customers in the storefront's `users` collection, read-only (R9), for the inbox's contact details and search. */
@Injectable()
export class ContactsRepository {
  constructor(@InjectConnection(DB.main) private readonly connection: Connection) {}

  async byPhone(phone: string): Promise<ContactProfile | null> {
    const doc = await this.users().findOne(
      { phone: { $in: phoneLookupVariants(phone) } },
      { ...READ, projection: { phone: 1, name: 1, email: 1, 'address.city': 1 } },
    );
    return doc === null ? null : profile(doc);
  }

  /** Users whose phone, name or email matches, at most 25. */
  async search(query: string): Promise<ContactProfile[]> {
    const digits = query.replace(/\D/g, '');
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const or: mongo.Filter<mongo.Document>[] = [
      { name: { $regex: escaped, $options: 'i' } },
      { email: { $regex: escaped, $options: 'i' } },
    ];
    if (digits.length >= 4) or.push({ phone: { $regex: digits } });
    const docs = await this.users()
      .find(
        { $or: or },
        { ...READ, projection: { phone: 1, name: 1, email: 1, 'address.city': 1 }, maxTimeMS: 3000 },
      )
      .limit(25)
      .toArray();
    return docs.flatMap((doc) => profile(doc) ?? []);
  }

  private users() {
    return this.connection.collection('users');
  }
}
