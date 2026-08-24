# -*- coding: utf-8 -*-
"""把同一份真实内容按四种样式各渲染一遍：现状 + 三个方向。
内容一个字都不变 —— 只有样式包不同，这样对比才是对比样式。"""
import io, os

HEAD = '''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    body {{ margin: 0; background: {bg}; color: {ink};
      font: 400 17px/1.45 -apple-system, "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased; }}
    a {{ color: {brand}; }} a:hover {{ color: {brand}; }}
    .lbl {{ font-size: 13px; font-weight: 700; letter-spacing: .08em; color: {ink3}; }}
  </style>
</helmet>
'''

TAIL = '''</x-dc>
<script data-dc-script data-props='{}'>
class Component extends DCLogic {
  renderVals() { return {}; }
}
</script>
</body>
</html>
'''

# ── 四个样式包 ────────────────────────────────────────────────────────────────
NOW = dict(
    key='now', bg='#f6f5f3', surface='#ffffff', line='#ddd9d3', ink='#1a1917',
    ink2='#57534e', ink3='#8b857d', brand='#b8143c', brandink='#ffffff',
    ok='#146b3a', oksoft='#e6f4ea', warn='#9a5b00', warnsoft='#fdf1dc',
    brandsoft='#fdeaef', mute='#efedea',
    radius=14, cardpad='14px 16px', cardgap=12, cardborder='1px',
    shadow='0 1px 2px rgba(0,0,0,.06), 0 4px 14px rgba(0,0,0,.05)',
    namesize=28, nameweight=700, lh=1.45, badgestyle='soft', icons='emoji',
    numradius=14, btnradius=14,
)
QUIET = dict(NOW, key='quiet',
    radius=20, cardpad='18px 20px', cardgap=14, cardborder='0px',
    shadow='0 1px 2px rgba(0,0,0,.04), 0 10px 28px rgba(0,0,0,.06)',
    line='#ffffff', badgestyle='dot', numradius=16, btnradius=16,
)
SOLID = dict(NOW, key='solid',
    radius=10, cardpad='12px 14px', cardgap=10, cardborder='2px',
    shadow='none', line='#1a1917', lh=1.25,
    namesize=28, nameweight=800, badgestyle='fill', numradius=8, btnradius=10,
)
REFINED = dict(NOW, key='refined',
    radius=12, cardpad='16px 18px', cardgap=12, cardborder='1px',
    shadow='none', line='#e6e2dc', brand='#9e1236', ok='#0f5132',
    oksoft='#e8f1ec', warn='#7c4a02', warnsoft='#f7efe1', mute='#f3f1ee',
    namesize=26, nameweight=600, badgestyle='outline', icons='svg',
    numradius=10, btnradius=12,
)
PACKS = [('Main', NOW, '现状'), ('TurnQuiet', QUIET, '安静'),
         ('TurnSolid', SOLID, '硬朗'), ('TurnRefined', REFINED, '精致')]

# ── 图标：现状/安静/硬朗用 emoji（那是这个产品定下来的功能位词汇）；精致换成线性图标 ──
SVG = {
 'star': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
 'cup': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9h2a2.5 2.5 0 0 1 0 5h-2"/><path d="M8 3v2M12 3v2"/></svg>',
 'hand': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M15 10.5V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2.5a1.5 1.5 0 0 1 3 0V13"/></svg>',
 'play': '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
 'dot': '',
}
EMOJI = {'star': '★', 'cup': '☕', 'hand': '✋', 'play': '▶'}

def icon(p, name):
    if p['icons'] == 'svg':
        return f'<span style="display:inline-flex;align-items:center">{SVG[name]}</span>'
    return f'<span>{EMOJI[name]}</span>'

def badge(p, tone, icon_name, text):
    """状态一律三通道：颜色 + 图标 + 文字。四个方向只是三通道的呈现方式不同。"""
    fg = {'ok': p['ok'], 'warn': p['warn'], 'brand': p['brand'], 'mute': p['ink2']}[tone]
    bgc = {'ok': p['oksoft'], 'warn': p['warnsoft'], 'brand': p['brandsoft'], 'mute': p['mute']}[tone]
    ic = icon(p, icon_name) if icon_name else ''
    st = p['badgestyle']
    if st == 'dot':      # 安静：去掉底色，留一个色点 + 墨色文字
        return (f'<span style="display:inline-flex;align-items:center;gap:7px;font-size:15px;font-weight:600;color:{p["ink2"]};white-space:nowrap">'
                f'<span style="width:9px;height:9px;border-radius:50%;background:{fg};flex-shrink:0"></span>{ic}{text}</span>')
    if st == 'fill':     # 硬朗：实心块
        tc = '#ffffff' if tone in ('ok', 'brand') else '#1a1917'
        return (f'<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:6px;'
                f'background:{fg if tone!="mute" else "#1a1917"};color:{tc if tone!="mute" else "#fff"};'
                f'font-size:15px;font-weight:800;white-space:nowrap">{ic}{text}</span>')
    if st == 'outline':  # 精致：细描边
        return (f'<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;'
                f'border:1px solid {fg};color:{fg};font-size:15px;font-weight:600;white-space:nowrap">{ic}{text}</span>')
    return (f'<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;'
            f'background:{bgc};color:{fg};font-size:15px;font-weight:700;white-space:nowrap">{ic}{text}</span>')

def card_style(p, next_up=False):
    bw = p['cardborder']
    if next_up:
        bc, bgc = p['ok'], p['oksoft']
        bw = '3px' if p['key'] != 'quiet' else '0px'
    else:
        bc, bgc = p['line'], p['surface']
    border = f'border:{bw} solid {bc};' if bw != '0px' else 'border:none;'
    return f'background:{bgc};{border}border-radius:{p["radius"]}px;box-shadow:{p["shadow"]};overflow:hidden'

def tech_row(p, n, name, next_up=False, online=True, badges=(), sub=''):
    num_bg = p['ok'] if next_up else ('#1a1917' if p['key'] == 'solid' else p['mute'])
    num_fg = '#fff' if (next_up or p['key'] == 'solid') else p['ink2']
    b = ''.join(badges)
    dot = (f'<span style="width:12px;height:12px;border-radius:50%;flex-shrink:0;'
           f'background:{p["ok"] if online else "#c9c4bd"}"></span>')
    btns = ''
    if next_up:
        btns = f'''
      <div style="display:flex;gap:10px;padding:0 {p['cardpad'].split(' ')[1]} {p['cardpad'].split(' ')[0]}">
        <button style="flex:1;min-height:64px;border-radius:{p['btnradius']}px;border:{'2px solid '+p['brand'] if p['key']=='solid' else '1px solid '+p['brand']};
          {'border-bottom-width:4px;' if p['key']=='solid' else ''}background:{p['brand']};color:#fff;
          font-size:21px;font-weight:{800 if p['key']=='solid' else 600};cursor:pointer;
          {'box-shadow:'+p['shadow']+';' if p['key'] in ('now','quiet') else ''}">派给他 · 开单</button>
        <button style="min-height:64px;padding:0 20px;border-radius:{p['btnradius']}px;
          border:{p['cardborder'] if p['cardborder']!='0px' else '1px'} solid {p['line'] if p['key']!='quiet' else '#e6e2dc'};
          background:{p['surface']};color:{p['ink']};font-size:17px;font-weight:600;cursor:pointer;
          display:inline-flex;align-items:center;gap:8px">{icon(p,'star')}点钟</button>
      </div>'''
    return f'''
    <div style="{card_style(p, next_up)}">
      <div style="display:flex;align-items:center;gap:14px;padding:{p['cardpad']}">
        <div style="width:52px;height:52px;border-radius:{p['numradius']}px;flex-shrink:0;display:grid;place-items:center;
          background:{num_bg};color:{num_fg};font-size:28px;font-weight:800;font-variant-numeric:tabular-nums">{n}</div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:5px">
          <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
            <strong style="font-size:{p['namesize']}px;font-weight:{p['nameweight']};line-height:{p['lh']}">{name}</strong>
            {dot}{b}
          </div>
          <div style="font-size:15px;color:{p['ink3']};line-height:{p['lh']}">{sub}</div>
        </div>
        <button style="min-height:44px;padding:0 16px;border-radius:{p['btnradius']}px;
          border:{p['cardborder'] if p['cardborder']!='0px' else '1px'} solid {p['line'] if p['key']!='quiet' else '#e6e2dc'};
          background:{p['surface']};color:{p['ink2']};font-size:15px;font-weight:600;cursor:pointer">为什么</button>
      </div>{btns}
    </div>'''

def turn_board(p, label):
    rows = [
      tech_row(p, 1, 'Yan', next_up=True, online=True,
               badges=[badge(p, 'ok', 'star', '下一位')], sub='今天 0 轮 · 上一轮 11:20 做完'),
      tech_row(p, 2, 'Amy', online=True,
               badges=[badge(p, 'warn', 'cup', '休息中')], sub='今天 2 轮 · 14:05 去休息'),
      tech_row(p, 3, 'Kim', online=False,
               badges=[badge(p, 'brand', 'hand', '前台调序'), badge(p, 'warn', None, '欠 1 轮')],
               sub='今天 1 轮 · 客人指定别人'),
      tech_row(p, 4, 'Linh', online=True, sub='今天 2 轮 · 上一轮 13:40 做完'),
    ]
    return HEAD.format(**{k: p[k] for k in ('bg', 'ink', 'brand')}, ink3=p['ink3']) + f'''
<div style="padding:22px 24px;display:flex;flex-direction:column;gap:{p['cardgap']}px">
  <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:2px">
    <span class="lbl">{label}</span>
    <span style="font-size:15px;color:{p['ink3']}">前台 · 轮牌板</span>
  </div>
  {''.join(rows)}
</div>
''' + TAIL

def staff_card(p, label):
    doing_badge = badge(p, 'brand', None, '下一位客人')
    return HEAD.format(**{k: p[k] for k in ('bg', 'ink', 'brand')}, ink3=p['ink3']) + f'''
<div style="padding:16px;display:flex;flex-direction:column;gap:12px">
  <div style="display:flex;align-items:baseline;gap:10px">
    <span class="lbl">{label}</span>
    <span style="font-size:15px;color:{p['ink3']}">技师端</span>
  </div>

  <div style="{card_style(p)};padding:20px;display:flex;flex-direction:column;gap:16px">
    <div style="display:flex;flex-direction:column;gap:6px;padding:14px;border-radius:{max(8,p['radius']-2)}px;
      background:#a4161a;color:#fff">
      <strong style="font-size:21px">安全提示</strong>
      <div style="font-size:21px;font-weight:700">左手无名指有伤口，避开</div>
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap">
      {doing_badge}{badge(p, 'warn', 'star', '点钟')}{badge(p, 'mute', None, '座位 3 号')}
    </div>

    <div style="font-size:38px;font-weight:800;line-height:1.15">临时客人</div>

    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
      <span style="font-size:28px;font-weight:700">甲油胶美甲</span>
      {badge(p, 'mute', None, '45 min')}
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;padding:14px;border-radius:{max(8,p['radius']-2)}px;
      background:{'#faf9f7' if p['key']=='refined' else p['bg']};
      {'border:1px solid '+p['line']+';' if p['key']=='solid' else ''}">
      <div style="display:flex;gap:10px"><span style="min-width:96px;color:{p['ink2']}">力度</span><strong style="font-size:21px">重</strong></div>
      <div style="display:flex;gap:10px"><span style="min-width:96px;color:{p['ink2']}">甲型</span><strong style="font-size:21px">方圆形</strong></div>
    </div>

    <button style="width:100%;min-height:88px;border-radius:{p['btnradius']}px;
      border:{'2px solid '+p['brand'] if p['key']=='solid' else '1px solid '+p['brand']};
      {'border-bottom-width:5px;' if p['key']=='solid' else ''}background:{p['brand']};color:#fff;
      font-size:28px;font-weight:{800 if p['key']=='solid' else 600};cursor:pointer;
      display:inline-flex;align-items:center;justify-content:center;gap:10px;
      {'box-shadow:'+p['shadow']+';' if p['key'] in ('now','quiet') else ''}">{icon(p,'play')} 开始</button>
  </div>
</div>
''' + TAIL

for fname, pack, label in PACKS:
    io.open(f'{fname}.dc.html', 'w', encoding='utf-8').write(turn_board(pack, label))
    sname = {'Main': 'StaffNow', 'TurnQuiet': 'StaffQuiet',
             'TurnSolid': 'StaffSolid', 'TurnRefined': 'StaffRefined'}[fname]
    io.open(f'{sname}.dc.html', 'w', encoding='utf-8').write(staff_card(pack, label))
print('写了：', sorted(f for f in os.listdir('.') if f.endswith('.dc.html')))
