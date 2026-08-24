/**
 * 类名合并。
 *
 * `twMerge` 不只是拼字符串：它知道 `px-4` 和 `px-6` 冲突、后者赢。
 * 没有它的话，组件的默认类和调用方传进来的类会同时留在 class 里，
 * 最终谁生效取决于 CSS 里的先后顺序 —— 那是一种查起来很痛的样式 bug。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
