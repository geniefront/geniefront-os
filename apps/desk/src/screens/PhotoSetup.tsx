/**
 * 拍照开店 —— 把墙上的价目表变成项目库（05-AI-INTEGRATION §4 / §5）
 *
 * 三步，一屏一步：
 *   ① 选照片 → ② 提取（等） → ③ 左原图 / 右表格逐项核对 → 一键回填
 *
 * 面向的人是「英文不好、四十岁以上、可能戴着手套」的老板（宪法第 11 条），
 * 所以：大按钮、大字、图标优先；没有任何快捷键（那是前台高频操作才有的，
 * 开店一辈子做几次，宪法第 12 条）。
 *
 * ⭐ 确认页做成左右对照不是为了好看。
 *   38 个项目里错 3 个，光看右边的表格老板根本认不出是哪 3 个 —— 他没有对照物。
 *   左边摆原图、点一行就在图上把那一行框出来，他三秒能核完一屏。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { dollarsToCents } from '@gf/contracts';
import { supabase } from '../lib/supabase';
import { ApiError, API_BASE, runCommand, apiGet } from '../lib/api';

/** 与 Opus 5 的视觉长边上限一致。超了 API 会自己缩，bbox 就不再是原图坐标 */
const MAX_EDGE_PX = 2576;
const MAX_IMAGES = 6;
const BUCKET = 'price-lists';

/** 界面上给老板看的语言名。只用于「其它语言」那一块，不影响任何计算 */
const LOCALE_LABEL: Record<string, string> = {
  en: 'English', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文',
  ko: '한국어', vi: 'Tiếng Việt', es: 'Español',
};

export interface BlueprintItemView {
  itemId: string;
  kind: 'service' | 'addon' | 'note' | 'price_modifier';
  name: Record<string, string>;
  displayName: string;
  /** displayName 取自哪个语言键 —— 改名字时只改这一格，别的语言不动 */
  displayLocale: string;
  /** 哪几格是机器补的。淡色显示，让老板一眼看出哪些还没人核过 */
  nameAuto: string[];
  category: string | null;
  durationMin: number | null;
  priceCents: number | null;
  priceIsFrom: boolean;
  variants: Array<{ label: string; priceCents: number; durationMin: number | null }>;
  confidenceBp: number;
  lowConfidence: boolean;
  sourceSeq: number | null;
  bbox: [number, number, number, number] | null;
  decision: 'pending' | 'accepted' | 'rejected';
  edited: boolean;
}

export interface BlueprintView {
  blueprintId: string;
  status: 'draft' | 'applied' | 'discarded';
  label: string | null;
  extractedAt: string | null;
  appliedAt: string | null;
  unresolved: Array<{ field: string; question: string }>;
  sources: Array<{
    seq: number; storagePath: string | null; widthPx: number | null; heightPx: number | null;
  }>;
  items: BlueprintItemView[];
  summary: {
    total: number; accepted: number; rejected: number;
    lowConfidence: number; services: number; notes: number;
  };
}

interface Shot {
  seq: number;
  file: File;
  /** 本地预览 URL。缩过之后的那一张 —— 和发给模型的、bbox 对应的是同一张 */
  objectUrl: string;
  base64: string;
  mediaType: string;
  widthPx: number;
  heightPx: number;
  storagePath: string | null;
}

const money = (c: number | null) => (c === null ? '—' : `$${(c / 100).toFixed(2).replace(/\.00$/, '')}`);

const KIND_LABEL: Record<BlueprintItemView['kind'], string> = {
  service: '项目',
  addon: '加项',
  note: '说明',
  price_modifier: '改价规则',
};

/**
 * 把照片缩到长边 2576px 以内。
 *
 * **不为了省流量压缩画质**（05 §5.1：价目表是密集小字，压了就认不出，
 * 省下的 token 远不如返工成本）。缩到 2576 的唯一理由是保住 bbox 的 1:1 ——
 * 超过这个尺寸 API 会自己缩一道，模型报的坐标就对不上老板屏幕上的那张图了。
 */
async function prepareImage(file: File, seq: number): Promise<Shot> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) => {
    // 0.92 是「肉眼看不出压过」的常用界线，小字还清楚
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('转码失败'))), 'image/jpeg', 0.92);
  });

  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }

  return {
    seq,
    file,
    objectUrl: URL.createObjectURL(blob),
    base64: btoa(bin),
    mediaType: 'image/jpeg',
    widthPx: w,
    heightPx: h,
    storagePath: null,
  };
}

export function PhotoSetup({
  membershipId, locationId, onDone, onCancel,
}: {
  membershipId: string;
  locationId: string;
  /** 落地成功，回去刷项目列表 */
  onDone: () => Promise<unknown>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<'pick' | 'working' | 'review'>('pick');
  const [shots, setShots] = useState<Shot[]>([]);
  const [view, setView] = useState<BlueprintView | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * objectUrl 不撤会一直占着内存（六张 4MB 的图），但撤早了确认页左边就是个破图。
   *
   * ⚠️ 不能写成 `useEffect(..., [shots])` 的清理函数：`setShots` 换的是数组引用，
   * 而里面的 objectUrl 是同一批。数组一变清理就跑，把**还在用**的 URL 撤掉 ——
   * 于是上传完 storagePath 之后，左边那张原图当场变成破图。
   * 攒在 ref 里、只在卸载时撤，才对得上它们真正的生命周期。
   */
  const createdUrls = useRef<string[]>([]);
  useEffect(() => () => {
    createdUrls.current.forEach((u) => URL.revokeObjectURL(u));
    createdUrls.current = [];
  }, []);

  async function pickFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setErr('');
    const chosen = [...files].slice(0, MAX_IMAGES);
    if (files.length > MAX_IMAGES) {
      setErr(`一次最多 ${MAX_IMAGES} 张，只用了前 ${MAX_IMAGES} 张。剩下的可以再拍一次。`);
    }
    setBusy(true);
    try {
      const prepared = await Promise.all(chosen.map((f, i) => prepareImage(f, i)));
      createdUrls.current.push(...prepared.map((s) => s.objectUrl));
      setShots(prepared);
    } catch {
      setErr('这些照片打不开，换 JPEG 或 PNG 试试');
    } finally { setBusy(false); }
  }

  /**
   * 上传原图 → 建草案 → 跑提取。
   *
   * 上传**失败不阻断**：照片存 Storage 只是为了老板下次打开还能看到原图对照，
   * 提取用的是请求体里的那份 base64。传不上去就少了左边那张图，其余照常
   *（宪法第 14 条的同一条精神：增强项永不成为阻断点）。
   */
  async function run() {
    setBusy(true); setErr(''); setNote(''); setStep('working');
    try {
      // 一次拍照的所有图放同一个文件夹，方便日后整批清理。
      // 第一段必须是 locationId —— Storage 的 RLS 策略就按它判断归属（sql/0014）。
      const folder = crypto.randomUUID();
      const withPaths: Shot[] = [];
      for (const s of shots) {
        const path = `${locationId}/${folder}/${s.seq}.jpg`;
        const { error } = await supabase.storage.from(BUCKET)
          .upload(path, await fetch(s.objectUrl).then((r) => r.blob()),
                  { contentType: 'image/jpeg', upsert: false });
        withPaths.push({ ...s, storagePath: error ? null : path });
      }
      setShots(withPaths);

      const created = await runCommand<{ blueprintId: string }>(
        'blueprint.createDraft',
        {
          label: `价目表 · ${new Date().toLocaleDateString('zh-CN')}`,
          sources: withPaths.map((s) => ({
            seq: s.seq, storagePath: s.storagePath,
            widthPx: s.widthPx, heightPx: s.heightPx,
          })),
        },
        membershipId,
      );
      const id = created.result.blueprintId;

      const { data } = await supabase.auth.getSession();
      const res = await fetch(`${API_BASE}/v1/blueprint/${id}/extract`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${data.session!.access_token}`,
          'Content-Type': 'application/json',
          'X-Membership-Id': membershipId,
        },
        body: JSON.stringify({
          images: withPaths.map((s) => ({
            seq: s.seq, base64: s.base64, mediaType: s.mediaType,
            widthPx: s.widthPx, heightPx: s.heightPx,
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new ApiError(body.code ?? 'INTERNAL', body.details ?? {}, false, res.status);
      }

      const bits: string[] = [];
      if (body.merged > 0) bits.push(`合并了 ${body.merged} 条重复的`);
      if (body.conflicts > 0) bits.push(`有 ${body.conflicts} 组同名不同价，已标黄`);
      if (body.dropped > 0) bits.push(`${body.dropped} 行没认出来`);
      if (body.failedImages?.length > 0) {
        bits.push(`第 ${body.failedImages.map((f: { seq: number }) => f.seq + 1).join('、')} 张没认出来，可以单独重拍`);
      }
      setNote(bits.join('；'));

      // 默认帮老板勾好「看得清的项目」，标黄的留给他自己看。
      // 38 行逐个点是行不通的，但全勾又等于没复核。
      await runCommand('blueprint.reviewAll',
        { blueprintId: id, decision: 'accepted', minConfidenceBp: 8500, kinds: ['service'] },
        membershipId);

      setView(await apiGet<BlueprintView>(`/v1/desk/blueprint/${id}`, membershipId));
      setStep('review');
    } catch (e) {
      setErr(e instanceof ApiError
        ? (e.code === 'EXTRACTION_FAILED'
            ? '这几张照片都没认出来。光线足一点、正对着拍、一次拍一块牌子，通常就好了。'
            : `提取失败（${e.code}）`)
        : '提取失败，检查一下网络');
      setStep('pick');
    } finally { setBusy(false); }
  }

  async function refresh(id: string) {
    setView(await apiGet<BlueprintView>(`/v1/desk/blueprint/${id}`, membershipId));
  }

  if (step === 'pick') {
    return (
      <PickPane
        shots={shots} busy={busy} err={err} fileInput={fileInput}
        onPick={pickFiles} onRun={run} onCancel={onCancel}
        onDrop={(seq) => setShots(shots.filter((s) => s.seq !== seq)
          .map((s, i) => ({ ...s, seq: i })))}
      />
    );
  }

  if (step === 'working' || !view) {
    return (
      <div className="center-page stack" style={{ gap: 16, textAlign: 'center' }}>
        <span className="spin" style={{ width: 40, height: 40 }} />
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>正在看你的价目表…</div>
        <div className="tiny" style={{ maxWidth: 380 }}>
          一张照片大概要半分钟。它在一行一行地读，不是在猜 ——
          读不准的行会标黄让你复核。
        </div>
      </div>
    );
  }

  return (
    <ReviewPane
      view={view} shots={shots} note={note} membershipId={membershipId}
      onRefresh={() => refresh(view.blueprintId)}
      onDone={onDone}
      onRestart={() => { setShots([]); setView(null); setStep('pick'); }}
    />
  );
}

// ───────────────────────────────────────────────────────────────── ① 选照片

function PickPane({
  shots, busy, err, fileInput, onPick, onRun, onCancel, onDrop,
}: {
  shots: Shot[]; busy: boolean; err: string;
  fileInput: React.RefObject<HTMLInputElement | null>;
  onPick: (f: FileList | null) => void;
  onRun: () => void; onCancel: () => void; onDrop: (seq: number) => void;
}) {
  return (
    <div className="stack" style={{ padding: '0 16px 24px', gap: 16, maxWidth: 760 }}>
      <div className="card stack" style={{ padding: 20, gap: 10 }}>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>📷 拍价目表，自动建项目</div>
        <div className="tiny" style={{ lineHeight: 1.7 }}>
          把墙上的价目表拍下来，系统会一行一行读出项目名、价格和时长，
          再摆给你逐个核对。<strong>核对之前不会建任何东西</strong>，你可以随时丢掉重来。
        </div>
      </div>

      {err && <div className="badge badge-warn" style={{ padding: '12px 16px' }}>⚠ {err}</div>}

      {shots.length > 0 && (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {shots.map((s) => (
            <div key={s.seq} className="card" style={{ padding: 8, position: 'relative' }}>
              <img src={s.objectUrl} alt={`第 ${s.seq + 1} 张`}
                   style={{ width: 150, height: 110, objectFit: 'cover', borderRadius: 8,
                            display: 'block' }} />
              <div className="tiny" style={{ textAlign: 'center', marginTop: 4 }}>
                第 {s.seq + 1} 张
              </div>
              <button className="btn" aria-label={`去掉第 ${s.seq + 1} 张`}
                      onClick={() => onDrop(s.seq)}
                      style={{ position: 'absolute', top: 2, right: 2, minHeight: 36,
                               minWidth: 36, padding: 0, borderRadius: 18 }}>✕</button>
            </div>
          ))}
        </div>
      )}

      <input ref={fileInput} type="file" accept="image/*" multiple
             style={{ display: 'none' }}
             onChange={(e) => onPick(e.target.files)} />

      <button className="btn btn-block" disabled={busy}
              style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)' }}
              onClick={() => fileInput.current?.click()}>
        {shots.length === 0 ? '📷 选价目表照片' : '换一批照片'}
      </button>

      <div className="tiny" style={{ lineHeight: 1.7 }}>
        一次最多 {MAX_IMAGES} 张。<strong>一张只拍一块牌子</strong>，正对着拍、别拍歪，
        字越清楚认得越准。手部一块、足部一块就分两张拍。
      </div>

      <div className="row" style={{ gap: 12 }}>
        <button className="btn grow" style={{ minHeight: 'var(--tap)' }} onClick={onCancel}>
          返回
        </button>
        <button className="btn btn-primary grow" disabled={busy || shots.length === 0}
                style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)' }}
                onClick={onRun}>
          {busy ? <span className="spin" /> : `开始读这 ${shots.length} 张 →`}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── ③ 左右对照确认

function ReviewPane({
  view, shots, note, membershipId, onRefresh, onDone, onRestart,
}: {
  view: BlueprintView; shots: Shot[]; note: string; membershipId: string;
  onRefresh: () => Promise<void>; onDone: () => Promise<unknown>; onRestart: () => void;
}) {
  const [focused, setFocused] = useState<string | null>(null);
  const [editing, setEditing] = useState<BlueprintItemView | null>(null);
  const [fallbackDur, setFallbackDur] = useState('45');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [applied, setApplied] = useState<number | null>(null);
  const [noteLocal, setNoteLocal] = useState('');

  const focusedItem = useMemo(
    () => view.items.find((i) => i.itemId === focused) ?? null, [view.items, focused]);

  // 点中的那一行来自哪张照片 —— 左边就显示那张，并把那一行框出来
  const shownSeq = focusedItem?.sourceSeq ?? view.sources[0]?.seq ?? 0;
  const shot = shots.find((s) => s.seq === shownSeq);
  const source = view.sources.find((s) => s.seq === shownSeq);

  /**
   * 把项目名补成六种语言（05 §4.4）。
   *
   * 客人在门口自助屏上看到的是自己的语言 —— 那正是那块屏存在的理由。
   * 只补缺的，已经有的（尤其是照片上印的原文）一格都不碰。
   */
  async function translate() {
    setBusy(true); setErr(''); setNoteLocal('');
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetch(`${API_BASE}/v1/blueprint/${view.blueprintId}/translate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${data.session!.access_token}`,
          'Content-Type': 'application/json',
          'X-Membership-Id': membershipId,
        },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(body.code ?? 'INTERNAL', body.details ?? {}, false, res.status);

      if (body.rejected) {
        // 整批被拒（对齐不可信）。**不含糊其辞** —— 说清楚是没补上，
        // 而不是「补了 0 个」，否则老板会以为已经补过了不用再点
        setErr('这次没补上，再点一次试试（翻译和项目对不上号，我们宁可不写）');
      } else if (body.filledCells === 0) {
        setNoteLocal('已经是齐的，没有需要补的');
      } else {
        setNoteLocal(`补齐了 ${body.filledItems} 个项目、${body.filledCells} 处名字。`
          + '淡色的是机器补的，点「改」可以改。');
      }
      await onRefresh();
    } catch (e) {
      if (!(e instanceof ApiError) || !err) {
        setErr(e instanceof ApiError ? `补齐失败（${e.code}）` : '补齐失败');
      }
    } finally { setBusy(false); }
  }

  async function run(name: string, input: unknown, idem?: string) {
    setBusy(true); setErr('');
    try {
      await runCommand(name, input, membershipId, idem);
      await onRefresh();
    } catch (e) {
      setErr(e instanceof ApiError ? `操作失败（${e.code}）` : '操作失败');
      throw e;
    } finally { setBusy(false); }
  }

  if (applied !== null) {
    return (
      <div className="center-page stack" style={{ gap: 18, textAlign: 'center' }}>
        <div style={{ fontSize: 56 }}>✅</div>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>
          建好了 {applied} 个项目
        </div>
        <div className="tiny" style={{ maxWidth: 380, lineHeight: 1.7 }}>
          现在就能开单了。价格、时长以后随时在「项目」里改 ——
          改那边才算数，这份草案已经封存成当时的记录。
        </div>
        <button className="btn btn-primary" style={{ minHeight: 'var(--tap-lg)', minWidth: 220 }}
                onClick={() => void onDone()}>
          去看项目列表
        </button>
      </div>
    );
  }

  const accepted = view.summary.accepted;

  return (
    <div className="stack" style={{ padding: '0 16px 24px', gap: 14 }}>
      {/* 汇总条：一眼看清「有几行要我操心」 */}
      <div className="card row" style={{ padding: '14px 18px', gap: 14, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--text-lg)' }}>读出 {view.summary.total} 行</strong>
        <span className="badge badge-ok">已勾 {accepted}</span>
        {view.summary.lowConfidence > 0 && (
          <span className="badge badge-warn">
            ⚠ {view.summary.lowConfidence} 行读得不确定，请重点看
          </span>
        )}
        {view.summary.notes > 0 && (
          <span className="badge badge-mute">{view.summary.notes} 行是说明，默认不建</span>
        )}
        <span className="grow" />
        <button className="btn" style={{ minHeight: 44 }} disabled={busy}
                onClick={() => void translate()}>
          🌐 补齐多语言
        </button>
        <button className="btn" style={{ minHeight: 44 }} disabled={busy}
                onClick={() => void run('blueprint.reviewAll',
                  { blueprintId: view.blueprintId, decision: 'accepted', kinds: ['service'] })}>
          全勾上
        </button>
        <button className="btn" style={{ minHeight: 44 }} disabled={busy}
                onClick={() => void run('blueprint.reviewAll',
                  { blueprintId: view.blueprintId, decision: 'rejected', kinds: ['service'] })}>
          全取消
        </button>
      </div>

      {note && <div className="badge badge-soft" style={{ padding: '10px 14px' }}>ℹ {note}</div>}
      {noteLocal && (
        <div className="badge badge-soft" style={{ padding: '10px 14px' }}>🌐 {noteLocal}</div>
      )}
      {err && <div className="badge badge-danger" style={{ padding: '10px 14px' }}>✕ {err}</div>}

      {view.unresolved.length > 0 && (
        <div className="card stack" style={{ padding: 16, gap: 8,
             background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>
          <strong>价目表上没写、需要你补的：</strong>
          {view.unresolved.map((u, i) => (
            <div key={i} className="tiny">· {u.question}</div>
          ))}
        </div>
      )}

      <div className="row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* 左：原图 + 高亮框 */}
        <div className="card" style={{ padding: 10, position: 'sticky', top: 76,
             flex: '1 1 320px', minWidth: 300, maxWidth: 480 }}>
          {shot && source ? (
            <div style={{ position: 'relative', lineHeight: 0 }}>
              <img src={shot.objectUrl} alt={`第 ${shownSeq + 1} 张价目表`}
                   style={{ width: '100%', borderRadius: 8, display: 'block' }} />
              {focusedItem?.bbox && source.widthPx && source.heightPx && (
                <span aria-hidden style={{
                  position: 'absolute',
                  left: `${(focusedItem.bbox[0] / source.widthPx) * 100}%`,
                  top: `${(focusedItem.bbox[1] / source.heightPx) * 100}%`,
                  width: `${((focusedItem.bbox[2] - focusedItem.bbox[0]) / source.widthPx) * 100}%`,
                  height: `${((focusedItem.bbox[3] - focusedItem.bbox[1]) / source.heightPx) * 100}%`,
                  border: '3px solid var(--brand)',
                  background: 'rgba(184,20,60,.12)',
                  borderRadius: 4, pointerEvents: 'none',
                }} />
              )}
            </div>
          ) : (
            <div className="tiny" style={{ padding: 24, textAlign: 'center' }}>
              这次没能保存原图，右边照常核对就行
            </div>
          )}
          <div className="tiny" style={{ textAlign: 'center', marginTop: 8 }}>
            第 {shownSeq + 1} 张 · 点右边任意一行，这里会把它框出来
          </div>
        </div>

        {/* 右：可编辑表格 */}
        <div className="stack" style={{ gap: 8, flex: '2 1 420px', minWidth: 320 }}>
          {view.items.map((it) => (
            <ItemRow key={it.itemId} item={it} busy={busy}
                     focused={it.itemId === focused}
                     onFocus={() => setFocused(it.itemId)}
                     onEdit={() => setEditing(it)}
                     onToggle={() => void run('blueprint.reviewItem', {
                       itemId: it.itemId,
                       decision: it.decision === 'accepted' ? 'rejected' : 'accepted',
                     })} />
          ))}
        </div>
      </div>

      {/* 落地条 */}
      <div className="card stack" style={{ padding: 18, gap: 14, position: 'sticky', bottom: 0,
           borderColor: 'var(--brand)', boxShadow: 'var(--shadow)' }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="tiny">价目表上没写时长的，按</span>
          {[15, 30, 45, 60, 90].map((m) => (
            <button key={m} className="btn" disabled={busy}
                    onClick={() => setFallbackDur(String(m))}
                    style={{
                      minHeight: 48, borderWidth: 2,
                      borderColor: fallbackDur === String(m) ? 'var(--brand)' : 'var(--line)',
                      background: fallbackDur === String(m) ? 'var(--brand-soft)' : 'var(--surface)',
                    }}>{m} 分钟</button>
          ))}
          <span className="tiny">算</span>
        </div>

        <div className="row" style={{ gap: 12 }}>
          <button className="btn" style={{ minHeight: 'var(--tap)' }} disabled={busy}
                  onClick={onRestart}>重拍</button>
          <button className="btn" style={{ minHeight: 'var(--tap)' }} disabled={busy}
                  onClick={() => void run('blueprint.discard',
                    { blueprintId: view.blueprintId }).then(onDone)}>
            丢掉这次
          </button>
          <span className="grow" />
          <button className="btn btn-primary" disabled={busy || accepted === 0}
                  style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)', minWidth: 260 }}
                  onClick={async () => {
                    try {
                      setBusy(true); setErr('');
                      // 幂等键在客户端生成：网差的店里点两下「落地」，
                      // 第二下必须什么都不做 —— 否则项目库里会出现两套一模一样的 38 个项目
                      const out = await runCommand<{ createdServiceIds: string[] }>(
                        'blueprint.apply',
                        {
                          blueprintId: view.blueprintId,
                          fallbackDurationMin: Number(fallbackDur) || 45,
                        },
                        membershipId,
                        `apply-${view.blueprintId}`,
                      );
                      setApplied(out.result.createdServiceIds.length);
                    } catch (e) {
                      setErr(e instanceof ApiError ? `落地失败（${e.code}）` : '落地失败');
                    } finally { setBusy(false); }
                  }}>
            {busy ? <span className="spin" /> : `✓ 建这 ${accepted} 个项目`}
          </button>
        </div>
      </div>

      {editing && (
        <EditSheet item={editing} busy={busy}
                   onCancel={() => setEditing(null)}
                   onSave={async (patch) => {
                     await run('blueprint.reviewItem', { itemId: editing.itemId, ...patch });
                     setEditing(null);
                   }} />
      )}
    </div>
  );
}

function ItemRow({
  item, busy, focused, onFocus, onEdit, onToggle,
}: {
  item: BlueprintItemView; busy: boolean; focused: boolean;
  onFocus: () => void; onEdit: () => void; onToggle: () => void;
}) {
  const on = item.decision === 'accepted';
  const buildable = item.kind === 'service' || item.kind === 'addon';

  return (
    <div className="card row" onClick={onFocus}
         style={{
           padding: '12px 14px', gap: 12, cursor: 'pointer',
           // 三通道标注：颜色 + 图标 + 文字（宪法第 11 条，很多老板分不清红绿）
           borderWidth: focused ? 3 : 2,
           borderColor: focused ? 'var(--brand)'
             : item.lowConfidence ? 'var(--warn)' : 'var(--line)',
           background: item.lowConfidence ? 'var(--warn-soft)' : 'var(--surface)',
           opacity: buildable ? 1 : .62,
         }}>
      <button aria-label={on ? '取消这一项' : '选上这一项'}
              disabled={busy || !buildable}
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              style={{ background: 'none', border: 0, fontSize: 26, padding: 0,
                       cursor: buildable ? 'pointer' : 'default', lineHeight: 1 }}>
        {on ? '☑' : '☐'}
      </button>

      <div className="grow stack" style={{ gap: 3, minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <strong className="truncate" style={{ fontSize: 'var(--text-lg)' }}>
            {item.displayName}
          </strong>
          {!buildable && <span className="badge badge-mute">{KIND_LABEL[item.kind]}</span>}
          {item.lowConfidence && <span className="badge badge-warn">⚠ 看不太清</span>}
          {item.edited && <span className="badge badge-soft">已改</span>}
          {/* 淡色 = 机器补的、还没人核过。不用警告色 —— 它不是错误，只是「没人看过」 */}
          {item.nameAuto.length > 0 && (
            <span className="badge badge-mute" style={{ opacity: .75 }}>
              🌐 补了 {item.nameAuto.length} 种
            </span>
          )}
        </div>
        <div className="tiny">
          {item.category && <span>{item.category} · </span>}
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {money(item.priceCents)}{item.priceIsFrom && ' 起'}
          </span>
          {' · '}
          {item.durationMin ? `${item.durationMin} 分钟` : '时长没写'}
          {item.variants.length > 0 && ` · ${item.variants.length} 个档位`}
        </div>
      </div>

      <button className="btn" style={{ minHeight: 44 }} disabled={busy}
              onClick={(e) => { e.stopPropagation(); onEdit(); }}>改</button>
    </div>
  );
}

function EditSheet({
  item, busy, onCancel, onSave,
}: {
  item: BlueprintItemView; busy: boolean;
  onCancel: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(item.displayName);
  /** 其它语言。改哪一格就只写哪一格 —— 见下面 onSave 的注释 */
  const [others, setOthers] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(item.name)) if (k !== item.displayLocale) o[k] = v;
    return o;
  });
  const [showLangs, setShowLangs] = useState(false);
  const [price, setPrice] = useState(
    item.priceCents === null ? '' : (item.priceCents / 100).toFixed(2).replace(/\.00$/, ''));
  const [dur, setDur] = useState(item.durationMin ? String(item.durationMin) : '');

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
                  display: 'grid', placeItems: 'end center', zIndex: 60 }}
         onClick={onCancel}>
      <div className="card stack" onClick={(e) => e.stopPropagation()}
           style={{ width: 'min(560px,100%)', padding: 24, gap: 16,
                    borderRadius: '18px 18px 0 0' }}>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>改这一项</div>

        <label className="stack" style={{ gap: 6 }}>
          <span className="tiny">项目名（照片上印的是什么就写什么）</span>
          <input className="field" value={name} autoFocus
                 onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="row" style={{ gap: 12 }}>
          <label className="stack grow" style={{ gap: 6 }}>
            <span className="tiny">多少钱（美元）</span>
            <input className="field field-mono" inputMode="decimal" value={price}
                   placeholder="45" onChange={(e) => setPrice(e.target.value)} />
          </label>
          <label className="stack grow" style={{ gap: 6 }}>
            <span className="tiny">要多久（分钟，留空用下面的默认值）</span>
            <input className="field field-mono" inputMode="numeric" value={dur}
                   placeholder="45" onChange={(e) => setDur(e.target.value)} />
          </label>
        </div>

        {Object.keys(others).length > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            <button className="btn" style={{ minHeight: 40 }}
                    onClick={() => setShowLangs((v) => !v)}>
              🌐 其它语言（{Object.keys(others).length} 种）{showLangs ? '收起' : '展开'}
            </button>
            {showLangs && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="tiny">
                  <strong>淡色的是机器补的</strong>，客人在门口自助屏上看到的就是这些。
                  改一处就不再是机器补的了。
                </div>
                {Object.entries(others).map(([loc, val]) => (
                  <label key={loc} className="stack" style={{ gap: 4 }}>
                    <span className="tiny">
                      {LOCALE_LABEL[loc] ?? loc}
                      {item.nameAuto.includes(loc) && ' · 机器补的'}
                    </span>
                    <input className="field" value={val}
                           style={{ opacity: item.nameAuto.includes(loc) ? .65 : 1 }}
                           onChange={(e) => setOthers((o) => ({ ...o, [loc]: e.target.value }))} />
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {item.variants.length > 0 && (
          <div className="tiny">
            这一项有 {item.variants.length} 个档位（
            {item.variants.map((v) => `${v.label} ${money(v.priceCents)}`).join('、')}
            ），落地时会建成 {item.variants.length} 个项目。
          </div>
        )}

        <div className="row" style={{ gap: 10 }}>
          <button className="btn grow" style={{ minHeight: 'var(--tap)' }}
                  onClick={onCancel}>取消</button>
          <button className="btn btn-primary grow" disabled={busy || !name.trim()}
                  style={{ minHeight: 'var(--tap)' }}
                  onClick={() => void onSave({
                    /**
                     * ⚠️ 只改**显示的那一格**，其余语言原样带回去。
                     *
                     * 原来这里写的是 `{ 'zh-Hans': 名字, en: 名字 }` 两格一起盖 ——
                     * 在没有真翻译的时候无害，但补齐上线之后，老板改一次
                     * 英文名就会把补好的中文覆盖成英文。
                     */
                    name: {
                      ...item.name,
                      ...others,
                      [item.displayLocale]: name.trim(),
                    },
                    priceCents: price.trim() === '' ? null : dollarsToCents(price),
                    durationMin: dur.trim() === '' ? null : Number(dur),
                    decision: 'accepted',
                  })}>
            {busy ? <span className="spin" /> : '保存并勾上'}
          </button>
        </div>
      </div>
    </div>
  );
}
