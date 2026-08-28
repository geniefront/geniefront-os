/**
 * 界面权限门禁。
 *
 * ⚠️ **控制按钮显隐与禁用只允许使用本模块，不得依据 `roleKeys` 判断。**
 *
 * 实际权限 = 角色预设 ∪ 个别授予 − 个别撤销（服务端 `permission_overrides`）。
 * 老板可以在不改变角色的前提下单独撤销某个前台的 `ticket.discount`。
 * 按角色画界面会得到一个「亮着但点下去 403」的按钮，用户对此的解读是系统故障。
 *
 * 数据源为 `GET /v1/me/context`。该接口不是权限边界 —— 真正的判定在命令总线中，
 * 每条命令执行前重新查库。本模块只决定「画不画」。
 */
import { useCallback } from 'react';
import { useSession } from './session';

/**
 * 权限标识。取值见 `@gf/contracts` 的 `PERMISSIONS`。
 *
 * 此处刻意使用 `string` 而非联合类型：服务端新增权限项时，
 * 前端不应因为类型不匹配而编译失败 —— 未知权限在 `can()` 中自然返回 false，
 * 是安全的降级方向。
 */
export type PermissionKey = string;

/** 单个权限判定。 */
export function useCan(permission: PermissionKey): boolean {
  const { can } = useSession();
  return can(permission);
}

/** 任一满足即可（例如「作废或退款」共用一个入口）。 */
export function useCanAny(...permissions: PermissionKey[]): boolean {
  const { can } = useSession();
  return permissions.some((p) => can(p));
}

/**
 * 写操作可用性。
 *
 * 同时考虑权限与网络状态：断网期间界面降级为只读，此时即便持有权限
 * 也不应提供写入口 —— 请求必然失败，而失败提示对门店没有任何帮助。
 *
 * 本系统**不做离线写入队列**：轮牌顺序、派单、开单是全局强一致状态，
 * 离线修改再合并必然产生冲突（两个前台各自派了同一个技师），
 * 代价远大于收益。断网期间用纸记录、恢复后补录是门店本来就熟悉的方式。
 */
export function useCanWrite(permission: PermissionKey): boolean {
  const { can, isOnline } = useSession();
  return isOnline && can(permission);
}

/**
 * 取禁用原因，用于给出可理解的提示而非静默禁用。
 * 返回 null 表示可用。
 */
export function useWriteBlockReason(): (permission: PermissionKey) => 'offline' | 'forbidden' | null {
  const { can, isOnline } = useSession();
  return useCallback(
    (permission: PermissionKey) => {
      if (!isOnline) return 'offline';
      if (!can(permission)) return 'forbidden';
      return null;
    },
    [can, isOnline],
  );
}
