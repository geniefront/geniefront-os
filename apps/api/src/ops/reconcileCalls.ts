/**
 * 手动跑一次通话对账（运维用）。
 *
 *   pnpm exec tsx apps/api/src/ops/reconcileCalls.ts            # 最近 3 小时
 *   pnpm exec tsx apps/api/src/ops/reconcileCalls.ts 1440       # 最近一天
 *
 * 平时不用跑 —— API 起来之后会按 `TELNYX_RECONCILE_MINUTES` 自己跑
 * （见 `telnyx/schedule.ts`）。这个脚本是给两种情况准备的：
 * 刚上线要补历史通话，或者怀疑某几通没记上。
 */

import { closeDb } from '@gf/db';
import { reconcileCalls } from '../telnyx/reconcile';

const minutes = Number(process.argv[2] ?? 180);

const log = {
  info: (o: unknown, m: string) => console.log(m, JSON.stringify(o)),
  warn: (o: unknown, m: string) => console.warn('⚠️ ', m, JSON.stringify(o)),
};

reconcileCalls({ sinceMinutes: Number.isFinite(minutes) ? minutes : 180, log })
  .then((r) => {
    console.log(`\n  扫了 ${r.scanned} 条会话：记下 ${r.recorded}，跳过 ${r.skipped}（不是我们的号），失败 ${r.failed}\n`);
  })
  .catch((e) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => closeDb());
