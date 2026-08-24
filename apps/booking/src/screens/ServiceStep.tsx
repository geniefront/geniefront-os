/**
 * 第一步：选项目。
 *
 * ⚠️ 这里显示的**只有**老板逐项勾过「可在线预约」的项目 ——
 * 接口那边就已经筛过了（docs/13 §4.2）。要面谈报价的项目不该出现在
 * 一个陌生人能自助下单的地方。
 *
 * 一个项目都没有时说人话：「这家店还没开放网上预约」+ 电话，
 * 而不是一个空列表 —— 空列表看起来像网站坏了。
 */

import { useState } from 'react';
import type { Catalog, Shop } from '../lib/api';
import { duration, money } from '../lib/format';
import { Card, Dock, Note } from './Chrome';

export function ServiceStep({ catalog, shop, onPick }: {
  catalog: Catalog;
  shop: Shop;
  onPick: (serviceId: string, addonIds: string[]) => void;
}) {
  /**
   * ⭐ 选完主项目、店里又有加项时，先停在这里让客人勾（docs/13 §4.2）。
   *
   * 为什么不放到后面某一步：加项**会加长时长**，而时长决定了哪些时段
   * 放得下这一单。选完时间再加一个 15 分钟的加项，等于让他重选一次时间 ——
   * 或者更糟，我们默默按短的时长给他订下去。
   */
  const [picked, setPicked] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  if (catalog.services.length === 0) {
    return (
      <Card>
        <h2 className="card-title">暂时不能网上预约</h2>
        <p className="card-sub">这家店还没有开放可以自助预约的项目。</p>
        {shop.phone && (
          <a className="btn btn-primary" style={{ display: 'grid', placeItems: 'center' }}
             href={`tel:${shop.phone}`}>致电预约 {shop.phone}</a>
        )}
      </Card>
    );
  }

  const pickedService = catalog.services.find((s) => s.id === picked);
  if (pickedService) {
    const extraMin = catalog.addons
      .filter((a) => chosen.includes(a.id)).reduce((n, a) => n + a.durationMin, 0);
    const extraCents = catalog.addons
      .filter((a) => chosen.includes(a.id)).reduce((n, a) => n + a.priceCents, 0);

    return (
      <>
      <Card>
        <h2 className="card-title">要加点什么吗？</h2>
        <p className="card-sub">
          {pickedService.name} · {duration(pickedService.durationMin)} ·
          {' '}{money(pickedService.priceCents, shop.currency)}
        </p>

        {catalog.addons.map((a) => {
          const on = chosen.includes(a.id);
          return (
            <button key={a.id} type="button"
                    className={`opt${on ? ' sel' : ''}`}
                    aria-pressed={on}
                    onClick={() => setChosen((c) =>
                      on ? c.filter((x) => x !== a.id) : [...c, a.id])}>
              <span className="opt-main">
                <span className="opt-name">{on ? '✓ ' : ''}{a.name}</span>
                <span className="opt-meta">
                  ＋{duration(a.durationMin)}
                  {a.description ? ` · ${a.description}` : ''}
                </span>
              </span>
              {/* 加项报的是「加多少」，不是「多少钱一次」—— 它不能单独订 */}
              <span className="opt-price">＋{money(a.priceCents, shop.currency)}</span>
            </button>
          );
        })}

      </Card>

      <Dock>
        <button className="btn btn-ghost" type="button"
                onClick={() => { setPicked(null); setChosen([]); }}>
          上一步
        </button>
        <button className="btn btn-primary" type="button"
                onClick={() => onPick(pickedService.id, chosen)}>
          {chosen.length > 0
            ? `选时间 · ${duration(pickedService.durationMin + extraMin)} · ${money(pickedService.priceCents + extraCents, shop.currency)}`
            : '不用加，选时间'}
        </button>
      </Dock>
      </>
    );
  }

  const choose = (id: string) => {
    // 店里没有加项就别多一步 —— 那一步对他毫无意义
    if (catalog.addons.length === 0) { onPick(id, []); return; }
    setChosen([]);
    setPicked(id);
  };

  // 有分类就分组显示。没分类的项目归到最后，标题留空 ——
  // 硬塞一个「其他」会让只有几个项目的小店看起来乱
  const groups = catalog.categories
    .map((c) => ({ ...c, items: catalog.services.filter((s) => s.categoryId === c.id) }))
    .filter((g) => g.items.length > 0);
  const loose = catalog.services.filter(
    (s) => !s.categoryId || !groups.some((g) => g.id === s.categoryId));

  return (
    <Card>
      <h2 className="card-title">想做什么？</h2>
      <p className="card-sub">选一个项目，下一步选时间。</p>

      {groups.map((g) => (
        <div key={g.id} style={{ marginBottom: 18 }}>
          <div className="label">{g.name}</div>
          {g.items.map((s) => (
            <ServiceRow key={s.id} s={s} currency={shop.currency} onPick={choose} />
          ))}
        </div>
      ))}

      {loose.length > 0 && (
        <div>
          {groups.length > 0 && <div className="label">其他</div>}
          {loose.map((s) => (
            <ServiceRow key={s.id} s={s} currency={shop.currency} onPick={choose} />
          ))}
        </div>
      )}

      <Note>
        价格以到店实际项目为准。有特殊要求可以在下一步的备注里写。
      </Note>
    </Card>
  );
}

function ServiceRow({ s, currency, onPick }: {
  s: Catalog['services'][number]; currency: string; onPick: (id: string) => void;
}) {
  return (
    <button className="opt" type="button" onClick={() => onPick(s.id)}>
      <span className="opt-main">
        <span className="opt-name">{s.name}</span>
        <span className="opt-meta">
          {duration(s.durationMin)}
          {s.description ? ` · ${s.description}` : ''}
        </span>
      </span>
      <span className="opt-price">{money(s.priceCents, currency)}</span>
    </button>
  );
}
