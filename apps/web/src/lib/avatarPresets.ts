// ── 个人用户形象预设 ──────────────────────────────────────────────────────
export interface UserAvatarPreset {
  id: string;
  label: string;
  type: 'emoji' | 'icon' | 'gradient';
  icon?: string;
  bg: string;
  text: string;
}

export const PRESET_USER_AVATARS: UserAvatarPreset[] = [
  { id: 'usr-1', label: '美甲艺术家', type: 'emoji', icon: '💅🏻', bg: 'from-pink-500 to-rose-600', text: 'text-white' },
  { id: 'usr-2', label: 'SPA 芳疗师', type: 'emoji', icon: '💆🏻‍♀️', bg: 'from-teal-500 to-emerald-600', text: 'text-white' },
  { id: 'usr-3', label: '创意造型师', type: 'emoji', icon: '💇🏻‍♀️', bg: 'from-purple-500 to-indigo-600', text: 'text-white' },
  { id: 'usr-4', label: '尊贵掌柜', type: 'emoji', icon: '👑', bg: 'from-amber-500 to-orange-600', text: 'text-white' },
  { id: 'usr-5', label: '禅意雪莲', type: 'emoji', icon: '🌸', bg: 'from-emerald-500 to-teal-700', text: 'text-white' },
  { id: 'usr-6', label: '璀璨水晶', type: 'emoji', icon: '💎', bg: 'from-cyan-500 to-blue-600', text: 'text-white' },
  { id: 'usr-7', label: '幻彩彩蝶', type: 'emoji', icon: '🦋', bg: 'from-violet-500 to-fuchsia-600', text: 'text-white' },
  { id: 'usr-8', label: '植萃纯然', type: 'emoji', icon: '🌿', bg: 'from-lime-600 to-emerald-700', text: 'text-white' },
  { id: 'usr-9', label: '招财萌猫', type: 'emoji', icon: '🐱', bg: 'from-amber-400 to-orange-500', text: 'text-white' },
  { id: 'usr-10', label: '灵动小狐', type: 'emoji', icon: '🦊', bg: 'from-orange-500 to-red-600', text: 'text-white' },
  { id: 'usr-11', label: '幽雅茶香', type: 'emoji', icon: '🍵', bg: 'from-teal-600 to-emerald-800', text: 'text-white' },
  { id: 'usr-12', label: '闪耀之星', type: 'emoji', icon: '🌟', bg: 'from-yellow-400 to-amber-600', text: 'text-white' },
  { id: 'usr-13', label: '琉璃魔镜', type: 'emoji', icon: '🪞', bg: 'from-blue-500 to-indigo-700', text: 'text-white' },
  { id: 'usr-14', label: '金牌前台', type: 'emoji', icon: '👩🏻‍💼', bg: 'from-slate-700 to-slate-900', text: 'text-white' },
  { id: 'usr-15', label: '色彩大师', type: 'emoji', icon: '🎨', bg: 'from-fuchsia-600 to-pink-600', text: 'text-white' },
  { id: 'usr-16', label: '舒压瑜伽', type: 'emoji', icon: '🧘🏻‍♀️', bg: 'from-indigo-500 to-purple-700', text: 'text-white' },
];

export const PRESET_AVATAR_GRADIENTS = [
  { id: 'grad-1', label: '薄荷翡翠', bg: 'from-teal-500 to-emerald-600', text: 'text-white' },
  { id: 'grad-2', label: '星海深蓝', bg: 'from-blue-600 to-indigo-700', text: 'text-white' },
  { id: 'grad-3', label: '幻彩紫晶', bg: 'from-purple-600 to-pink-600', text: 'text-white' },
  { id: 'grad-4', label: '日出暖橙', bg: 'from-amber-500 to-orange-600', text: 'text-white' },
  { id: 'grad-5', label: '黑金曜石', bg: 'from-slate-700 to-slate-950', text: 'text-white' },
  { id: 'grad-6', label: '玫瑰朱砂', bg: 'from-rose-500 to-red-600', text: 'text-white' },
  { id: 'grad-7', label: '极光青柠', bg: 'from-lime-500 to-teal-600', text: 'text-white' },
  { id: 'grad-8', label: '香槟浅金', bg: 'from-amber-400 to-yellow-600', text: 'text-white' },
  { id: 'grad-9', label: '霓虹粉紫', bg: 'from-fuchsia-500 to-indigo-600', text: 'text-white' },
  { id: 'grad-10', label: '森林幽绿', bg: 'from-emerald-600 to-teal-800', text: 'text-white' },
  { id: 'grad-11', label: '暮光薰衣草', bg: 'from-indigo-400 to-purple-600', text: 'text-white' },
  { id: 'grad-12', label: '珊瑚赤红', bg: 'from-orange-500 to-rose-600', text: 'text-white' },
];

// ── 门店品牌形象预设 ──────────────────────────────────────────────────────
export interface StoreAvatarPreset {
  id: string;
  name: string;
  icon: string;
  bg: string;
  desc: string;
}

export const PRESET_STORE_AVATARS: StoreAvatarPreset[] = [
  { id: 'store-1', name: '盛放雪莲', icon: '🪷', bg: 'bg-teal-600', desc: '优雅从容 · SPA 与芳疗会所首选' },
  { id: 'store-2', name: '奢华琉璃甲', icon: '💅', bg: 'bg-pink-600', desc: '时尚璀璨 · 美甲美睫沙龙' },
  { id: 'store-3', name: '禅意理疗', icon: '💆', bg: 'bg-emerald-600', desc: '深度放松 · 经络养生与足道' },
  { id: 'store-4', name: '经典名剪', icon: '✂️', bg: 'bg-indigo-600', desc: '匠心剪裁 · 美发色彩设计沙龙' },
  { id: 'store-5', name: '皇家尊享', icon: '👑', bg: 'bg-amber-600', desc: '奢华尊贵 · 高端私享 VIP 会所' },
  { id: 'store-6', name: '植萃纯然', icon: '🌿', bg: 'bg-teal-700', desc: '纯净自然 · 有机护肤与芳香疗法' },
  { id: 'store-7', name: '璀璨钻石', icon: '💎', bg: 'bg-blue-600', desc: '晶莹剔透 · 高端轻医美与光疗' },
  { id: 'store-8', name: '禅意香薰', icon: '🕯️', bg: 'bg-orange-600', desc: '宁静雅致 · 香薰冥想与舒压中心' },
  { id: 'store-9', name: '浪漫樱花', icon: '🌸', bg: 'bg-rose-500', desc: '温润唯美 · 日式美甲与皮肤管理' },
  { id: 'store-10', name: '典雅公馆', icon: '🏛️', bg: 'bg-slate-800', desc: '沉稳庄重 · 连锁旗舰公馆' },
  { id: 'store-11', name: '琉璃美学', icon: '🪞', bg: 'bg-purple-600', desc: '灵动幻变 · 美学定制工作室' },
  { id: 'store-12', name: '金色朝阳', icon: '☀️', bg: 'bg-yellow-600', desc: '活力焕采 · 头疗理疗与抗衰' },
];

export const PRESET_STORE_THEMES = [
  { id: 'theme-teal', name: '翡翠碧绿', bg: 'bg-teal-600', text: 'text-teal-600' },
  { id: 'theme-slate', name: '曜石黑金', bg: 'bg-slate-900', text: 'text-slate-900' },
  { id: 'theme-purple', name: '极光紫晶', bg: 'bg-purple-600', text: 'text-purple-600' },
  { id: 'theme-rose', name: '浪漫玫瑰', bg: 'bg-rose-600', text: 'text-rose-600' },
  { id: 'theme-indigo', name: '皇家深蓝', bg: 'bg-indigo-600', text: 'text-indigo-600' },
  { id: 'theme-amber', name: '暖阳琥珀', bg: 'bg-amber-600', text: 'text-amber-600' },
  { id: 'theme-emerald', name: '森林幽绿', bg: 'bg-emerald-600', text: 'text-emerald-600' },
  { id: 'theme-pink', name: '芭比粉樱', bg: 'bg-pink-600', text: 'text-pink-600' },
];

// 本地持久化与事件通知
export const USER_AVATAR_STORAGE_KEY = 'gf_user_avatar_prefs';
export const STORE_AVATAR_STORAGE_KEY = 'gf_store_avatar_prefs';

export function getSavedUserAvatar(userId?: string) {
  try {
    const raw = userId ? localStorage.getItem(`${USER_AVATAR_STORAGE_KEY}:${userId}`) : null;
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    mode: 'emoji', // 'emoji' | 'gradient' | 'custom'
    presetId: 'usr-2',
    icon: '💆🏻‍♀️',
    gradientId: 'grad-1',
    customImageUrl: '',
  };
}

export function saveUserAvatar(avatar: any, userId?: string) {
  try {
    if (!userId) return;
    localStorage.setItem(`${USER_AVATAR_STORAGE_KEY}:${userId}`, JSON.stringify(avatar));
    window.dispatchEvent(new CustomEvent('gf-avatar-updated', { detail: avatar }));
  } catch {}
}

export function getSavedStoreAvatar() {
  try {
    const raw = localStorage.getItem(STORE_AVATAR_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    presetId: 'store-1',
    icon: '🪷',
    themeId: 'theme-teal',
    bg: 'bg-teal-600',
    customLogoUrl: '',
  };
}

export function saveStoreAvatar(storeAvatar: any) {
  try {
    localStorage.setItem(STORE_AVATAR_STORAGE_KEY, JSON.stringify(storeAvatar));
    window.dispatchEvent(new CustomEvent('gf-store-avatar-updated', { detail: storeAvatar }));
  } catch {}
}
