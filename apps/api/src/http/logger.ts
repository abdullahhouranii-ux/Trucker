/** Structured logging: one JSON object per line. Callers pass only what is safe to record. */
export interface Logger {
  info(entry: Readonly<Record<string, unknown>>): void;
  error(entry: Readonly<Record<string, unknown>>): void;
}

function line(level: string, entry: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify({ level, time: new Date().toISOString(), ...entry })}\n`;
}

export const jsonLogger: Logger = {
  info: (entry) => void process.stdout.write(line('info', entry)),
  error: (entry) => void process.stderr.write(line('error', entry)),
};

export const silentLogger: Logger = { info: () => undefined, error: () => undefined };
