import pino from "pino";

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "password", "accessToken", "refreshToken", "token"],
    censor: "[REDACTED]"
  }
} satisfies pino.LoggerOptions;

export const logger = pino(loggerOptions);
