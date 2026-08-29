/**
 * 组件测试的公共装配。
 *
 * `@testing-library/jest-dom` 提供 `toBeDisabled`、`toBeInTheDocument` 等
 * 面向 DOM 的断言 —— 用它们表达「按钮是禁用的」，比断言 class 名更贴近
 * 用户实际看到的结果，也不会因为样式重构而误报。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { translations } from './src/i18n';

Object.assign(globalThis, { __GF_TEST_TRANSLATIONS__: translations });

// 每个用例后卸载，避免上一个用例残留的 DOM 影响下一个用例的查询
afterEach(() => cleanup());
