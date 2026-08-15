/**
 * i18n 骨架（宪法第 7 条：没有硬编码文案）。
 *
 * 界面语言按【人】设置，不是按店 —— 同一家店里前台说中文、技师说越南语
 * 是常态（00 §6）。
 */
export const LOCALES = ['zh-Hans', 'en', 'vi', 'ko', 'zh-Hant', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABEL: Record<Locale, string> = {
  'zh-Hans': '简体中文',
  en: 'English',
  vi: 'Tiếng Việt',
  ko: '한국어',
  'zh-Hant': '繁體中文',
  es: 'Español',
};

type Dict = Record<string, string>;

const zhHans: Dict = {
  'app.name': 'GenieFront 前台',
  'auth.title': '登录',
  'auth.email': '邮箱',
  'auth.password': '密码',
  'auth.signIn': '登录',
  'auth.signingIn': '登录中…',
  'auth.failed': '邮箱或密码不对',
  'auth.signOut': '退出',

  'loc.title': '选择门店',
  'loc.subtitle': '你在多家店有身份，选一家进入',
  'loc.enter': '进入',
  'loc.none': '你还没有任何门店的身份，请联系店主',
  'loc.switch': '切换门店',

  'role.owner': '老板',
  'role.manager': '店长',
  'role.front_desk': '前台',
  'role.senior_tech': '资深技师',
  'role.tech': '技师',

  'cust.title': '找客人',
  'cust.searchHint': '输入手机号或姓名',
  'cust.search': '搜索',
  'cust.searching': '搜索中…',
  'cust.multiWarn': '这个号码下有 {n} 位客人',
  'cust.multiHelp': '别默认选第一个 —— 选错会把偏好、过敏、上次样式挂到别人头上',
  'cust.new': '新建客人',
  'cust.lastVisit': '上次到店',
  'cust.never': '还没来过',
  'cust.noResult': '没找到，可以直接新建',
  'cust.anonymous': '不留电话（Walk-in）',
  'cust.noShow': '爽约 {n} 次',
  'cust.select': '选这位',

  'common.back': '返回',
  'common.cancel': '取消',
  'common.loading': '加载中…',
  'common.error': '出错了',
  'common.retry': '重试',
};

const en: Dict = {
  'app.name': 'GenieFront Desk',
  'auth.title': 'Sign in',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.signIn': 'Sign in',
  'auth.signingIn': 'Signing in…',
  'auth.failed': 'Wrong email or password',
  'auth.signOut': 'Sign out',
  'loc.title': 'Choose a location',
  'loc.subtitle': 'You work at more than one shop',
  'loc.enter': 'Enter',
  'loc.none': 'No active membership. Ask the owner to add you.',
  'loc.switch': 'Switch shop',
  'role.owner': 'Owner', 'role.manager': 'Manager', 'role.front_desk': 'Front desk',
  'role.senior_tech': 'Senior tech', 'role.tech': 'Tech',
  'cust.title': 'Find guest',
  'cust.searchHint': 'Phone number or name',
  'cust.search': 'Search',
  'cust.searching': 'Searching…',
  'cust.multiWarn': '{n} guests share this number',
  'cust.multiHelp': "Don't just pick the first — preferences and allergies would go to the wrong person",
  'cust.new': 'New guest',
  'cust.lastVisit': 'Last visit',
  'cust.never': 'First time',
  'cust.noResult': 'Not found — create a new guest',
  'cust.anonymous': 'No phone (walk-in)',
  'cust.noShow': '{n} no-shows',
  'cust.select': 'Select',
  'common.back': 'Back', 'common.cancel': 'Cancel', 'common.loading': 'Loading…',
  'common.error': 'Something went wrong', 'common.retry': 'Retry',
};

const DICTS: Partial<Record<Locale, Dict>> = { 'zh-Hans': zhHans, en };

export function makeT(locale: Locale) {
  const d = DICTS[locale] ?? zhHans;
  return (key: string, vars?: Record<string, string | number>): string => {
    // 缺翻译时回退到简体中文，再回退到 key 本身 —— 绝不显示空白
    let s = d[key] ?? zhHans[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}
