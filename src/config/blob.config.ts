import { registerAs, type ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { loadConfig, type RawEnv } from './config.loader.js';

/** Variables for stored files: CSV audiences, header media, exports (ADR-0015). */
export const blobEnvSchema = z.object({
  /** Folder for stored files on the local disk. An S3 store replaces it when the backend is deployed. */
  BLOB_DIR: z.string().min(1).default('.data/blobs'),
});

/** Typed blob config, built from the validated variables. */
export function parseBlobConfig(env: RawEnv) {
  const vars = loadConfig('blob', blobEnvSchema, env);
  return { dir: vars.BLOB_DIR };
}

/** Inject with `@Inject(blobConfig.KEY) private readonly blob: BlobConfig`. */
export const blobConfig = registerAs('blob', () => parseBlobConfig(process.env));
export type BlobConfig = ConfigType<typeof blobConfig>;
