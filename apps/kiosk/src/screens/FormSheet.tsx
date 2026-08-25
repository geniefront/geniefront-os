/**
 * 健康表 / 免责书 —— 多语言阅读 + 手写签名。
 *
 * ⭐ 这一屏是**出事时唯一的证据**（00 §2），所以有几件事不能省：
 *
 *   1. **题目按客人选的语言显示**。他看不懂的免责书在法律上等于没签，
 *      而「我看不懂英文」是这类纠纷里最常见的抗辩。语言切换按钮
 *      在这一屏也必须随手可及。
 *   2. **他看的是哪种语言会跟着提交记录一起存**（form_submissions.locale）。
 *   3. **必答题在前端和服务端各挡一次**。「怀孕了吗」漏答和答「否」
 *      完全不是一回事。
 *   4. **监护人代签要能表达**：未成年人自己签没有效力。
 */

import { useEffect, useRef, useState } from 'react';
import { apiPost, type RequiredForm } from '../lib/api';
import { pick, type Locale } from '../i18n';

export function FormSheet({
  form, locale, t, defaultName, onDone, onCancel, submit: submitVia,
}: {
  form: RequiredForm;
  locale: Locale;
  t: (k: string) => string;
  defaultName: string;
  onDone: () => void | Promise<void>;
  onCancel: () => void;
  /**
   * 交到哪儿去。
   *
   * ⚠️ **这一屏不认识身份。** 门口 iPad 带设备令牌走 `/v1/kiosk/forms/submit`，
   * 客人自己手机上带填表令牌走 `/public/v1/forms/submit` —— 两条路的凭证、
   * 权限、失效方式都不一样，但**客人看到的那张表必须一模一样**：
   * 同一份题目、同一块签名板、同一套多语言。所以交表这一步由外面传进来，
   * 而不是在这里 if 一下。
   */
  submit?: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [signerName, setSignerName] = useState(defaultName);
  const [guardian, setGuardian] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const missing = form.questions
    .filter((q) => q.required && (answers[q.id] === undefined || answers[q.id] === null
      || answers[q.id] === ''))
    .map((q) => q.id);

  const canSubmit = missing.length === 0
    && signerName.trim().length > 0
    && (!form.requiresSignature || hasInk);

  async function submit() {
    setBusy(true); setErr('');
    try {
      const payload = {
        templateId: form.templateId,
        answers,
        ...(form.requiresSignature
          ? { signatureDataUrl: canvasRef.current?.toDataURL('image/png') }
          : {}),
        signerName: signerName.trim(),
        signerRelation: guardian ? 'guardian' : 'self',
        // ⭐ 存下他**当时看的是哪种语言**
        locale,
      };
      await (submitVia
        ? submitVia(payload)
        : apiPost('/v1/kiosk/forms/submit', payload));
      await onDone();
    } catch {
      setErr(t('err.generic'));
    } finally { setBusy(false); }
  }

  return (
    <div className="stack grow" style={{ gap: 16 }}>
      <div className="title">{pick(form.title, locale) || t('form.title')}</div>
      <div className="tiny">{t('form.readHint')}</div>

      {err && (
        <div className="card" style={{ padding: 16, borderColor: 'var(--warn)',
             background: 'var(--warn-soft)' }}>⚠ {err}</div>
      )}

      <div className="stack" style={{ gap: 18 }}>
        {form.questions.map((q) => {
          const label = pick(q.label, locale);
          const need = q.required && missing.includes(q.id);
          return (
            <div key={q.id} className="card stack"
                 style={{ padding: 20, gap: 12,
                          borderColor: need ? 'var(--warn)' : 'var(--line)' }}>
              <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                <span style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>{label}</span>
                {q.required && <span className="badge badge-warn">{t('form.required')}</span>}
              </div>

              {q.type === 'bool' && (
                <div className="row" style={{ gap: 14 }}>
                  {[true, false].map((v) => (
                    <button key={String(v)} className="btn grow"
                            style={{
                              borderColor: answers[q.id] === v ? 'var(--brand)' : 'var(--line)',
                              background: answers[q.id] === v ? 'var(--brand-soft)' : 'var(--surface)',
                            }}
                            onClick={() => setAnswers({ ...answers, [q.id]: v })}>
                      {v ? t('form.yes') : t('form.no')}
                    </button>
                  ))}
                </div>
              )}

              {q.type === 'text' && (
                <input className="field" value={String(answers[q.id] ?? '')}
                       onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
              )}

              {(q.type === 'choice' || q.type === 'multi') && (
                <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                  {(q.options ?? []).map((o) => {
                    const cur = answers[q.id];
                    const on = q.type === 'multi'
                      ? Array.isArray(cur) && cur.includes(o.value)
                      : cur === o.value;
                    return (
                      <button key={o.value} className="btn"
                              style={{
                                borderColor: on ? 'var(--brand)' : 'var(--line)',
                                background: on ? 'var(--brand-soft)' : 'var(--surface)',
                              }}
                              onClick={() => {
                                if (q.type === 'multi') {
                                  const arr = Array.isArray(cur) ? [...cur] as string[] : [];
                                  setAnswers({
                                    ...answers,
                                    [q.id]: on ? arr.filter((x) => x !== o.value) : [...arr, o.value],
                                  });
                                } else {
                                  setAnswers({ ...answers, [q.id]: o.value });
                                }
                              }}>
                        {on ? '☑ ' : '☐ '}{pick(o.label, locale)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 签名 */}
      {form.requiresSignature && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 12 }}>
            <span className="grow" style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>
              {t('form.signHere')}
            </span>
            <button className="btn" style={{ minHeight: 56 }}
                    onClick={() => { clearPad(canvasRef.current); setHasInk(false); }}>
              {t('form.clearSign')}
            </button>
          </div>
          <SignaturePad canvasRef={canvasRef} onInk={() => setHasInk(true)} />
        </div>
      )}

      <label className="stack" style={{ gap: 8 }}>
        <span className="sub">{t('form.signerName')}</span>
        <input className="field" value={signerName}
               onChange={(e) => setSignerName(e.target.value)} />
      </label>

      {/* 未成年人自己签没有效力 —— 要能表达「我是监护人」 */}
      <button className="btn btn-block"
              style={{
                justifyContent: 'flex-start',
                borderColor: guardian ? 'var(--brand)' : 'var(--line)',
                background: guardian ? 'var(--brand-soft)' : 'var(--surface)',
              }}
              onClick={() => setGuardian(!guardian)}>
        {guardian ? '☑' : '☐'} {t('form.guardian')}
      </button>

      {missing.length > 0 && (
        <div className="badge badge-warn" style={{ fontSize: 'var(--text-sm)' }}>
          {t('form.missing')}
        </div>
      )}

      <div className="row" style={{ gap: 14 }}>
        <button className="btn" style={{ minWidth: 160 }} disabled={busy} onClick={onCancel}>
          {t('phone.back')}
        </button>
        <button className="btn btn-primary grow" disabled={busy || !canSubmit}
                onClick={() => void submit()}>
          {busy ? <span className="spin" /> : t('form.submit')}
        </button>
      </div>
    </div>
  );
}

function clearPad(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  const g = canvas.getContext('2d');
  g?.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * 手写签名板。
 *
 * 用 Pointer Events 而不是 touch/mouse 各写一套 —— iPad 上手指和 Apple Pencil
 * 走的是同一套事件，分开写必然有一种设备被漏掉。
 *
 * ⚠️ canvas 的**位图尺寸**要按 devicePixelRatio 放大，只设 CSS 尺寸的话
 * 签出来的字在 Retina 屏上是糊的 —— 而这是要当证据用的图。
 */
function SignaturePad({ canvasRef, onInk }: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onInk: () => void;
}) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    const g = canvas.getContext('2d')!;
    g.scale(dpr, dpr);
    g.lineWidth = 3;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#1a1917';

    let drawing = false;
    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const down = (e: PointerEvent) => {
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      const p = pos(e);
      g.beginPath();
      g.moveTo(p.x, p.y);
      onInk();
    };
    const move = (e: PointerEvent) => {
      if (!drawing) return;
      const p = pos(e);
      g.lineTo(p.x, p.y);
      g.stroke();
    };
    const up = () => { drawing = false; };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', up);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', up);
    };
  }, [canvasRef, onInk]);

  return <canvas ref={canvasRef} className="sign-pad" />;
}
