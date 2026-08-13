/**
 * 内容寻址的原始输出存储。
 *
 * 库里只留 sha256 引用（data-model.md §1）：单次日志查询可达 MB 级、一次排查几十次调用，
 * 全塞进 sqlite 会把「完整留存原始输出」这条设计变成性能问题。
 * blob 目录与 events 合起来才是真相——重放时 FTS 正文从这里读回。
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type StoredBlob = { sha256: string; size: number; mime: string; lineCount: number };

export function storeBlob(dir: string, text: string, mime = 'text/plain'): StoredBlob {
  const sha256 = createHash('sha256').update(text).digest('hex');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sha256);
  // 内容寻址：同一份日志被多次引用时不重复写
  if (!existsSync(file)) writeFileSync(file, text, 'utf8');
  return { sha256, size: Buffer.byteLength(text), mime, lineCount: text.split('\n').length };
}

export function readBlobText(dir: string, sha256: string): string | null {
  const file = path.join(dir, sha256);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * 只读文件开头的若干字节。
 *
 * 快照里的 preview 只要前几行，而单个 blob 可以有几 MB——整份读进内存再切掉 99%
 * 是快照那条路上最贵的一步（每 60ms 一轮，乘上整个排查的历史调用数）。
 *
 * 截断按字节，末尾那行可能被切成半个字符，所以**截断时最后一行整条丢掉**：
 * preview 只承诺前几行完整，不承诺读满。
 */
export function readBlobHead(dir: string, sha256: string, maxBytes: number): string | null {
  const file = path.join(dir, sha256);
  if (!existsSync(file)) return null;
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, read).toString('utf8');
    if (read < maxBytes) return text;
    const cut = text.lastIndexOf('\n');
    return cut < 0 ? text : text.slice(0, cut);
  } finally {
    closeSync(fd);
  }
}

/** 按 `lineRange` 锚点取片段——UI 上点结论高亮原文的那一步。 */
export function readBlobLines(dir: string, sha256: string, anchor: string): string | null {
  const text = readBlobText(dir, sha256);
  return text === null ? null : sliceLines(text, anchor);
}

function sliceLines(text: string, anchor: string): string | null {
  const m = anchor.match(/(\d+)(?:\s*-\s*(\d+))?/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2] ?? m[1]);
  return text
    .split('\n')
    .slice(from - 1, to)
    .join('\n');
}

/**
 * 锚点定位：**行号只是提示，内容才是依据**。
 *
 * agent 给的行号来自它看到的正文，而正文常常自带另一套编号（日志工具经常打
 * `1 | …` 的行首序号，还可能有表头），跟 blob 的物理行号差一到几行。
 * 直接按物理行号高亮，就会在 UI 上悄悄指错行——错得毫无提示，比取不到更糟。
 *
 * 因此：先按行号取，取到的片段里若找不到 needle（该证据声称的时间串），
 * 就全文搜 needle 并返回真实行号。返回的 `anchor` 是**校正后**的，存进
 * `evidence_refs.anchor_resolved`，UI 一律用它。
 */
export function locateEvidence(
  text: string,
  anchor: string | undefined,
  needle: string | undefined,
): { anchor: string; excerpt: string; corrected: boolean } | null {
  const hinted = anchor ? sliceLines(text, anchor) : null;
  const key = needle?.replace(/^\d{4}-\d{2}-\d{2}[ T]/, '').trim();
  if (!key) return hinted && anchor ? { anchor, excerpt: hinted, corrected: false } : null;
  if (hinted?.includes(key)) return { anchor: anchor!, excerpt: hinted, corrected: false };

  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.includes(key));
  if (idx < 0) return hinted && anchor ? { anchor, excerpt: hinted, corrected: false } : null;
  return { anchor: String(idx + 1), excerpt: lines[idx]!, corrected: true };
}
