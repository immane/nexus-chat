/**
 * Structured Logger (Pino)
 *
 * Pre-configured Pino instance with:
 * - Dynamic log level via LOG_LEVEL env var (default: "info")
 * - Automatic redaction of sensitive fields (tokens, passwords, cookies)
 *
 * Design Decision:
 * Pino was chosen over Winston/Bunyan for its minimal overhead (~2x faster in
 * benchmarks) and native JSON output. The redact config ensures that auth tokens
 * and passwords never appear in logs even if accidentally passed to logger.info.
 *
 * Redacted Fields:
 * - req.headers.authorization, req.headers.cookie
 * - password, accessToken, refreshToken, token
 */
import pino from "pino";

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "password", "accessToken", "refreshToken", "token"],
    censor: "[REDACTED]"
  }
} satisfies pino.LoggerOptions;

export const logger = pino(loggerOptions);
