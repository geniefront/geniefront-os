/**
 * 技师端 i18n。
 *
 * ⭐ 语言是**按人**存的（`00` §2）：同一家店里前台说中文、技师说越南语
 * 是常态，而共享 iPad 上换个人就该换语言 —— 存 localStorage 不够，
 * 所以登录后从 users.locale 读，改的时候发 staff.setLocale 命令写回去。
 */
export const LOCALES = ['zh-Hans', 'vi', 'ko', 'es', 'en', 'zh-Hant'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABEL: Record<Locale, string> = {
  'zh-Hans': '简体中文', vi: 'Tiếng Việt', ko: '한국어',
  es: 'Español', en: 'English', 'zh-Hant': '繁體中文',
};

type Dict = Record<string, string>;

const zhHans: Dict = {
  'app.title': '我的单',
  'auth.title': '技师登录',
  'auth.email': '邮箱', 'auth.password': '密码', 'auth.signIn': '登录',
  'auth.failed': '邮箱或密码不对', 'auth.signOut': '退出',
  'loc.pick': '选择门店',
  'nav.today': '今日单', 'nav.money': '我的收入', 'nav.clock': '打卡',
  'next.title': '下一位客人', 'next.none': '现在没有等着的客人',
  'next.start': '开始', 'next.finish': '完成', 'next.doing': '正在做',
  'next.request': '点钟指定我', 'next.seat': '座位',
  'today.done': '已完成', 'today.count': '今天做了',
  'money.today': '今日收入', 'money.commission': '提成', 'money.tipCash': '现金小费',
  'money.tipCard': '刷卡小费', 'money.total': '合计', 'money.cashTonight': '今晚拿现金',
  'money.revenue': '我的营业额',
  'clock.in': '上班', 'clock.out': '下班',
  'clock.breakStart': '休息', 'clock.breakEnd': '回来',
  'clock.onDuty': '在岗', 'clock.off': '未打卡', 'clock.worked': '今天已工作',
  'clock.pin': '输入 PIN',
  'rt.live': '实时在线', 'rt.down': '连不上 · 写操作暂停', 'rt.connecting': '连接中…',
  'rt.enable': '点一下打开提示音',
  'common.loading': '加载中…', 'common.error': '出错了', 'common.retry': '重试',
  'common.close': '关闭', 'common.ok': '知道了',
  'alert.title': '⚠️ 注意',
};

/** 其余语言按 key 回退到中文（宪法第 7 条：没有硬编码文案，缺的先回退不留空白） */
const en: Dict = {
  'app.title': 'My Tasks',
  'auth.title': 'Staff sign in', 'auth.email': 'Email', 'auth.password': 'Password',
  'auth.signIn': 'Sign in', 'auth.failed': 'Wrong email or password', 'auth.signOut': 'Sign out',
  'loc.pick': 'Choose location',
  'nav.today': 'Today', 'nav.money': 'My pay', 'nav.clock': 'Clock',
  'next.title': 'Next guest', 'next.none': 'No guest waiting',
  'next.start': 'Start', 'next.finish': 'Done', 'next.doing': 'In service',
  'next.request': 'Requested me', 'next.seat': 'Seat',
  'today.done': 'Done', 'today.count': 'Finished today',
  'money.today': "Today's pay", 'money.commission': 'Commission', 'money.tipCash': 'Cash tips',
  'money.tipCard': 'Card tips', 'money.total': 'Total', 'money.cashTonight': 'Cash tonight',
  'money.revenue': 'My sales',
  'clock.in': 'Clock in', 'clock.out': 'Clock out',
  'clock.breakStart': 'Break', 'clock.breakEnd': 'Back',
  'clock.onDuty': 'On duty', 'clock.off': 'Not clocked in', 'clock.worked': 'Worked today',
  'clock.pin': 'Enter PIN',
  'rt.live': 'Live', 'rt.down': 'Offline · actions paused', 'rt.connecting': 'Connecting…',
  'rt.enable': 'Tap to enable sound',
  'common.loading': 'Loading…', 'common.error': 'Something went wrong', 'common.retry': 'Retry',
  'common.close': 'Close', 'common.ok': 'OK',
  'alert.title': '⚠️ Attention',
};

const vi: Dict = {
  'app.title': 'Khách của tôi',
  'nav.today': 'Hôm nay', 'nav.money': 'Tiền của tôi', 'nav.clock': 'Chấm công',
  'next.title': 'Khách tiếp theo', 'next.none': 'Chưa có khách',
  'next.start': 'Bắt đầu', 'next.finish': 'Xong', 'next.doing': 'Đang làm',
  'clock.in': 'Vào ca', 'clock.out': 'Tan ca', 'clock.onDuty': 'Đang làm',
  'money.today': 'Thu nhập hôm nay', 'money.tipCash': 'Tiền tip mặt',
};

const ko: Dict = {
  'app.title': '내 손님',
  'nav.today': '오늘', 'nav.money': '내 수입', 'nav.clock': '출퇴근',
  'next.title': '다음 손님', 'next.none': '대기 손님 없음',
  'next.start': '시작', 'next.finish': '완료', 'next.doing': '진행 중',
  'clock.in': '출근', 'clock.out': '퇴근', 'clock.onDuty': '근무 중',
  'money.today': '오늘 수입', 'money.tipCash': '현금 팁',
};

const es: Dict = {
  'app.title': 'Mis clientes',
  'nav.today': 'Hoy', 'nav.money': 'Mi pago', 'nav.clock': 'Fichar',
  'next.title': 'Siguiente cliente', 'next.none': 'No hay clientes esperando',
  'next.start': 'Empezar', 'next.finish': 'Terminado', 'next.doing': 'En servicio',
  'clock.in': 'Entrada', 'clock.out': 'Salida', 'clock.onDuty': 'En turno',
  'money.today': 'Pago de hoy', 'money.tipCash': 'Propinas en efectivo',
};

const DICTS: Record<Locale, Dict> = {
  'zh-Hans': zhHans, 'zh-Hant': zhHans, en, vi, ko, es,
};

export type T = (key: string) => string;

/** 回退链：本语言 → 英文 → 中文 → key 本身。绝不返回空白 */
export function makeT(locale: Locale): T {
  const d = DICTS[locale] ?? zhHans;
  return (key) => d[key] ?? en[key] ?? zhHans[key] ?? key;
}
