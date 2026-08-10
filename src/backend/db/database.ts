import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export type Db = Database.Database;

/**
 * `:memory:` 走内存库（spike 用）。文件库时 blob 目录与库同级：
 * 两者合起来才是真相，缺一半都无法重放。
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

export function blobDir(dbFile: string): string {
  return dbFile === ':memory:'
    ? path.join(process.env.TMPDIR ?? '/tmp', 'inquestry-blobs')
    : path.join(path.dirname(dbFile), 'blobs');
}
