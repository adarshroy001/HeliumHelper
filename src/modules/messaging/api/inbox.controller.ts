import {
  Body,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { type Actor, CurrentActor, RequirePermissions } from '../../../common/auth/index.js';
import { ValidationError } from '../../../common/errors/index.js';
import { InternalController } from '../../../common/http/index.js';
import { Idempotent } from '../../../infrastructure/idempotency/index.js';
import { InboxService } from '../inbox/inbox.service.js';
import { SuppressionsService } from '../suppressions/suppressions.service.js';
import {
  conversationsQuery,
  type ConversationsQuery,
  directMessageSchema,
  type DirectMessageBody,
  phoneParam,
  searchQuery,
  type SearchQuery,
  suppressionsQuery,
  type SuppressionsQuery,
  timelineQuery,
  type TimelineQuery,
} from './inbox.schemas.js';

/** The inbox, contacts, direct messages and the suppression list (docs/modules/messaging/api.md). */
@InternalController('')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly suppressions: SuppressionsService,
  ) {}

  @Get('conversations')
  @RequirePermissions('inbox:read')
  async conversations(@Query({ schema: conversationsQuery }) query: ConversationsQuery) {
    const items = await this.inbox.conversationList(query.unread, query.before, query.limit);
    return {
      items: items.map((c) => ({
        phone: c._id,
        name: c.name ?? null,
        lastMessageAt: c.lastMessageAt,
        lastDirection: c.lastDirection,
        lastPreview: c.lastPreview ?? null,
        unread: c.unread,
      })),
      nextBefore: items.length === query.limit ? (items.at(-1)?.lastMessageAt ?? null) : null,
    };
  }

  @Get('contacts')
  @RequirePermissions('inbox:read')
  async search(@Query({ schema: searchQuery }) query: SearchQuery) {
    return { items: await this.inbox.search(query.q) };
  }

  @Get('contacts/:phone')
  @RequirePermissions('inbox:read')
  async contact(
    @Param('phone', { schema: phoneParam }) phone: string,
    @Query({ schema: timelineQuery }) query: TimelineQuery,
  ) {
    return this.inbox.contact(phone, query.before, query.limit);
  }

  @Post('contacts/:phone/read')
  @HttpCode(204)
  @RequirePermissions('inbox:read')
  async markRead(@Param('phone', { schema: phoneParam }) phone: string): Promise<void> {
    await this.inbox.markRead(phone);
  }

  @Post('contacts/:phone/messages')
  @HttpCode(202)
  @Idempotent()
  @RequirePermissions('inbox:send')
  async send(
    @Param('phone', { schema: phoneParam }) phone: string,
    @Body({ schema: directMessageSchema }) body: DirectMessageBody,
    @CurrentActor() actor: Actor,
  ) {
    return this.inbox.send(phone, body, actor);
  }

  @Get('suppressions')
  @RequirePermissions('inbox:read')
  async listSuppressions(@Query({ schema: suppressionsQuery }) query: SuppressionsQuery) {
    const items = await this.suppressions.list(query.after, query.limit);
    return {
      items: items.map((s) => ({ phone: s._id, reason: s.reason, by: s.by ?? null, createdAt: s.createdAt })),
      nextAfter: items.length === query.limit ? (items.at(-1)?._id ?? null) : null,
    };
  }

  @Put('suppressions/:phone')
  @RequirePermissions('suppressions:write')
  async addSuppression(@Param('phone', { schema: phoneParam }) phone: string, @CurrentActor() actor: Actor) {
    return { phone, added: await this.suppressions.add(phone, actor) };
  }

  @Delete('suppressions/:phone')
  @RequirePermissions('suppressions:write')
  async removeSuppression(
    @Param('phone', { schema: phoneParam }) phone: string,
    @CurrentActor() actor: Actor,
  ) {
    return { phone, removed: await this.suppressions.remove(phone, actor) };
  }

  @Post('suppressions/import')
  @Idempotent()
  @RequirePermissions('suppressions:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024, files: 1 } }))
  async importSuppressions(
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @CurrentActor() actor: Actor,
  ) {
    if (file === undefined)
      throw new ValidationError({ file: 'Attach a CSV or text file of phones as `file`.' });
    return this.suppressions.import(file.buffer.toString('utf8'), actor);
  }
}
