/**
 * Structured JSON logging to stdout.
 *
 * `backend-standards.md` §7: every entry carries a request ID, timestamp,
 * severity and service name, and never contains secrets, PII or stack traces
 * at INFO or below. The application never manages log files — the platform
 * collects stdout.
 */
import { pino, type Logger } from "pino";
import type { AppConfig } from "./config.js";

/**
 * Paths scrubbed from every log line.
 *
 * Redaction is by path, so logging a whole object cannot leak a secret that
 * happens to be nested inside it.
 */
const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "res.headers['set-cookie']",
  "*.password",
  "*.api_key",
  "*.apiKey",
  "*.token",
  "*.access_token",
  "*.refresh_token",
  "*.service_role_key",
  "*.secret",
  "*.authorization",
];

export function create_logger(config: AppConfig): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: {
      service: config.SERVICE_NAME,
      env: config.NODE_ENV,
    },
    redact: {
      paths: REDACTED_PATHS,
      censor: "[REDACTED]",
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Human-readable locally; raw JSON everywhere the platform collects it.
    ...(config.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  });
}

export type { Logger };
