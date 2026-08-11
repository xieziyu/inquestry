/**
 * 投影器：events → 物化表。
 *
 * **写路径与重放路径共用这一个函数**——分成两份的那一刻，「可重放」就只是句口号。
 * 因此这里只能读事件载荷和已有投影，不能读时钟、不能生成 id。
 */

import type { Db } from './database.js';
import type { DomainEvent, EventName } from './events.js';
import { readBlobText } from './blobs.js';

export type ProjectorDeps = {
  /** FTS 需要 blob 正文，而正文不在库里（只存 sha256）——从 blob 目录读回来。 */
  blobDir: string;
  caseId: string;
};

export function applyEvent(db: Db, ev: DomainEvent, deps: ProjectorDeps): void {
  switch (ev.type) {
    case 'case.opened': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO cases (id,title,question,status,project_root,incident_date,tz_offset,clues,created_at,updated_at)
         VALUES (?,?,?,'open',?,?,?,?,?,?)`,
      ).run(
        p.caseId,
        p.title,
        p.question,
        p.projectRoot,
        p.incidentDate,
        p.tzOffset,
        p.clues,
        p.at,
        p.at,
      );
      return;
    }
    case 'session.started': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO sessions (id,case_id,backend,native_session_ref,model,effort,status,started_at)
         VALUES (?,?,?,?,?,?,'live',?)`,
      ).run(
        p.sessionId,
        p.caseId,
        p.backend,
        p.nativeSessionRef ?? null,
        p.model ?? null,
        p.effort ?? null,
        p.at,
      );
      return;
    }
    case 'session.ended': {
      const p = ev.payload;
      db.prepare(`UPDATE sessions SET status=?, ended_at=? WHERE id=?`).run(p.status, p.at, p.sessionId);
      return;
    }
    case 'step.opened': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO steps (id,session_id,parent_step_id,lane,ordinal,kind,direction,status,t_start)
         VALUES (?,?,?,?,?,?,?,'open',?)`,
      ).run(p.stepId, p.sessionId, p.parentStepId ?? null, p.lane ?? null, p.ordinal, p.kind, p.direction, p.at);
      if (p.direction) insertNarrative(db, deps.caseId, p.stepId, 'direction', p.direction);
      return;
    }
    case 'step.closed': {
      const p = ev.payload;
      db.prepare(
        `UPDATE steps SET status=?, verdict_text=?, verdict_confidence=?, t_end=? WHERE id=?`,
      ).run(p.status, p.verdict, p.confidence, p.at, p.stepId);
      insertNarrative(db, deps.caseId, p.stepId, 'verdict', p.verdict);
      return;
    }
    case 'step.superseded': {
      const p = ev.payload;
      db.prepare(`UPDATE steps SET status='superseded', superseded_by=? WHERE id=?`).run(p.by, p.stepId);
      return;
    }
    case 'blob.stored': {
      const p = ev.payload;
      db.prepare(
        `INSERT OR IGNORE INTO blobs (sha256,size,mime,line_count,created_at) VALUES (?,?,?,?,?)`,
      ).run(p.sha256, p.size, p.mime, p.lineCount, p.at);
      const text = readBlobText(deps.blobDir, p.sha256);
      if (text !== null) {
        db.prepare(`INSERT INTO payload_fts (sha256,case_id,text) VALUES (?,?,?)`).run(
          p.sha256,
          deps.caseId,
          text,
        );
      }
      return;
    }
    case 'toolcall.started': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO tool_calls (id,session_id,step_id,agent_id,tool_name,origin,input_json,
                                 input_rewritten,gate_decision,status,started_at)
         VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`,
      ).run(
        p.callId,
        p.sessionId,
        p.stepId,
        p.agentId ?? null,
        p.toolName,
        p.origin,
        p.input,
        p.inputRewritten ? 1 : 0,
        p.gateDecision,
        p.at,
      );
      return;
    }
    case 'toolcall.completed': {
      const p = ev.payload;
      db.prepare(`UPDATE tool_calls SET output_sha256=?, status=?, ended_at=? WHERE id=?`).run(
        p.outputSha256,
        p.status,
        p.at,
        p.callId,
      );
      return;
    }
    case 'evidence.attached': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO evidence_refs (id,step_id,tool_call_id,anchor_kind,anchor,anchor_resolved,claim,
                                    observed_at,occurred_at_ms,occurred_at_raw,occurred_source,actor)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        p.evidenceId,
        p.stepId,
        p.callId,
        p.anchorKind,
        p.anchor,
        p.anchorResolved,
        p.claim,
        p.observedAt,
        p.occurredAtMs,
        p.occurredAtRaw,
        p.occurredSource,
        p.actor,
      );
      insertNarrative(db, deps.caseId, p.evidenceId, 'evidence', p.claim);
      return;
    }
    default: {
      // 漏接新事件时这里编译期就报，不会等到 UI 上某类节点静默消失
      const never: never = ev;
      throw new Error(`未处理的事件: ${(never as { type: EventName }).type}`);
    }
  }
}

function insertNarrative(db: Db, caseId: string, refId: string, kind: string, text: string) {
  db.prepare(`INSERT INTO narrative_fts (ref_id,ref_kind,case_id,text) VALUES (?,?,?,?)`).run(
    refId,
    kind,
    caseId,
    text,
  );
}

/** 子表在前：外键开着时也能按这个顺序删干净。 */
export const PROJECTION_TABLES = [
  'evidence_refs',
  'tool_calls',
  'steps',
  'sessions',
  'cases',
  'blobs',
  'narrative_fts',
  'payload_fts',
];

/**
 * schema 迁移与排障用：清空投影后按 seq 重放。blob 目录不动，它是真相的另一半。
 *
 * caseId 取每条事件自己的，不由调用方给——重放是全库的事，用单个 caseId 会把
 * 别的案子的 FTS 行全标成同一个 case，检索时静默串台。
 */
export function rebuildProjections(db: Db, deps: Omit<ProjectorDeps, 'caseId'>): number {
  const rows = db.prepare(`SELECT case_id,type,payload FROM events ORDER BY seq`).all() as {
    case_id: string;
    type: string;
    payload: string;
  }[];
  db.transaction(() => {
    for (const t of PROJECTION_TABLES) db.prepare(`DELETE FROM ${t}`).run();
    for (const r of rows) {
      applyEvent(db, { type: r.type, payload: JSON.parse(r.payload) } as DomainEvent, {
        ...deps,
        caseId: r.case_id,
      });
    }
  })();
  return rows.length;
}
