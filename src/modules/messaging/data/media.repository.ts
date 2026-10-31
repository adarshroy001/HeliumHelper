import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import { DB } from '../../../infrastructure/database/index.js';
import { Media } from './messaging.schemas.js';

/** A stored media document, as a plain object. */
export type MediaDocument = Omit<Media, never> & { _id: Types.ObjectId };

/** The only code that writes `media`: header media files, and their copy on Meta. */
@Injectable()
export class MediaRepository {
  constructor(@InjectModel(Media.name, DB.messaging) private readonly model: Model<Media>) {}

  async create(media: Omit<Media, 'createdAt'>): Promise<MediaDocument> {
    const [created] = await this.model.create([{ ...media, createdAt: new Date() }]);
    if (created === undefined) throw new RangeError('media was not created');
    return created.toObject<MediaDocument>();
  }

  async findById(id: string): Promise<MediaDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.model.findById(id).lean<MediaDocument>().exec();
  }

  async setMetaMedia(id: string, metaMediaId: string, at: Date): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { metaMediaId, uploadedToMetaAt: at } }).exec();
  }
}
