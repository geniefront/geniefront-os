/**
 * HeroUI Tabs 的适配层。模板用的是 Radix 的那套命名和 props
 * （value / defaultValue / onValueChange），HeroUI 走 react-aria
 * （selectedKey / defaultSelectedKey / onSelectionChange），在这里翻译一次。
 *
 * ⚠️ 页面里写的 `data-[state=active]:*` 不再生效 —— HeroUI 用的是
 * `data-[selected=true]`，选中态由它自己的 Indicator 画。留着那些类不影响渲染，
 * 逐页收拾时再删。
 */
import * as React from 'react';
import { Tabs as HeroTabs } from '@heroui/react';
import { cn } from '@/lib/utils';

export interface TabsProps
  extends Omit<React.ComponentProps<typeof HeroTabs>, 'selectedKey' | 'defaultSelectedKey' | 'onSelectionChange'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export function Tabs({ value, defaultValue, onValueChange, className, ...props }: TabsProps) {
  return (
    <HeroTabs
      className={cn(className)}
      {...(value !== undefined ? { selectedKey: value } : {})}
      {...(defaultValue !== undefined ? { defaultSelectedKey: defaultValue } : {})}
      {...(onValueChange ? { onSelectionChange: (k: React.Key) => onValueChange(String(k)) } : {})}
      {...props}
    />
  );
}

export function TabsList({ className, ...props }: React.ComponentProps<typeof HeroTabs.List>) {
  return (
    <HeroTabs.ListContainer>
      <HeroTabs.List className={cn(className)} {...props} />
    </HeroTabs.ListContainer>
  );
}

export interface TabsTriggerProps
  extends Omit<React.ComponentProps<typeof HeroTabs.Tab>, 'id'> {
  value: string;
}

export function TabsTrigger({ value, className, children, ...props }: TabsTriggerProps) {
  return (
    <HeroTabs.Tab id={value} className={cn(className)} {...props}>
      <>
        {children as React.ReactNode}
        <HeroTabs.Indicator />
      </>
    </HeroTabs.Tab>
  );
}

export interface TabsContentProps
  extends Omit<React.ComponentProps<typeof HeroTabs.Panel>, 'id'> {
  value: string;
}

export function TabsContent({ value, className, ...props }: TabsContentProps) {
  return <HeroTabs.Panel id={value} className={cn(className)} {...props} />;
}
