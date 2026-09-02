/**
 * 审计写入（宪法第 17 条）
 *
 * 留动作，不留金额。ticket / payment 相关命令的金额字段不写进 before/after，
 * 但「谁在几点因为什么做了这件事」照常留痕。
 *
 * 代价是明确的：失去「改动前是多少」的历史。老板端的折扣率、作废单数、
 * 现金差异改为从 tickets 实时算，不依赖审计快照。
 */

import type postgres from 'postgres';
import type { CommandContext } from '@gf/contracts';
import { jsonb } from '@gf/db';

/** 任何命令都不该把这些字段写进审计，无论是否显式声明 */
const ALWAYS_REDACT = [
  'pinHash', 'pin_hash', 'tokenHash', 'token_hash',
  'password', 'answersEncrypted', 'answers_encrypted',
  'manageToken', 'manage_token',
  'manageTokenWrapped', 'manage_token_wrapped',
];

/**
 * 按路径抹掉字段。支持 `a.b` 和 `a.*.b`（数组里每一项）。
 * 抹掉不是删除 —— 留 '[redacted]' 让人知道这里本来有东西。
 */
export function redact<T>(value: T, paths: readonly string[]): T {
  if (value === null || typeof value !== 'object') return value;
  const all = [...paths, ...ALWAYS_REDACT];
  const clone = structuredClone(value) as Record<string, unknown>;

  for (const path of all) {
    applyPath(clone, path.split('.'));
  }
  return clone as T;
}

function applyPath(node: unknown, segs: readonly string[]): void {
  if (node === null || typeof node !== 'object' || segs.length === 0) return;
  const [head, ...rest] = segs;

  if (head === '*') {
    const items = Array.isArray(node) ? node : Object.values(node);
    for (const item of items) applyPath(item, rest);
    return;
  }

  const obj = node as Record<string, unknown>;
  if (rest.length === 0) {
    if (head! in obj) obj[head!] = '[redacted]';
    return;
  }
  applyPath(obj[head!], rest);
}

export interface AuditEntry {
  command: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  /** 来自 CommandDef.auditRedact */
  redactPaths?: readonly string[];
  /** 撤销操作指向被撤销的那条 */
  undoOfId?: string;
}

export async function writeAudit(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  entry: AuditEntry,
): Promise<string> {
  const paths = entry.redactPaths ?? [];
  const before = entry.before === undefined ? null : redact(entry.before, paths);
  const after = entry.after === undefined ? null : redact(entry.after, paths);

  const rows = await tx<{ id: string }[]>`
    insert into audit_log
      (org_id, location_id, actor_id, actor_device_id, actor_kind, command,
       entity_type, entity_id, before, after, ip, undo_of_id)
    values
      (${ctx.orgId}, ${ctx.locationId}, ${ctx.membershipId}, ${ctx.deviceId ?? null}, ${ctx.actorKind}, ${entry.command},
       ${entry.entityType ?? null}, ${entry.entityId ?? null},
       ${before === null ? null : jsonb(before)}::jsonb,
       ${after === null ? null : jsonb(after)}::jsonb,
       ${ctx.ip ?? null}, ${entry.undoOfId ?? null})
    returning id`;

  return rows[0]!.id;
}
