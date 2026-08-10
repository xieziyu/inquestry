import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema.js';

export const SCHEMA_VERSION = 1;

export type Db = Database.Database;

/**
 * `:memory:` 走内存库（spike 用）。文件库时 blob 目录与库同级：
 * 两者合起来才是真相，缺一半都无法重放。
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  // schema 全量幂等（IF NOT EXISTS），每次启动都跑一遍；user_version 留给将来的破坏性迁移。
  // 投影表随时可从 events 重放重建，所以迁移不必写数据搬运脚本（data-model.md §1）。
  db.exec(SCHEMA_SQL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function blobDir(dbFile: string): string {
  return dbFile === ':memory:'
    ? path.join(process.env.TMPDIR ?? '/tmp', 'inquestry-blobs')
    : path.join(path.dirname(dbFile), 'blobs');
}
