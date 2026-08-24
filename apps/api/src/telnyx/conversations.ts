/**
 * Telnyx AI Assistant 的 conversation 记录（`/v2/ai/conversations`）。
 *
 * ## 为什么要主动去拉，而不是等 webhook
 *
 * 2026-08-23 第一通真实电话打完，`phone_calls` 是**空的** —— 而
 * `/v1/telnyx/webhook` 明明收到了两条请求。也就是说挂机那条事件
 * 要么发去了别处（Telnyx 的 connection 上可以单独配 webhook 地址），
 * 要么用的是别的事件名。
 *
 * 结果是：一通真实通话打完，我们既不知道它多长（= 没扣客户的语音分钟），
 * 也不知道 AI 在里面说了什么。**这种漏账是静默的** —— 没有任何报错，
 * 只有月底对不上的数字。
 *
 * 而 Telnyx 手里有一份更全的东西：每通电话一条 conversation，带
 * `to`/`from`/`call_session_id`/`called_tools`、起止时间，以及完整逐句转录
 * （连每次工具调用和它的返回都在）。所以计量改成两条腿：
 *
 *   webhook 到了  → 当场记（快，但可能永远不到）
 *   对账任务      → 从这里拉回来补（慢几分钟，但一定准）
 *
 * 两条腿写的是**同一条命令、同一个幂等键**，谁先到都不会重复计费。
 *
 * ⚠️ 这个文件只负责「从 Telnyx 拿数据 + 转成我们的形状」，不写库。
 * 写库一律走命令总线（宪法第 1 条）。
 */

const API = 'https://api.telnyx.com/v2';

export interface TelnyxConversation {
  id: string;
  createdAt: string;
  lastMessageAt: string | null;
  /** 被叫号码 —— 我们靠它定位门店，和电话工具同一条路 */
  toE164: string | null;
  fromE164: string | null;
  /** 一通电话从头到尾不变。和工具入参里的 call_session_id 是同一个 */
  callSessionId: string | null;
  assistantId: string | null;
  toolsUsed: string[];
}

export interface TelnyxMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  at?: string;
  tool?: string;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

async function get<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: authHeaders(apiKey) });
  if (!res.ok) {
    throw new Error(`telnyx ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return await res.json() as T;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/**
 * 最近的 conversation。
 *
 * ⚠️ Telnyx 的这个接口**不支持按 assistant_id 过滤**（试过，422 并列出
 * 可用字段）。所以取一页回来，在这边按 `metadata.to` 是不是我们绑过的号
 * 来筛 —— 反正定位门店本来就要走那一步。
 */
export async function listConversations(
  apiKey: string, opts: { since?: Date; limit?: number } = {},
): Promise<TelnyxConversation[]> {
  const body = await get<{ data?: Array<Record<string, unknown>> }>(
    `/ai/conversations?page[size]=${opts.limit ?? 50}`, apiKey);

  const out: TelnyxConversation[] = [];
  for (const c of body.data ?? []) {
    const md = (c['metadata'] ?? {}) as Record<string, unknown>;
    const createdAt = str(c['created_at']);
    if (!createdAt) continue;
    // Telnyx 的 created_at 不带时区后缀，按 UTC 读（它就是 UTC）
    const created = new Date(createdAt.endsWith('Z') ? createdAt : `${createdAt}Z`);
    if (opts.since && created < opts.since) continue;

    const tools = md['called_tools'];
    out.push({
      id: String(c['id']),
      createdAt: created.toISOString(),
      lastMessageAt: str(c['last_message_at'])
        ? new Date(`${str(c['last_message_at'])!.replace(/Z?$/, '')}Z`).toISOString()
        : null,
      toE164: str(md['to']),
      fromE164: str(md['from']),
      callSessionId: str(md['call_session_id']) ?? str(md['call_leg_id']),
      assistantId: str(md['assistant_id']),
      toolsUsed: Array.isArray(tools) ? tools.map(String) : [],
    });
  }
  return out;
}

/**
 * 一通电话的逐句转录。
 *
 * Telnyx 给的是**倒序**（最新在前），这里翻正 —— 前台读的是一段对话，
 * 不是一个栈。工具那几条把返回体压成一行摘要：整个 JSON 塞进去
 * 会让转录长到没人愿意读，而前台真正想知道的是「它调了什么、成没成」。
 */
export async function fetchTranscript(
  apiKey: string, conversationId: string, opts: { max?: number } = {},
): Promise<TelnyxMessage[]> {
  const body = await get<{ data?: Array<Record<string, unknown>> }>(
    `/ai/conversations/${conversationId}/messages`, apiKey);

  const rows = (body.data ?? []).slice().reverse();
  const out: TelnyxMessage[] = [];

  for (const m of rows) {
    const role = String(m['role'] ?? '') as TelnyxMessage['role'];
    if (!['user', 'assistant', 'tool', 'system'].includes(role)) continue;

    const calls = m['tool_calls'];
    const toolName = Array.isArray(calls) && calls.length > 0
      ? str((calls[0] as { function?: { name?: unknown } })?.function?.name)
      : null;

    let text = (str(m['text']) ?? '').trim();
    if (!text && toolName) text = `→ ${toolName}`;
    // 工具返回体压成一行：`{"ok":true,…}` 前 160 字就够看出成没成
    if (role === 'tool' && text.length > 160) text = `${text.slice(0, 160)}…`;
    if (!text) continue;

    out.push({
      role,
      text: text.slice(0, 4000),
      ...(str(m['created_at']) ? { at: str(m['created_at'])! } : {}),
      ...(toolName ? { tool: toolName } : {}),
    });
    if (out.length >= (opts.max ?? 400)) break;
  }
  return out;
}

/** 通话时长：最后一条消息减开始。Telnyx 不直接给秒数 */
export function durationOf(c: TelnyxConversation): number {
  if (!c.lastMessageAt) return 0;
  const ms = new Date(c.lastMessageAt).getTime() - new Date(c.createdAt).getTime();
  return Math.max(0, Math.round(ms / 1000));
}
