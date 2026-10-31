import { Get, HttpCode, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { type Actor, CurrentActor, RequirePermissions } from '../../../common/auth/index.js';
import { InternalController } from '../../../common/http/index.js';
import { ValidationError } from '../../../common/errors/index.js';
import { Idempotent } from '../../../infrastructure/idempotency/index.js';
import type { Template } from '../data/messaging.schemas.js';
import { TemplatesService } from '../templates/templates.service.js';
import {
  extractTemplateVariables,
  headerMediaType,
  quickReplyButtons,
  type TemplateComponent,
} from '../whatsapp/template.js';
import { MediaService, type UploadedFile as StoredUpload } from './media.service.js';

const templatesQuery = z.strictObject({
  status: z.enum(['APPROVED', 'PENDING', 'PAUSED', 'REJECTED', 'DISABLED']).optional(),
});

/** What the composer needs about a template: its parts, variables, header media and poll options. */
function templateView(template: Template) {
  const components = template.components as TemplateComponent[];
  return {
    id: template._id,
    name: template.name,
    language: template.language,
    category: template.category,
    status: template.status,
    quality: template.quality,
    components,
    variables: extractTemplateVariables(components),
    headerMediaType: headerMediaType(components),
    quickReplies: quickReplyButtons(components),
    syncedAt: template.syncedAt,
  };
}

/** Templates and header media for the campaign composer (docs/modules/messaging/api.md). */
@InternalController('')
export class MessagingApiController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly media: MediaService,
  ) {}

  @Get('templates')
  @RequirePermissions('campaigns:read')
  async listTemplates(@Query({ schema: templatesQuery }) query: z.infer<typeof templatesQuery>) {
    return { items: (await this.templates.list(query.status)).map(templateView) };
  }

  @Post('templates/sync')
  @HttpCode(200)
  @RequirePermissions('messaging:ops')
  async syncTemplates(@CurrentActor() actor: Actor) {
    return { count: await this.templates.syncFor(actor) };
  }

  @Post('media')
  @Idempotent()
  @RequirePermissions('campaigns:write')
  @UseInterceptors(
    // In memory: uploads are rare admin actions, capped at WhatsApp's largest header (a 100 MB PDF).
    FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024, files: 1 } }),
  )
  async uploadMedia(@UploadedFile() file: StoredUpload | undefined, @CurrentActor() actor: Actor) {
    if (file === undefined) throw new ValidationError({ file: 'Attach the media file as `file`.' });
    const stored = await this.media.store(file, actor);
    return {
      id: String(stored._id),
      type: stored.type,
      mime: stored.mime,
      size: stored.size,
      filename: stored.filename,
    };
  }
}
