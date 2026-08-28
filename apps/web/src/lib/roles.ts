import type { TranslationKey } from '@/i18n';

/**
 * 服务端角色标识到界面文案的映射。取值已与后端核对（`roles` 表）。
 *
 * ⚠️ **角色仅用于身份展示，不得用于控制任何按钮的显隐或禁用。**
 *
 * 实际权限 = 角色预设 ∪ 个别授予 − 个别撤销（`permission_overrides`）。
 * 老板可以在不改变角色的前提下单独撤销某个前台的 `ticket.discount`。
 * 若界面按角色画按钮，该前台会看到一个点下去必然 403 的按钮 ——
 * 用户对此的解读是「系统坏了」，而不是「我没有这个权限」。
 *
 * 控制显隐一律使用 `useCan(...)`，其数据源是 `GET /v1/me/context`
 * 返回的 `permissions` 数组。
 *
 * ⚠️ 一人可兼多角（例如 `['manager', 'tech']`），渲染时必须遍历整个数组，
 * 不得只取首项。
 */
const ROLE_LABEL_KEYS: Record<string, TranslationKey> = {
  owner: 'roleOwner',
  manager: 'roleManagerKey',
  front_desk: 'roleFrontDeskKey',
  senior_tech: 'roleSeniorTechKey',
  tech: 'roleTechKey',
};

/**
 * 取角色的展示文案 key。未收录的标识返回 null，调用方应原样显示该标识 ——
 * 新增角色时界面仍然可读，并能据此发现前端文案有待补充。
 */
export function roleLabelKey(roleKey: string): TranslationKey | null {
  return ROLE_LABEL_KEYS[roleKey] ?? null;
}
