/**
 * 行内操作菜单。
 *
 * ⚠️ 别再用「absolute 定位的 div」手搓下拉了 —— 表格外面套着 HeroUI 的
 * 滚动容器（`overflow: auto`），绝对定位的子元素会被直接裁掉，
 * 菜单要么半截要么压在行底下。这个组件走 HeroUI 的 Dropdown，
 * 渲染在 portal 里，不受任何祖先 overflow / stacking context 影响，
 * 顺带白拿键盘导航、点外面收起、ESC 关闭。
 */
import * as React from 'react';
import { Dropdown, Label } from '@heroui/react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from './Button';

export interface ActionMenuItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** 危险动作会渲染成红色，通常还应该配一个二次确认 */
  tone?: 'default' | 'danger';
  isDisabled?: boolean;
  onSelect: () => void;
}

export interface ActionMenuProps {
  items: ActionMenuItem[];
  /** 无障碍名字。表格里每行都有一个菜单，读屏靠这个区分 */
  label: string;
  placement?: 'bottom end' | 'bottom start' | 'top end' | 'top start';
}

export function ActionMenu({ items, label, placement = 'bottom end' }: ActionMenuProps) {
  const byId = React.useMemo(
    () => Object.fromEntries(items.map((i) => [i.id, i])),
    [items],
  );

  return (
    <Dropdown>
      <Button variant="ghost" size="icon" aria-label={label} className="h-8 w-8 p-0">
        <MoreHorizontal className="w-4 h-4 text-slate-500" />
      </Button>
      <Dropdown.Popover placement={placement} className="min-w-44">
        <Dropdown.Menu onAction={(key) => byId[String(key)]?.onSelect()}>
          {items.map((item) => (
            <Dropdown.Item
              key={item.id}
              id={item.id}
              textValue={typeof item.label === 'string' ? item.label : item.id}
              isDisabled={item.isDisabled ?? false}
              {...(item.tone === 'danger' ? { variant: 'danger' as const } : {})}
            >
              {item.icon}
              <Label>{item.label}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
