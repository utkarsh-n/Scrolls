// OWNER: WP0 — HTTP errors and the error body of SPEC §7: {"error":{"code","message","hint","detail"}}

import { isBusyError, isConstraintError } from '../db/open.mjs';

/** An error that maps to an HTTP status and a stable code. */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status (400, 403, 404, 409, 413, 503, 500 …)
   * @param {string} code stable machine code, e.g. 'E_NOT_FOUND', 'QUERY_TIMEOUT'
   * @param {string} [message] human sentence
   * @param {string|null} [hint] what the user can do about it
   * @param {unknown} [detail] structured detail (JSON-serializable)
   */
  constructor(status, code, message = code, hint = null, detail = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }
}

/**
 * HTTP status for any thrown value: HttpError keeps its own; SQLite constraint failures (CHECK, UNIQUE,
 * honesty triggers) are 409; a busy writer is 503; everything else 500.
 * @param {unknown} err
 * @returns {number}
 */
export function statusOf(err) {
  if (err instanceof HttpError || (err && Number.isInteger(err.status) && typeof err.code === 'string')) return err.status;
  if (isConstraintError(err)) return 409;
  if (isBusyError(err)) return 503;
  return 500;
}

/**
 * The JSON error body. Internal errors never leak stack traces or SQL.
 * @param {unknown} err
 * @returns {{error:{code:string, message:string, hint:string|null, detail:unknown}}}
 */
export function toErrorBody(err) {
  const status = statusOf(err);
  if (err instanceof HttpError || (err && Number.isInteger(err.status) && typeof err.code === 'string')) {
    return { error: { code: err.code, message: err.message, hint: err.hint ?? null, detail: err.detail ?? null } };
  }
  if (status === 409) {
    return { error: { code: 'E_CONSTRAINT', message: err.message.replace(/^.*?constraint failed:\s*/i, ''),
      hint: 'The database refused this change; see the message for the rule it would break.', detail: null } };
  }
  if (status === 503) {
    return { error: { code: 'E_BUSY', message: 'The database is busy with a write job.',
      hint: 'Try again in a few seconds.', detail: null } };
  }
  return { error: { code: 'E_INTERNAL', message: 'Internal error.',
    hint: 'See logs/scrolls.log in the data directory.', detail: null } };
}

/** 400 helper. @param {string} code @param {string} message @param {string|null} [hint] @param {unknown} [detail] */
export const badRequest = (code, message, hint = null, detail = null) => new HttpError(400, code, message, hint, detail);
/** 404 helper. @param {string} what */
export const notFound = (what) => new HttpError(404, 'E_NOT_FOUND', `${what} not found.`, null, null);
