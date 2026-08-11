import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema.js';

/** 2：立案面板的字段（cases 的项目起点与基准日、sessions.effort、steps 的应然实然）。 */
export const SCHEMA_VERSION = 2;

export type Db = Database.Database;

/**
 * `:memory:` 走内存库（spike 用）。文件库时 blob 目录与库同级：
 * 两者合起来才是真相，缺一半都无法重放。
 *
 * **开发期不做跨版本迁移：版本对不上就把旧库挪开，重新建一个空的。**
 * 理由不是嫌麻烦，是重放老事件这件事只有"载荷形状没变过"时才成立——变了之后
 * 旧载荷缺的字段会一路绑成 NULL 落进新表，看着像迁移成功，实际是一批半残的案子。
 * 开发阶段的数据本来就是随手造的，重新补一份比维护一条没人验过的迁移路径便宜得多。
 * 发版后要换成真迁移时，这里就是那个决策点。
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    mkdirSync(path.dirname(file), { recursive: true });
    archiveIfStale(file);
  }
  const db = new Database(file);
  // schema 全量幂等（IF NOT EXISTS），每次启动都跑一遍
  db.exec(SCHEMA_SQL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

/**
 * 旧库改名让路，不删——事故记录哪怕格式过时也不该被工具自己抹掉。
 * WAL 的两个边车文件必须一起挪走，留下任何一个都会让新库读到半截旧状态。
 */
function archiveIfStale(file: string) {
  if (!existsSync(file)) return;
  const probe = new Database(file, { readonly: true });
  const version = Number(probe.pragma('user_version', { simple: true }));
  // `user_version` 的默认值就是 0，所以 0 既可能是一个空文件，也可能是一个没打过版本号的老库。
  // 靠有没有应用表来分：**有表的 0 号库必须按不兼容处理**——`CREATE TABLE IF NOT EXISTS`
  // 不会给已存在的表补列，放过它只会把老结构标成 v2，等第一次查 incident_date 才炸。
  const populated =
    !!probe
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('events','cases') LIMIT 1`)
      .get();
  probe.close();
  if (version === SCHEMA_VERSION || (version === 0 && !populated)) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(file + suffix)) renameSync(file + suffix, `${file}.v${version}.${stamp}.bak${suffix}`);
  }
  console.warn(`[db] schema v${version} → v${SCHEMA_VERSION}：旧库已挪到 ${file}.v${version}.${stamp}.bak，新建空库`);
}

export function blobDir(dbFile: string): string {
  return dbFile === ':memory:'
    ? path.join(process.env.TMPDIR ?? '/tmp', 'inquestry-blobs')
    : path.join(path.dirname(dbFile), 'blobs');
}
