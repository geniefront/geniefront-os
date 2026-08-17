/**
 * 意图路由：**最省钱的 AI 调用是没发生的那次**（05 §7.2 第 3 条）
 *
 * 前台 60–70% 的提问是「今天营收多少」「几点有空」「谁在等」——
 * 这些**根本不该走 LLM**：答案在快照里已经有了，走一趟模型要花
 * 一分多钱、等两秒，而且还有可能答错。
 *
 * 所以在调模型之前先过一层确定性匹配：命中就直接从快照里答，
 * 没命中才把请求送给模型。
 *
 * ## 三条设计纪律
 *
 * 1. **只匹配「明确无歧义」的说法。** 拿不准一律放过去给模型 ——
 *    关键词路由答错一次的代价，比多花一分钱大得多。
 * 2. **多语言**。前台可能说中文、英文、越南语。列表里三种都写。
 * 3. **只回答只读问题，永远不产生命令提案。** 这一层不允许有副作用，
 *    这样「路由错了」的最坏结果就只是一个答非所问的回答。
 */

import type { FloorSnapshot } from './snapshot.js';

/** 确定性路由能答的几类问题 */
export type LocalIntent =
  | 'queue_status'      // 谁在等 / 等多久
  | 'who_is_free'       // 谁有空 / 下一个是谁
  | 'next_appointments' // 接下来有什么单
  | 'now_working';      // 现在谁在做谁

export interface LocalAnswer {
  intent: LocalIntent;
  text: string;
}

/**
 * 关键词表。
 *
 * ⚠️ 加词条之前先问一句：**这个说法有没有第二种意思？**
 * 「下一个」既可能是「下一个轮到谁」也可能是「下一个预约是什么」，
 * 所以它**不在**任何一张表里 —— 有歧义的交给模型。
 */
const PATTERNS: Array<{ intent: LocalIntent; words: readonly string[] }> = [
  {
    intent: 'queue_status',
    words: [
      '几个人在等', '几位在等', '等位', '排队', '等的人', '还有几个人等',
      'who is waiting', 'how many waiting', 'wait list', 'waitlist', 'queue',
      'bao nhiêu người đợi', 'đang đợi',
    ],
  },
  {
    intent: 'who_is_free',
    words: [
      '谁有空', '谁空着', '谁闲着', '轮到谁', '该谁了', '下一个轮到谁',
      "who's free", 'who is free', 'who is available', 'whose turn', "who's next up",
      'ai đang rảnh', 'tới lượt ai',
    ],
  },
  {
    intent: 'now_working',
    words: [
      '现在谁在做', '谁在做单', '在做什么', '现在在忙什么',
      'who is working', "who's working", 'what is going on now',
      'ai đang làm',
    ],
  },
  {
    intent: 'next_appointments',
    words: [
      '接下来有什么', '接下来的预约', '待会有谁', '后面有什么单', '今天还有什么',
      'what is next', "what's next", 'upcoming appointments', 'next appointments',
      'lịch hẹn tiếp theo',
    ],
  },
];

const norm = (v: string): string =>
  v.toLowerCase().replace(/[\s,.!?，。！？、]+/g, ' ').trim();

/**
 * 试着在本地答掉。返回 null = 交给模型。
 *
 * **偏向放过**：只有整句话短到基本没有别的意思时才本地答。
 * 「谁有空？顺便把 Lisa 五点那单挪到六点」命中了关键词，
 * 但它显然要的是一个命令提案 —— 所以带了动作词的一律放过去。
 */
export function routeLocally(question: string, snapshot: FloorSnapshot): LocalAnswer | null {
  const q = norm(question);
  if (!q) return null;

  // ⭐ 一旦出现动作词就交给模型。这一条比关键词表本身更重要 ——
  // 少了它，「把 Lisa 挪到六点」会被「六点」之类的词误伤成一个只读回答，
  // 而前台以为自己已经改好了单
  if (ACTION_WORDS.some((w) => q.includes(w))) return null;

  for (const p of PATTERNS) {
    const hit = p.words.map(norm).find((w) => q.includes(w));
    if (!hit) continue;

    /**
     * ⭐ 命中的词必须**基本上就是整句话**。
     *
     * 第一版用的是「句子长度 < 40 字」，结果
     * 「谁有空啊，客人说她只想找上次那个做得比较轻的师傅，不知道今天在不在」
     * 才 35 字，照样被本地答成了一句「下一个轮到 Kim」——
     * 而前台真正在问的是一个需要查历史单据的问题。
     *
     * 中文一个字的信息量远大于一个英文字母，按绝对长度卡必然两头不是。
     * 按「关键词之外还剩多少内容」卡才对：剩得多，就说明这句话
     * 还有别的意思，交给模型。
     */
    if (q.length > hit.length + EXTRA_SLACK) return null;

    return { intent: p.intent, text: answerFor(p.intent, snapshot) };
  }
  return null;
}

/**
 * 关键词之外还能多几个字符。
 *
 * 8 个字符刚好放得下「？」「了」「吗」「啊」「现在」这类语气和限定词，
 * 放不下半句新内容。宁可小 —— 卡严了只是多花一分钱。
 */
const EXTRA_SLACK = 8;

/**
 * 动作词。命中任意一个就走模型。
 *
 * 宁可多花一分钱，也不要把一个写操作的请求当成只读问题答掉 ——
 * 前台会以为事情已经办了。
 */
const ACTION_WORDS: readonly string[] = [
  '挪', '改', '取消', '删', '加', '派', '开单', '结账', '约', '预约到', '换',
  '跳过', '休息', '叫号', '安排', '建', '设置', '充值',
  'move', 'reschedule', 'cancel', 'delete', 'add', 'assign', 'book',
  'check out', 'checkout', 'create', 'change', 'skip', 'set ', 'open ',
  'đổi', 'hủy', 'đặt',
];

function answerFor(intent: LocalIntent, s: FloorSnapshot): string {
  switch (intent) {
    case 'queue_status': {
      if (s.queue.length === 0) return '现在没有人在等位。';
      const overdue = s.queue.filter((q) => q.overdue);
      const head = `${s.queue.length} 位在等，最久的等了 ${
        Math.max(...s.queue.map((q) => q.waitedMin))} 分钟。`;
      const list = s.queue
        .map((q) => `#${q.ticketNumber} ${q.name}（${q.waitedMin} 分钟${q.overdue ? '，超时' : ''}）`)
        .join('、');
      // 超时的要单独点出来 —— 客人不会自己上来问，他会直接走
      const tail = overdue.length > 0
        ? `\n⚠️ 有 ${overdue.length} 位等得比说好的久了，建议先去说一声。` : '';
      return `${head}\n${list}${tail}`;
    }

    case 'who_is_free': {
      const next = s.turn.find((t) => t.state === 'available');
      const idle = s.idle;
      if (!next && idle.length === 0) return '现在所有人都在做单。';
      const parts: string[] = [];
      if (next) parts.push(`下一个轮到 ${next.name}（已做 ${next.turns.toFixed(1)} 轮）。`);
      if (idle.length > 0) parts.push(`空着的：${idle.join('、')}。`);
      // 被跳过和休息的人也要说 —— 前台看到「Tran 空着」会想派单给她，
      // 而她可能是因为不会做这个项目才被跳过的
      const blocked = s.turn.filter((t) => t.state === 'skipped' || t.state === 'break');
      if (blocked.length > 0) {
        parts.push(`暂时不排的：${blocked
          .map((t) => `${t.name}（${t.state === 'break' ? '休息中' : t.note ?? '已跳过'}）`)
          .join('、')}。`);
      }
      return parts.join('\n');
    }

    case 'now_working': {
      if (s.now.length === 0) return '现在没有在做的单。';
      return s.now
        .map((n) => `${n.staffName} 在给 ${n.customerName} 做 ${n.serviceName}，${n.endsAt} 做完。`)
        .join('\n');
    }

    case 'next_appointments': {
      if (s.next.length === 0) return '今天接下来没有预约了。';
      return s.next.slice(0, 5)
        .map((n) => `${n.startsAt} ${n.customerName} ${n.serviceName} ${n.durationMin} 分钟`
          + (n.staffName ? `，${n.staffName}` : '，还没派技师')
          + (n.isRequest ? '（点钟）' : ''))
        .join('\n');
    }
  }
}
