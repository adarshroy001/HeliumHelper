import { Global, Module } from '@nestjs/common';
import { blobConfig, type BlobConfig } from '../../config/index.js';
import { BlobStore, LocalDiskBlobStore } from './blob-store.js';

/** Provides `BlobStore` to every module. Local disk today; the S3 store is added with the deployment. */
@Global()
@Module({
  providers: [
    {
      provide: BlobStore,
      inject: [blobConfig.KEY],
      useFactory: (config: BlobConfig) => new LocalDiskBlobStore(config.dir),
    },
  ],
  exports: [BlobStore],
})
export class BlobModule {}
