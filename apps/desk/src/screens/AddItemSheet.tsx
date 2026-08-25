/**
 * 给已开的单加项目 —— 客人做到一半说「再加个 gel」。
 *
 * 这在店里每天都发生，而在这一屏之前 `ticket.addItem` 没有任何入口，
 * 前台只能把单作废重开（连带把已经算好的提成和小费一起搅乱）。
 *
 * ⭐ **默认给这一单现在的技师做**，不是轮牌上的下一位。
 *
 * 加项几乎总是同一个人接着做 —— 客人手还泡在水里。默认派给轮牌下一位
 * 会平白多占一个人的轮次，而那个人根本没接到活；轮牌乱了之后
 * 技师之间的猜忌是最难消的（决策 12 那条流水就是为了防这个）。
 * 真要换人当然可以点，但那是少数情况，不该是默认。
 *
 * ⚠️ 默认按**加项**（addon）记而不是新项目（service）：
 * 加项跟着原单走，不单独占一段时间也不单独排队。记成 service 的话
 * 日程表上会凭空多出一格，而技师并没有多接一位客人。
 */

import { useMemo, useState } from 'react';
import { dollarsToCents } from '@gf/contracts';
import { ApiError, runCommand } from '../lib/api';
import type { OpenTicket } from './Checkout';
import type { DaySnapshot } from './DaySchedule';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Alert } from '../ui/Alert';
import { Card } from '../ui/Card';
import { Spinner } from '../ui/Spinner';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export function AddItemSheet({
  ticket, day, membershipId, onDone, onCancel,
}: {
  ticket: OpenTicket;
  day: DaySnapshot;
  membershipId: string;
  onDone: () => Promise<unknown>;
  onCancel: () => void;
}) {
  /** 这一单现在是谁在做 —— 加项默认跟着他 */
  const currentStaff = ticket.items[ticket.items.length - 1]?.membershipId ?? '';

  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState(currentStaff);
  const [kind, setKind] = useState<'addon' | 'service'>('addon');
  const [priceEdit, setPriceEdit] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');

  const bookable = day.staff.filter((s) => s.isBookable);
  const service = day.services.find((s) => s.id === serviceId) ?? null;

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const all = [...day.services].sort((a, b) => a.name.localeCompare(b.name));
    return kw ? all.filter((s) => s.name.toLowerCase().includes(kw)) : all;
  }, [day.services, q]);

  const priceCents = priceEdit.trim() === ''
    ? (service?.priceCents ?? 0)
    : dollarsToCents(priceEdit);

  async function submit() {
    if (!service || !staffId) return;
    setBusy(true); setErr('');
    try {
      await runCommand('ticket.addItem', {
        ticketId: ticket.ticketId,
        serviceId: service.id,
        membershipId: staffId,
        kind,
        ...(priceEdit.trim() === '' ? {} : { priceCentsOverride: priceCents }),
      }, membershipId);
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'TICKET_CLOSED'
        ? '这一单已经结过账了，加不了 —— 重开一单吧'
        : '加不上，再试一次');
    } finally { setBusy(false); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
      display: 'grid', placeItems: 'end center', zIndex: 55,
    }} onClick={onCancel}>
      <Card className="flex flex-col gap-3" onClick={(e) => e.stopPropagation()}
           style={{ width: 'min(620px,100%)', maxHeight: '92vh', overflow: 'auto',
                    padding: 24, gap: 16, borderRadius: '18px 18px 0 0' }}>

        <div className="flex flex-col gap-0.5">
          <div className="text-2xl font-extrabold">
            给 {ticket.customerName} 加一项
          </div>
          <div className="text-ink-2 text-xs text-ink-3">
            现在这单：{ticket.items.map((i) => `${i.staffName} · ${i.name}`).join('／')}
            {' · '}{money(ticket.subtotalCents)}
          </div>
        </div>

        {err && <Alert tone="danger">{err}</Alert>}

        <Field  placeholder="搜项目" value={q}
               onChange={(e) => setQ(e.target.value)} />

        <div className="flex flex-col gap-1.5" style={{ maxHeight: 260, overflow: 'auto' }}>
          {list.map((s) => (
            <Button className="flex items-center gap-3" key={s.id} onClick={() => setServiceId(s.id)}
                    style={{
                      minHeight: 'var(--tap)', textAlign: 'left', gap: 10, borderWidth: 2,
                      borderColor: serviceId === s.id ? 'var(--brand)' : 'var(--line)',
                      background: serviceId === s.id ? 'var(--brand-soft)' : 'var(--surface)',
                    }}>
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="text-xs text-ink-3">{s.durationMin} 分钟</span>
              <strong className="tnum">{money(s.priceCents)}</strong>
            </Button>
          ))}
          {list.length === 0 && <div className="text-ink-2 text-xs text-ink-3">没找到这个项目</div>}
        </div>

        {service && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-3">谁做（默认还是这一单的技师）</span>
              <div className="flex items-center gap-2 flex-wrap">
                {bookable.map((s) => (
                  <Button key={s.membershipId} onClick={() => setStaffId(s.membershipId)}
                          style={{
                            minHeight: 44, borderWidth: 2,
                            borderColor: staffId === s.membershipId ? 'var(--brand)' : 'var(--line)',
                            background: staffId === s.membershipId ? 'var(--brand-soft)' : 'var(--surface)',
                          }}>
                    {s.name}{s.membershipId === currentStaff ? ' ·在做' : ''}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-xs text-ink-3">多少钱（留空用原价 {money(service.priceCents)}）</span>
                <Field mono  inputMode="decimal" value={priceEdit}
                       placeholder={(service.priceCents / 100).toFixed(2)}
                       onChange={(e) => setPriceEdit(e.target.value)} />
              </label>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-xs text-ink-3">算加项还是单独一项</span>
                <div className="flex items-center gap-2">
                  {([['addon', '加项'], ['service', '单独一项']] as const).map(([k, l]) => (
                    <Button className="min-w-0 flex-1" key={k} onClick={() => setKind(k)}
                            style={{
                              minHeight: 44, borderWidth: 2,
                              borderColor: kind === k ? 'var(--brand)' : 'var(--line)',
                              background: kind === k ? 'var(--brand-soft)' : 'var(--surface)',
                            }}>{l}</Button>
                  ))}
                </div>
              </div>
            </div>

            <div className="text-xs text-ink-3 text-ink-2">
              加完之后这一单是 <strong>{money(ticket.subtotalCents + priceCents)}</strong>。
              提成和小费按加完之后的金额算。
            </div>
          </>
        )}

        <div className="flex items-center gap-2.5">
          <Button className="min-w-0 flex-1" style={{ minHeight: 'var(--tap)' }} onClick={onCancel}>先不加</Button>
          <Button variant="primary" className="min-w-0 flex-1" disabled={busy || !service || !staffId} style={{ minHeight: 'var(--tap)' }} onClick={() => void submit()}>
            {busy ? <Spinner /> : '加上'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
