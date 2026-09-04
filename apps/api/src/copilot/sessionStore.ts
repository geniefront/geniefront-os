import { randomUUID } from 'node:crypto';
import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';
import { withTenant } from '@gf/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_HISTORY_MESSAGES = 6;
const MAX_STORED_CONTENT_CHARS = 12_000;

type HistoryItem = { role: 'user' | 'assistant'; text: string };

export interface CopilotTurn {
  sessionId: string;
  history: HistoryItem[];
}

export interface StoredCopilotSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  userQueryCount: number;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  }>;
}

function tenant(ctx: CommandContext) {
  return { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId };
}

/** Begin one turn atomically and return server-owned history from before this question. */
export async function beginCopilotTurn(
  ctx: CommandContext,
  requestedSessionId: string | undefined,
  question: string,
  hadImage: boolean,
): Promise<CopilotTurn> {
  if (!ctx.membershipId) {
    throw new AppError(ERROR_CODES.UNAUTHENTICATED, {
      details: { reason: 'copilot_membership_required' },
    });
  }

  return withTenant(tenant(ctx), async (tx) => {
    // Retention is enforced lazily per actor as well as by expires_at filtering.
    // This keeps old transcripts from living forever even without a cron worker.
    await tx`delete from copilot_sessions where expires_at <= now()`;

    let sessionId = requestedSessionId && UUID_RE.test(requestedSessionId)
      ? requestedSessionId
      : randomUUID();

    await tx`
      insert into copilot_sessions
        (id, org_id, location_id, membership_id, title)
      values
        (${sessionId}, ${ctx.orgId}, ${ctx.locationId}, ${ctx.membershipId}, ${question.slice(0, 120)})
      on conflict (id) do nothing`;

    let [claimed] = await tx<{ id: string }[]>`
      update copilot_sessions
      set question_count = question_count + 1,
          updated_at = now(),
          expires_at = now() + interval '30 days'
      where id = ${sessionId}
        and org_id = ${ctx.orgId}
        and location_id = ${ctx.locationId}
        and membership_id = ${ctx.membershipId}
        and expires_at > now()
        and question_count < 10
      returning id`;

    // Expired/full/foreign IDs never get reused. A fresh UUID keeps session ownership
    // unambiguous even if a client sends stale or tampered local state.
    if (!claimed) {
      sessionId = randomUUID();
      await tx`
        insert into copilot_sessions
          (id, org_id, location_id, membership_id, title, question_count)
        values
          (${sessionId}, ${ctx.orgId}, ${ctx.locationId}, ${ctx.membershipId},
           ${question.slice(0, 120)}, 1)`;
      claimed = { id: sessionId };
    }

    const rows = await tx<{ role: 'user' | 'assistant'; content: string }[]>`
      select role, content
      from copilot_messages
      where session_id = ${claimed.id}
      order by created_at desc, id desc
      limit ${MAX_HISTORY_MESSAGES}`;

    await tx`
      insert into copilot_messages
        (org_id, location_id, membership_id, session_id, role, content, had_image)
      values
        (${ctx.orgId}, ${ctx.locationId}, ${ctx.membershipId}, ${claimed.id},
         'user', ${question.slice(0, MAX_STORED_CONTENT_CHARS)}, ${hadImage})`;

    return {
      sessionId: claimed.id,
      history: rows.reverse().map((row) => ({ role: row.role, text: row.content })),
    };
  });
}

export async function completeCopilotTurn(
  ctx: CommandContext,
  turn: CopilotTurn,
  output: {
    answer: string;
    source: 'local' | 'model';
    proposal?: { command: string; summary: string } | null;
    toolsUsed?: string[];
  },
): Promise<void> {
  if (!ctx.membershipId) return;
  const content = output.answer.trim().slice(0, MAX_STORED_CONTENT_CHARS);
  if (!content) return;
  await withTenant(tenant(ctx), async (tx) => {
    await tx`
      insert into copilot_messages
        (org_id, location_id, membership_id, session_id, role, content, source,
         proposal_command, proposal_summary, tool_names)
      values
        (${ctx.orgId}, ${ctx.locationId}, ${ctx.membershipId}, ${turn.sessionId},
         'assistant', ${content}, ${output.source},
         ${output.proposal?.command ?? null}, ${output.proposal?.summary ?? null},
         ${tx.array(output.toolsUsed ?? [])})`;
    await tx`
      update copilot_sessions set updated_at = now(), expires_at = now() + interval '30 days'
      where id = ${turn.sessionId}`;
  });
}

export async function loadCopilotSessions(ctx: CommandContext): Promise<StoredCopilotSession[]> {
  if (!ctx.membershipId) return [];
  return withTenant(tenant(ctx), async (tx) => {
    const rows = await tx<{
      session_id: string;
      title: string;
      question_count: number;
      session_created_at: string;
      session_updated_at: string;
      message_id: string | null;
      role: 'user' | 'assistant' | null;
      content: string | null;
      message_created_at: string | null;
    }[]>`
      with recent as (
        select id, title, question_count, created_at, updated_at
        from copilot_sessions
        where expires_at > now()
        order by updated_at desc
        limit 20
      )
      select
        recent.id as session_id,
        recent.title,
        recent.question_count,
        recent.created_at::text as session_created_at,
        recent.updated_at::text as session_updated_at,
        message.id as message_id,
        message.role,
        message.content,
        message.created_at::text as message_created_at
      from recent
      left join copilot_messages message on message.session_id = recent.id
      order by recent.updated_at desc, message.created_at asc, message.id asc`;

    const sessions = new Map<string, StoredCopilotSession>();
    for (const row of rows) {
      let session = sessions.get(row.session_id);
      if (!session) {
        session = {
          id: row.session_id,
          title: row.title,
          createdAt: row.session_created_at,
          updatedAt: row.session_updated_at,
          userQueryCount: row.question_count,
          messages: [],
        };
        sessions.set(row.session_id, session);
      }
      if (row.message_id && row.role && row.content && row.message_created_at) {
        session.messages.push({
          id: row.message_id,
          role: row.role,
          content: row.content,
          timestamp: row.message_created_at,
        });
      }
    }
    return [...sessions.values()];
  });
}

export async function deleteCopilotSession(
  ctx: CommandContext,
  sessionId: string,
): Promise<boolean> {
  if (!ctx.membershipId || !UUID_RE.test(sessionId)) return false;
  return withTenant(tenant(ctx), async (tx) => {
    const rows = await tx<{ id: string }[]>`
      delete from copilot_sessions where id = ${sessionId} returning id`;
    return rows.length === 1;
  });
}
