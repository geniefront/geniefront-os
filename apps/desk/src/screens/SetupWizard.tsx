/**
 * 开店向导（docs/12 §3 C）。
 *
 * ## 它不是一个「向导」，是一张清单
 *
 * 一步一步往下走的向导有个致命问题：**卡在第三步出不去的向导，
 * 比没有向导糟得多** —— 他会关掉浏览器，然后打电话来问。
 * 所以这里是一张清单：每一项独立、随时能做、随时能跳过，
 * 顺序只是建议。
 *
 * ## 三条规矩（docs/12 §3 C）
 *
 * 1. **每一项都能跳过**，跳过不拦着他用系统。右上角那个
 *    「先进店看看」是真的能进去，不是骗他。
 * 2. **进度从真实数据推出来**，不存「走到第几步」。
 *    他从「⚙ 开店配置」里把项目建好了，这里那一项自己就变 ✓ ——
 *    存步数的话，他从别的设备登录进来会被拉回一个假的进度。
 * 3. **完成之后入口不消失**。这里每一项在「⚙ 开店配置」里都还在，
 *    这一屏只是把它们按「先做哪个」排了个序。
 *
 * ## 界面为什么长这样
 *
 * 用户画像是「四十岁以上、英文不好、店里光线杂、手上有水」
 * （`00` §2、宪法第 11 条）：大字、大按钮、≥44pt 的触摸目标，
 * 状态用**颜色 + 图标 + 文字三通道**传达 —— 只靠颜色的话，
 * 分不清红绿的老板看到的是一张没有状态的清单。
 */

import { useState } from 'react';
import { ApiError, runCommand } from '../lib/api';
import type { SettingsData } from './Settings';
import { TZ_LABEL, TZ_CHOICES } from './YelpFill';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Select } from '../ui/Select';
import { Spinner } from '../ui/Spinner';

const BUSINESS_TYPES: Array<[string, string]> = [
  ['nail', '美甲'], ['massage', '按摩'], ['foot_spa', '足疗'],
  ['lash', '美睫'], ['scalp', '头疗'], ['hair', '美发'], ['mixed', '综合'],
];

interface Step {
  key: string;
  title: string;
  why: string;
  done: boolean;
  /** 可选项跳过了也不影响开门做生意 */
  optional?: boolean;
}

export function SetupWizard({
  data, membershipId, onChanged, onPhotoSetup, onYelpFill, onOpenSettings, onEnterShop,
}: {
  data: SettingsData;
  membershipId: string;
  onChanged: () => Promise<unknown>;
  onPhotoSetup: () => void;
  onYelpFill: () => void;
  /** 跳到「⚙ 开店配置」的某个页签 —— 向导不重做那些界面，只是把人送过去 */
  onOpenSettings: (pane: 'service' | 'staff' | 'hours' | 'device' | 'phone') => void;
  /** 「先进店看看」。跳过向导不拦着他用（规矩 1） */
  onEnterShop: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [editProfile, setEditProfile] = useState(false);

  const bookable = data.staff.filter((s) => s.isBookable).length;
  const services = data.services.filter((s) => s.active).length;

  const steps: Step[] = [
    {
      key: 'profile', title: '确认店名、时区、业态',
      why: '时区错了，日程表和日结会整个错开一天',
      done: Boolean(data.location.profileConfirmedAt),
    },
    {
      key: 'address', title: '地址与营业时间',
      why: '输店名 + 邮编，从 Yelp 一次填好',
      done: data.location.hasAddress,
    },
    {
      key: 'service', title: `项目与价格${services > 0 ? `（已有 ${services} 个）` : ''}`,
      why: '拍一张墙上的价目表，自动建项目',
      done: services > 0,
    },
    {
      key: 'staff', title: `员工${bookable > 0 ? `（${bookable} 位可接客）` : ''}`,
      why: '有人能接客，轮牌板才转得起来',
      done: bookable > 0,
    },
    {
      key: 'phone', title: 'AI 帮你接电话', optional: true,
      why: '没人接的时候由 AI 接起来记下预约。可以以后再开',
      done: Boolean(data.phone.aiVoiceE164),
    },
  ];

  const required = steps.filter((s) => !s.optional);
  const leftCount = required.filter((s) => !s.done).length;

  async function run(name: string, input: unknown): Promise<boolean> {
    setBusy(true); setErr('');
    try {
      await runCommand(name, input, membershipId);
      await onChanged();
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? `没保存成功（${e.code}）` : '没保存成功');
      return false;
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-4.5" style={{ padding: '0 16px 32px',  maxWidth: 760, margin: '0 auto' }}>
      <div className="flex flex-col gap-1.5 pt-2">
        <div className="text-2xl font-extrabold">把店配起来</div>
        <div className="text-ink-2 text-base">
          {leftCount === 0
            ? '都配好了 —— 点下面那个大按钮就可以开张了。'
            : `还差 ${leftCount} 项就能开张。每一项都可以以后再弄，配置里随时找得到。`}
        </div>
      </div>

      {err && <Alert tone="danger">{err}</Alert>}

      {/* ── 1. 店铺信息 ───────────────────────────────────────────────── */}
      <StepCard step={steps[0]!} n={1}>
        {!editProfile && (
          <div className="flex flex-col gap-2.5">
            <Facts rows={[
              ['店名', data.location.name],
              ['时区', TZ_LABEL[data.location.timezone] ?? data.location.timezone],
              ['业态', BUSINESS_TYPES.find(([k]) => k === data.location.businessType)?.[1]
                ?? data.location.businessType],
            ]} />
            <Button variant="primary" style={{ minHeight: 'var(--tap)' }} onClick={() => setEditProfile(true)}>
              {steps[0]!.done ? '改一下' : '看一眼，确认'}
            </Button>
          </div>
        )}
        {editProfile && (
          <ProfileForm data={data} busy={busy}
                       onCancel={() => setEditProfile(false)}
                       onSave={async (input) => {
                         if (await run('location.saveProfile', input)) setEditProfile(false);
                       }} />
        )}
      </StepCard>

      {/* ── 2. 地址与营业时间 ─────────────────────────────────────────── */}
      <StepCard step={steps[1]!} n={2}>
        <div className="flex items-center gap-2.5 flex-wrap">
          <Button variant="primary" style={{ minHeight: 'var(--tap)' }} onClick={onYelpFill}>
            🔎 从 Yelp 一键填好
          </Button>
          <Button style={{ minHeight: 'var(--tap)' }} onClick={() => onOpenSettings('hours')}>
            自己填营业时间
          </Button>
        </div>
      </StepCard>

      {/* ── 3. 项目库 ─────────────────────────────────────────────────── */}
      <StepCard step={steps[2]!} n={3}>
        <div className="flex items-center gap-2.5 flex-wrap">
          <Button variant="primary" style={{ minHeight: 'var(--tap)' }} onClick={onPhotoSetup}>
            📷 拍价目表，自动建项目
          </Button>
          <Button style={{ minHeight: 'var(--tap)' }} onClick={() => onOpenSettings('service')}>
            一个一个手动加
          </Button>
        </div>
      </StepCard>

      {/* ── 4. 员工 ───────────────────────────────────────────────────── */}
      <StepCard step={steps[3]!} n={4}>
        <div className="flex items-center gap-2.5 flex-wrap">
          <Button variant="primary" style={{ minHeight: 'var(--tap)' }} onClick={() => onOpenSettings('staff')}>
            去设置员工
          </Button>
        </div>
        {bookable === 0 && (
          <div className="text-ink-2 text-xs text-ink-3" style={{ marginTop: 8, lineHeight: 1.7 }}>
            你自己也可以接客 —— 在员工里把自己打开「可接单」就行。
          </div>
        )}
      </StepCard>

      {/* ── 5. AI 电话（可选）─────────────────────────────────────────── */}
      <StepCard step={steps[4]!} n={5}>
        <Button style={{ minHeight: 'var(--tap)' }} onClick={() => onOpenSettings('phone')}>
          ☎️ 了解一下 / 开通
        </Button>
      </StepCard>

      {/* ── 完成 ──────────────────────────────────────────────────────── */}
      <Card className="flex flex-col p-5 gap-3">
        <div className="text-lg font-bold">开张</div>
        <div className="text-ink-2">
          {leftCount === 0
            ? '一切就绪。'
            : '还差几项也可以先开张 —— 这些配置在「⚙ 开店配置」里随时能改。'}
        </div>
        <Button variant="primary" block disabled={busy} style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)' }} onClick={() => void run('location.finishSetup', {})}>
          {busy ? <Spinner /> : '配好了，开张 →'}
        </Button>
        {/* 规矩 1：跳过不拦着他用。这个按钮是真的进得去 */}
        <Button block style={{ minHeight: 'var(--tap)' }} onClick={onEnterShop}>
          先进店看看，晚点再配
        </Button>
      </Card>
    </div>
  );
}

/**
 * 一项。
 *
 * ⚠️ 状态走**三个通道**：颜色（绿/黄）、图标（✓/○）、文字（已完成/待办）。
 * 只靠颜色的话，分不清红绿的老板看到的是一张没有状态的清单
 * （docs/12 §3 D）。
 */
function StepCard({ step, n, children }: {
  step: Step; n: number; children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3" style={{ padding: 20, gap: 12, borderLeft: `4px solid ${step.done ? 'var(--ok)' : 'var(--line)'}`, }}>
      <div className="flex items-center gap-3 items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="text-lg font-bold">
            {n}. {step.title}
          </div>
          <div className="text-ink-2">{step.why}</div>
        </div>
        <Badge tone={step.done ? 'ok' : 'warn'}
              style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
          {step.done ? '✓ 已完成' : step.optional ? '○ 可跳过' : '○ 待办'}
        </Badge>
      </div>
      {children}
    </Card>
  );
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center gap-3">
          <span className="text-ink-2" style={{ minWidth: 64 }}>{k}</span>
          <span className="font-semibold">{v}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 店名 / 时区 / 业态 / 营业日边界。
 *
 * ⚠️ **时区一定要让他看见并且能改。** 官网那边是拿浏览器猜的
 * （`Intl.DateTimeFormat().resolvedOptions().timeZone`），用 VPN 的人
 * 拿到的是错的 —— 而时区错了，这家店的日程、日结、提成全部错开一天。
 */
function ProfileForm({ data, busy, onSave, onCancel }: {
  data: SettingsData; busy: boolean;
  onSave: (input: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(data.location.name);
  const [tz, setTz] = useState(data.location.timezone);
  const [type, setType] = useState(data.location.businessType);
  const [cutoff, setCutoff] = useState(data.location.businessDayCutoff || '03:00');

  return (
    <div className="flex flex-col gap-3.5">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-3">店名（顾客和技师看到的就是它）</span>
        <Field  value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-3">时区 —— 一定要选对，日程表按它算</span>
        <Select value={tz} onChange={(e) => setTz(e.target.value)}>
          {/* 官网猜出来的时区如果不在这九个里，也得让他看得到自己现在是什么 */}
          {!TZ_CHOICES.includes(tz) && <option value={tz}>{tz}</option>}
          {TZ_CHOICES.map((z) => <option key={z} value={z}>{TZ_LABEL[z]}</option>)}
        </Select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-3">主要做什么</span>
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          {BUSINESS_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-3">
          营业日几点算「第二天」—— 开到凌晨的店要设在打烊之后（默认 03:00）
        </span>
        <Field  type="time" value={cutoff}
               onChange={(e) => setCutoff(e.target.value)} />
      </label>

      <div className="flex items-center gap-2.5">
        <Button variant="primary" className="min-w-0 flex-1" disabled={busy} style={{ minHeight: 'var(--tap)' }} onClick={() => void onSave({
                  // 店名按界面语言写回去。多语言那一层由「🌐 补齐多语言」负责，
                  // 这里不替他猜别的语言怎么写
                  name: { en: name, 'zh-Hans': name },
                  timezone: tz, businessType: type, businessDayCutoff: cutoff,
                })}>
          {busy ? <Spinner /> : '就这样，保存'}
        </Button>
        <Button style={{ minHeight: 'var(--tap)' }} onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}
