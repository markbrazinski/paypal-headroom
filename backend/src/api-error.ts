import type { ErrorCode } from '@headroom/contracts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: { path: string; message: string }[];
  readonly outcome: 'NOT_APPLIED' | 'APPLIED' | 'UNKNOWN';
  constructor(status: number, code: ErrorCode, message: string, details?: { path: string; message: string }[], outcome: 'NOT_APPLIED' | 'APPLIED' | 'UNKNOWN' = 'NOT_APPLIED') {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.outcome = outcome;
  }
}
