import { HttpStatus } from '@nestjs/common';
import { AppError, ConflictError, NotFoundError } from '../../common/errors/index.js';

export class CampaignNotFoundError extends NotFoundError {
  constructor(campaignId: string) {
    super('CAMPAIGN_NOT_FOUND', 'Campaign not found.', { details: { campaignId } });
  }
}

/** 409: the campaign's status doesn't allow this, or it changed meanwhile. */
export class CampaignStateError extends ConflictError {
  constructor(campaignId: string, status: string, action: string) {
    super('CAMPAIGN_STATE_CONFLICT', `A ${status.replace('_', ' ')} campaign can't be ${action}.`, {
      details: { campaignId, status, action },
    });
  }
}

/** 422: the campaign's setup can't be sent as it is; `details.problems` lists why. */
export class CampaignInvalidError extends AppError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(problems: readonly string[]) {
    super('CAMPAIGN_INVALID', 'The campaign is not ready to send. Fix the problems listed.', {
      details: { problems },
    });
  }
}

export class UploadNotFoundError extends NotFoundError {
  constructor(uploadId: string) {
    super('UPLOAD_NOT_FOUND', 'Upload not found.', { details: { uploadId } });
  }
}

/** 422: an uploaded CSV can't be used as an audience. */
export class CsvInvalidError extends AppError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(problem: string) {
    super('CSV_INVALID', `The CSV file can't be used: ${problem}`, { details: { problem } });
  }
}

export class ExportNotFoundError extends NotFoundError {
  constructor(exportId: string) {
    super('EXPORT_NOT_FOUND', 'Export not found, or expired.', { details: { exportId } });
  }
}
