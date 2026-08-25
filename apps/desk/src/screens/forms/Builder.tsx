/**
 * 健康表模板编辑器（`docs/15` §2）。
 *
 * ## 三条贯穿这一屏的规矩
 *
 * **① 发布 = 发一个新版本，老的原地不动。**
 * `form_submissions` 存的是「他签的是第几版」。就地改的话，出事时
 * 我们拿不出「他当时签的到底是什么」—— 而那正是这张表存在的全部意义
 * （`00` §2）。所以这一屏没有「保存」，只有「发布新版本」。
 *
 * **② 六种语言缺一种，那种语言的客人签的表就不作数。**
 * 客人看不懂的免责书在法律上等于没签（宪法第 7 条在这里不是体验问题）。
 * 所以缺语言是**橙色警告**，不是灰色提示。
 *
 * **③ 题目 id 不给改。**
 * 答案是按 id 存的。改掉 id 等于让所有旧答案指向一道不存在的题 ——
 * 而这件事发生时没有任何报错，只是那一列在界面上永远显示空白。
 */

import { useState } from 'react';
import {
  Plus, Trash2, ChevronUp, ChevronDown, TriangleAlert, CircleAlert, Languages,
} from 'lucide-react';
import { ApiError, runCommand } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Sheet } from '../../ui/Overlay';
import { Badge } from '../../ui/Badge';
import { Card, Sunken } from '../../ui/Card';
import { Toggle } from '../../ui/Toggle';
import { Label } from '../../ui/Page';
import { InfoDot } from '../../ui/Info';
import { LOCALE_LABEL, LOCALES, type Locale } from '../../i18n';
import { pick, missingLocales, type FormPreset, type I18nText, type PresetQuestion } from './presets';

export interface DraftTemplate {
  key: string;
  title: I18nText;
  questions: PresetQuestion[];
  requiresSignature: boolean;
  validDays: number | null;
  /** 改的是已有的哪一份。null = 全新的 */
  existingVersion: number | null;
}

export const draftFromPreset = (p: FormPreset): DraftTemplate => ({
  key: p.key,
  title: { ...p.title },
  questions: p.questions.map((q) => ({ ...q })),
  requiresSignature: p.requiresSignature,
  validDays: p.validDays,
  existingVersion: null,
});

export const blankDraft = (): DraftTemplate => ({
  key: '',
  title: {},
  questions: [{ id: 'q1', type: 'bool', label: {}, required: true }],
  requiresSignature: true,
  validDays: 365,
  existingVersion: null,
});

const TYPE_LABEL: Record<PresetQuestion['type'], string> = {
  bool: '是 / 否',
  text: '填一句话',
  choice: '单选',
  multi: '多选',
};

export function Builder({
  open, onOpenChange, draft: initial, membershipId, locale, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  draft: DraftTemplate;
  membershipId: string;
  locale: Locale;
  onSaved: () => Promise<unknown>;
}) {
  const [d, setD] = useState<DraftTemplate>(initial);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const titleMissing = missingLocales(d.title);
  const keyBad = !/^[a-z][a-z_]*$/.test(d.key);
  const anyLabelMissing = d.questions.some((q) => missingLocales(q.label).length > 0);
  const canPublish = !keyBad && d.questions.length > 0 && titleMissing.length < LOCALES.length;

  function patch(p: Partial<DraftTemplate>) { setD((cur) => ({ ...cur, ...p })); }

  function patchQ(i: number, p: Partial<PresetQuestion>) {
    setD((cur) => ({
      ...cur,
      questions: cur.questions.map((q, n) => (n === i ? { ...q, ...p } : q)),
    }));
  }

  function move(i: number, by: number) {
    setD((cur) => {
      const next = [...cur.questions];
      const j = i + by;
      if (j < 0 || j >= next.length) return cur;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...cur, questions: next };
    });
    setOpenIdx(null);
  }

  function addQuestion() {
    setD((cur) => {
      // id 只增不复用：删掉 q3 之后新加的还是 q4，
      // 免得新题目继承到一道旧题的答案
      const n = cur.questions.reduce((m, q) => {
        const v = Number(/^q(\d+)$/.exec(q.id)?.[1] ?? 0);
        return v > m ? v : m;
      }, 0) + 1;
      return {
        ...cur,
        questions: [...cur.questions, { id: `q${n}`, type: 'bool', label: {}, required: false }],
      };
    });
    setOpenIdx(d.questions.length);
  }

  async function publish() {
    setBusy(true); setErr('');
    try {
      await runCommand('catalog.saveFormTemplate', {
        key: d.key,
        title: d.title,
        questions: d.questions.map((q) => ({
          id: q.id,
          type: q.type,
          label: q.label,
          required: q.required ?? false,
          ...(q.options ? { options: q.options } : {}),
          ...(q.sync ? { sync: q.sync } : {}),
        })),
        requiresSignature: d.requiresSignature,
        validDays: d.validDays,
        serviceIds: [],
      }, membershipId);
      await onSaved();
      onOpenChange(false);
    } catch (e) {
      setErr(e instanceof ApiError ? `没发出去（${e.code}）` : '没发出去');
    } finally { setBusy(false); }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={d.existingVersion ? `改一版（现在是 v${d.existingVersion}）` : '新建健康表'}
      description={d.existingVersion
        ? `发布会产生 v${d.existingVersion + 1}。已经签过 v${d.existingVersion} 的客人，记录仍然指着他签的那一版。`
        : '发布之后这一版就不能再改了 —— 要改就再发一版。'}
      width={760}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button variant="primary" className="flex-1" disabled={busy || !canPublish}
                  onClick={() => void publish()}>
            {d.existingVersion ? `发布 v${d.existingVersion + 1}` : '发布'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {err && (
          <div role="alert" className="flex items-center gap-2 rounded bg-danger-soft px-4 py-3 text-danger">
            <CircleAlert size={17} /><span className="text-xs font-semibold">{err}</span>
          </div>
        )}

        {anyLabelMissing && (
          <div className="flex items-start gap-2.5 rounded bg-warn-soft px-4 py-3.5 text-warn">
            <Languages size={17} className="mt-0.5 shrink-0" />
            <span className="text-xs leading-relaxed">
              <strong>有题目缺语言。</strong>
              客人看不懂的免责书在法律上等于没签 —— 缺哪种语言，
              那种语言的客人签的这份表就不作数。展开题目补齐。
            </span>
          </div>
        )}

        {/* ── 这份表叫什么 ── */}
        <section>
          <div className="flex items-baseline gap-2">
            <Label>这份表叫什么</Label>
            {titleMissing.length > 0 && (
              <Badge tone="warn"><TriangleAlert size={11} />缺 {titleMissing.length} 种语言</Badge>
            )}
          </div>
          <div className="mt-2.5">
            <I18nEditor value={d.title} onChange={(v) => patch({ title: v })} />
          </div>
        </section>

        {/* ── 内部代号 ── */}
        <section>
          <div className="flex items-baseline gap-1.5">
            <Label>内部代号</Label>
            <InfoDot text="同一个代号下的所有版本是同一份表的历史。客人看不到它，改代号等于新开一份表 —— 老的那份会停用但不会删。只能用小写字母和下划线。" />
          </div>
          <div className="mt-2.5">
            <Field mono value={d.key} placeholder="massage_intake"
                   disabled={d.existingVersion !== null}
                   onChange={(e) => patch({ key: e.target.value.toLowerCase().replace(/[^a-z_]/g, '') })}
                   aria-label="内部代号" />
            {keyBad && d.key.length > 0 && (
              <div className="mt-1.5 text-xs text-danger">只能用小写字母和下划线，且要以字母开头</div>
            )}
          </div>
        </section>

        {/* ── 题目 ── */}
        <section>
          <div className="flex items-center gap-3">
            <Label>题目</Label>
            <span className="tnum text-2xs text-ink-3">{d.questions.length} 题</span>
            <span className="flex-1" />
            <Button size="sm" onClick={addQuestion}><Plus size={15} />加一题</Button>
          </div>

          <div className="mt-2.5 flex flex-col gap-2">
            {d.questions.map((q, i) => (
              <QuestionRow
                key={q.id}
                q={q}
                locale={locale}
                open={openIdx === i}
                first={i === 0}
                last={i === d.questions.length - 1}
                onToggle={() => setOpenIdx(openIdx === i ? null : i)}
                onPatch={(p) => patchQ(i, p)}
                onMove={(by) => move(i, by)}
                onRemove={() => {
                  setD((cur) => ({ ...cur, questions: cur.questions.filter((_, n) => n !== i) }));
                  setOpenIdx(null);
                }}
              />
            ))}
          </div>
        </section>

        {/* ── 签名与有效期 ── */}
        <section className="flex flex-col gap-3">
          <Toggle
            checked={d.requiresSignature}
            onChange={(v) => patch({ requiresSignature: v })}
            label="要客人手写签名"
            hint="免责书要签，普通问卷不用。签名图存在私有桶里，只有有权限的人拿得到"
          />
          <div>
            <div className="flex items-baseline gap-1.5">
              <Label>多久要重签一次</Label>
              <InfoDot text="到期之后这份表在门口 iPad 和填表链接里会重新出现。「三年前签过一次」在法律上站不住 —— 客人的身体状况会变。" />
            </div>
            <div className="mt-2.5">
              <Select value={String(d.validDays ?? 'never')}
                      onChange={(e) => patch({
                        validDays: e.target.value === 'never' ? null : Number(e.target.value),
                      })}
                      aria-label="有效期">
                <option value="90">90 天</option>
                <option value="180">半年</option>
                <option value="365">一年（多数店用这个）</option>
                <option value="730">两年</option>
                <option value="never">永久有效</option>
              </Select>
            </div>
          </div>
        </section>
      </div>
    </Sheet>
  );
}

function QuestionRow({ q, locale, open, first, last, onToggle, onPatch, onMove, onRemove }: {
  q: PresetQuestion;
  locale: Locale;
  open: boolean;
  first: boolean;
  last: boolean;
  onToggle: () => void;
  onPatch: (p: Partial<PresetQuestion>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const missing = missingLocales(q.label);
  const hasOptions = q.type === 'choice' || q.type === 'multi';

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <button type="button" onClick={onToggle}
                className="min-w-0 flex-1 cursor-pointer text-left">
          <div className="truncate text-sm font-semibold">
            {pick(q.label, locale) || <span className="text-ink-3">（还没写题目）</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="line">{TYPE_LABEL[q.type]}</Badge>
            {q.required && <Badge tone="mute">必答</Badge>}
            {q.sync === 'avoid_areas' && <Badge tone="brand">回填「避开部位」</Badge>}
            {q.sync === 'health_flag' && <Badge tone="brand">回填「有禁忌」标记</Badge>}
            {missing.length > 0 && (
              <Badge tone="warn"><TriangleAlert size={11} />缺 {missing.length} 种语言</Badge>
            )}
          </div>
        </button>
        <Button variant="ghost" size="icon" aria-label="上移" disabled={first}
                onClick={() => onMove(-1)}><ChevronUp size={17} /></Button>
        <Button variant="ghost" size="icon" aria-label="下移" disabled={last}
                onClick={() => onMove(1)}><ChevronDown size={17} /></Button>
        <Button variant="ghost" size="icon" aria-label="删掉这一题"
                onClick={onRemove}><Trash2 size={17} /></Button>
      </div>

      {open && (
        <div className="flex flex-col gap-5 border-t border-line bg-ground px-4 py-4">
          <div>
            <Label>题目（六种语言）</Label>
            <div className="mt-2"><I18nEditor value={q.label} onChange={(v) => onPatch({ label: v })} /></div>
          </div>

          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <div>
              <Label>怎么答</Label>
              <div className="mt-2">
                <Select value={q.type} aria-label="题目类型"
                        onChange={(e) => {
                          const type = e.target.value as PresetQuestion['type'];
                          const needsOptions = type === 'choice' || type === 'multi';
                          // 换成是非题时把选项**留着**：换错了再换回来，
                          // 刚敲进去的六种语言不该因为点错一下就没了
                          onPatch(needsOptions
                            ? { type, options: q.options ?? [] }
                            : { type });
                        }}>
                  {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </div>
            </div>
            <div>
              <div className="flex items-baseline gap-1.5">
                <Label>要不要回填客户档案</Label>
                <InfoDot text="回填出去的只有两样东西：勾中的「避开部位」，以及一个「有禁忌」的布尔。「怀孕 28 周」「血栓史」这些明细只留在加密的健康表里，技师和前台在客户档案上看到的永远是「有禁忌，见前台」。" />
              </div>
              <div className="mt-2">
                <Select value={q.sync ?? 'none'} aria-label="回填目标"
                        onChange={(e) => onPatch(e.target.value === 'none'
                          ? { sync: undefined }
                          : { sync: e.target.value as 'avoid_areas' | 'health_flag' })}>
                  <option value="none">不回填</option>
                  <option value="avoid_areas">回填「避开部位」</option>
                  <option value="health_flag">回填「有禁忌」标记</option>
                </Select>
              </div>
            </div>
          </div>

          <Toggle checked={q.required ?? false} onChange={(v) => onPatch({ required: v })}
                  label="这一题必须答"
                  hint="⚠️「怀孕了吗」漏答和答「否」完全不是一回事 —— 前后端各挡一次" />

          {hasOptions && (
            <OptionsEditor options={q.options ?? []} locale={locale}
                           onChange={(options) => onPatch({ options })} />
          )}

          <div className="text-2xs text-ink-3">
            题目代号 <code className="font-mono">{q.id}</code> —— 答案按它存，所以不给改。
          </div>
        </div>
      )}
    </Card>
  );
}

function OptionsEditor({ options, locale, onChange }: {
  options: Array<{ value: string; label: I18nText }>;
  locale: Locale;
  onChange: (v: Array<{ value: string; label: I18nText }>) => void;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  return (
    <div>
      <div className="flex items-center gap-3">
        <Label>选项</Label>
        <span className="flex-1" />
        <Button size="sm" onClick={() => {
          onChange([...options, { value: `opt${options.length + 1}`, label: {} }]);
          setOpenIdx(options.length);
        }}><Plus size={15} />加一个</Button>
      </div>
      <div className="mt-2 flex flex-col gap-1.5">
        {options.map((o, i) => (
          <Sunken key={o.value} className="p-3">
            <div className="flex items-center gap-2">
              <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs font-semibold"
                      onClick={() => setOpenIdx(openIdx === i ? null : i)}>
                {pick(o.label, locale) || <span className="text-ink-3">（还没写）</span>}
              </button>
              {missingLocales(o.label).length > 0 && (
                <Badge tone="warn"><TriangleAlert size={11} />缺语言</Badge>
              )}
              <Button variant="ghost" size="icon" aria-label="删掉这个选项"
                      onClick={() => onChange(options.filter((_, n) => n !== i))}>
                <Trash2 size={16} />
              </Button>
            </div>
            {openIdx === i && (
              <div className="mt-3">
                <I18nEditor value={o.label} onChange={(label) => onChange(
                  options.map((x, n) => (n === i ? { ...x, label } : x)))} />
              </div>
            )}
          </Sunken>
        ))}
        {options.length === 0 && (
          <span className="text-xs text-ink-3">还没有选项 —— 单选和多选题至少要有两个。</span>
        )}
      </div>
    </div>
  );
}

/**
 * 六种语言一起编辑。
 *
 * 六个框一次全摆出来，不做「先选语言再输入」—— 后者会让人以为
 * 自己已经填完了（他只看得见当前那一种），而缺的那几种要等到
 * 一位越南客人站在门口才被发现。
 */
function I18nEditor({ value, onChange }: {
  value: I18nText;
  onChange: (v: I18nText) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {LOCALES.map((l) => (
        <div key={l} className="flex items-center gap-2.5">
          <span className="w-20 shrink-0 text-2xs font-bold uppercase tracking-wider text-ink-3">
            {LOCALE_LABEL[l]}
          </span>
          <Field
            className={(value[l] ?? '').trim() ? '' : 'border-warn/40'}
            value={value[l] ?? ''}
            onChange={(e) => onChange({ ...value, [l]: e.target.value })}
            aria-label={LOCALE_LABEL[l]}
          />
        </div>
      ))}
    </div>
  );
}
