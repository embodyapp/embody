/** Minimal structured logger interface. api-server can swap in pino/etc. */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** Return a child logger with additional bound fields (e.g. the plugin id). */
  child(fields: Record<string, unknown>): Logger;
}

/** A no-frills console logger used by default and in tests. */
export function createConsoleLogger(bound: Record<string, unknown> = {}): Logger {
  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (msg: string, meta: Record<string, unknown> = {}) => {
      const line = { level, msg, ...bound, ...meta };
      // eslint-disable-next-line no-console
      (console[level] ?? console.log)(JSON.stringify(line));
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (fields) => createConsoleLogger({ ...bound, ...fields }),
  };
}

/**
 * A structured logger that writes every level to STDERR. Use this for stdio
 * transports (e.g. the MCP server) where STDOUT is reserved for the protocol stream
 * and any stray log line would corrupt it.
 */
export function createStderrLogger(bound: Record<string, unknown> = {}): Logger {
  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (msg: string, meta: Record<string, unknown> = {}) => {
      process.stderr.write(JSON.stringify({ level, msg, ...bound, ...meta }) + "\n");
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (fields) => createStderrLogger({ ...bound, ...fields }),
  };
}

/** A logger that swallows everything — handy in tests. */
export function createSilentLogger(): Logger {
  const noop = () => {};
  const self: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => self,
  };
  return self;
}
