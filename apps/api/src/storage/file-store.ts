import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where files are kept, outside the database. No storage supplier is chosen (D-011): the only
 * implementation is a development stand-in on this machine. The database keeps each file's
 * declaration, fingerprint and key; the store keeps the bytes under the key.
 */
export interface FileStore {
  /** Keeps the bytes and returns the key they are kept under. */
  put(bytes: Buffer): Promise<string>;
  /** The bytes kept under a key, or null when none are. */
  get(key: string): Promise<Buffer | null>;
  /** Removes what a key holds; nothing happens when it holds nothing. */
  remove(key: string): Promise<void>;
}

const KEY = /^[0-9a-f-]{36}$/;

/** Development stand-in: one file per key in a folder on this machine. Refused in production. */
export class LocalFileStore implements FileStore {
  constructor(private readonly directory: string) {}

  private where(key: string): string {
    if (!KEY.test(key)) throw new Error('invalid storage key');
    return path.join(this.directory, key);
  }

  async put(bytes: Buffer): Promise<string> {
    const key = randomUUID();
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.where(key), bytes, { flag: 'wx' });
    return key;
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.where(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.where(key), { force: true });
  }
}
