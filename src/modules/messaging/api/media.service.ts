import { buffer } from 'node:stream/consumers';
import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '../../../common/auth/index.js';
import { whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import { BlobStore } from '../../../infrastructure/blob/index.js';
import { MAIN_ACCOUNT_ID } from '../accounts.service.js';
import { MediaRepository, type MediaDocument } from '../data/media.repository.js';
import { MediaNotFoundError, MediaUploadFailedError, MediaUnsupportedError } from '../messaging.errors.js';
import { GraphClient } from '../whatsapp/graph-client.js';
import type { HeaderMediaType } from '../whatsapp/template.js';

/** What Meta accepts for template headers, and how big (HeliumAdmin's limits). */
const ACCEPTED: Readonly<Record<string, { type: HeaderMediaType; maxBytes: number }>> = {
  'image/jpeg': { type: 'image', maxBytes: 5 * 1024 * 1024 },
  'image/png': { type: 'image', maxBytes: 5 * 1024 * 1024 },
  'video/mp4': { type: 'video', maxBytes: 16 * 1024 * 1024 },
  'video/3gpp': { type: 'video', maxBytes: 16 * 1024 * 1024 },
  'application/pdf': { type: 'document', maxBytes: 100 * 1024 * 1024 },
};

/** Meta keeps an uploaded media file for 30 days; a copy older than this is uploaded again before use. */
const META_MEDIA_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;

/** A file received by the upload route (in memory). */
export interface UploadedFile {
  readonly buffer: Buffer;
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
}

/**
 * Header media for templates. An upload is only stored here; the copy on Meta is made when a campaign is tested
 * or started (`ensureOnMeta`), and made again when it's close to Meta's 30-day expiry.
 */
@Injectable()
export class MediaService {
  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly media: MediaRepository,
    private readonly blobs: BlobStore,
    private readonly graph: GraphClient,
  ) {}

  async store(file: UploadedFile, actor: Actor): Promise<MediaDocument & { type: HeaderMediaType }> {
    const accepted = ACCEPTED[file.mimetype];
    if (accepted === undefined) throw new MediaUnsupportedError(file.mimetype, Object.keys(ACCEPTED));
    if (file.size > accepted.maxBytes) throw new MediaUnsupportedError(file.mimetype, [], accepted.maxBytes);
    const key = `media/${String(Date.now())}-${file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)}`;
    await this.blobs.put(key, file.buffer);
    const created = await this.media.create({
      blobKey: key,
      mime: file.mimetype,
      size: file.size,
      filename: file.originalname.slice(0, 200),
      accountId: MAIN_ACCOUNT_ID,
      ...(actor.user === undefined ? {} : { createdBy: { userId: actor.user.id, email: actor.user.email } }),
    });
    return { ...created, type: accepted.type };
  }

  async get(id: string): Promise<MediaDocument & { type: HeaderMediaType }> {
    const found = await this.media.findById(id);
    const type = found === null ? undefined : ACCEPTED[found.mime]?.type;
    if (found === null || type === undefined) throw new MediaNotFoundError(id);
    return { ...found, type };
  }

  /** The media ID on Meta, uploading the file again when there's no copy or it's close to expiry. */
  async ensureOnMeta(id: string): Promise<string> {
    const found = await this.get(id);
    const fresh =
      found.uploadedToMetaAt !== undefined &&
      Date.now() - found.uploadedToMetaAt.getTime() < META_MEDIA_MAX_AGE_MS;
    if (found.metaMediaId !== undefined && fresh) return found.metaMediaId;
    const data = await buffer(this.blobs.open(found.blobKey));
    const result = await this.graph.uploadMedia(this.config.account.phoneNumberId, {
      data: new Uint8Array(data),
      mime: found.mime,
      filename: found.filename,
    });
    if (!result.ok) throw new MediaUploadFailedError(result.detail);
    await this.media.setMetaMedia(id, result.mediaId, new Date());
    return result.mediaId;
  }
}
