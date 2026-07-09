/**
 * Canonical Error Codes
 *
 * Single source of truth for error codes used across HTTP responses
 * and WS gateway responses. Every apiFail() call should use one of these codes.
 *
 * Convention:
 * - UPPER_SNAKE_CASE
 * - Grouped by domain (AUTH_, E2E_, etc.) for future code-splitting
 */
export const ERROR_CODES = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  FORBIDDEN: "FORBIDDEN",
  E2E_BOT_NOT_ALLOWED: "E2E_BOT_NOT_ALLOWED",
  CONFLICT: "CONFLICT",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
