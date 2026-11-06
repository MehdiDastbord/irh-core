/** Structured JSON logger with redaction — never logs tokens or credentials. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function currentLevel(): number {
  const configured = (process.env.LOG_LEVEL ?? 'info') as LogLevel;
  return LEVELS[configured] ?? LEVELS.info;
}

const SECRET_KEYS = /token|secret|password|authorization|cookie|key|encrypted|credential/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length > 500) return `${value.slice(0, 500)}…`;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 6).join('\n') };
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(key) && typeof entry === 'string') out[key] = '[redacted]';
      else if (SECRET_KEYS.test(key) && typeof entry === 'object' && entry !== null) out[key] = '[redacted]';
      else out[key] = redact(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** A logger whose scope is already bound. */
export interface ScopedLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): ScopedLogger;
}

export interface Logger {
  debug(scope: string, message: string, meta?: Record<string, unknown>): void;
  info(scope: string, message: string, meta?: Record<string, unknown>): void;
  warn(scope: string, message: string, meta?: Record<string, unknown>): void;
  error(scope: string, message: string, meta?: Record<string, unknown>): void;
  child(scope: string): ScopedLogger;
}

function emit(level: Exclude<LogLevel, 'silent'>, scope: string, message: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < currentLevel()) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? { meta: redact(meta) as Record<string, unknown> } : {}),
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
}

export const logger: Logger = {
  debug: (scope, message, meta) => emit('debug', scope, message, meta),
  info: (scope, message, meta) => emit('info', scope, message, meta),
  warn: (scope, message, meta) => emit('warn', scope, message, meta),
  error: (scope, message, meta) => emit('error', scope, message, meta),
  child: (scope) => ({
    debug: (message, meta) => emit('debug', scope, message, meta),
    info: (message, meta) => emit('info', scope, message, meta),
    warn: (message, meta) => emit('warn', scope, message, meta),
    error: (message, meta) => emit('error', scope, message, meta),
    child: (s) => logger.child(`${scope}:${s}`),
  }),
};
