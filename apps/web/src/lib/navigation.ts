/**
 * 独立窗口模式（添加到主屏幕的 PWA）下的导航约束。
 *
 * 门店 iPad 普遍以「添加到主屏幕」的方式使用本系统，此时浏览器地址栏与
 * 前进/后退控件均不可见，整个应用只剩下一条历史记录栈。由此派生出两条
 * 必须遵守的规则：
 *
 * 1. **站内路由一律不得使用 `window.open(..., '_blank')`。** 独立窗口不支持
 *    标签页，iOS 会把目标地址交给 Safari 另起上下文；该上下文没有可回退的
 *    历史记录，用户执行返回手势时直接退出应用，已填写的看板状态全部丢失。
 *    站内地址改为压入当前历史栈（`navigate`），返回即可回到原页面。
 * 2. **任何脱离主布局的整页（打印页、存证页）都必须自带返回控件。** 这些
 *    页面刻意不套侧边栏，若不提供返回入口，独立窗口下就成了死路。
 *    `window.close()` 同样不可用 —— 非脚本打开的窗口关不掉。
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/** 是否运行在独立窗口（添加到主屏幕 / 已安装的 PWA）中。 */
export function isStandaloneApp(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

/**
 * 打开站内路由：独立窗口下压入当前历史栈，浏览器标签页环境下仍开新标签页
 * （前台电脑习惯把服务单、健康表单摊在多个标签页里对照）。
 */
export function useOpenInternalRoute() {
  const navigate = useNavigate();
  return useCallback((path: string) => {
    if (isStandaloneApp()) {
      navigate(path);
      return;
    }
    const opened = window.open(path, '_blank', 'noopener');
    if (!opened) navigate(path);
  }, [navigate]);
}

/**
 * 返回上一页；没有站内历史可退时（新标签页直接打开、独立窗口冷启动进入该
 * 页面）退回给定的兜底路由，而不是把用户留在死路上或直接退出应用。
 */
export function useGoBack(fallbackPath: string) {
  const navigate = useNavigate();
  return useCallback(() => {
    const index = (window.history.state as { idx?: number } | null)?.idx;
    if (typeof index === 'number' && index > 0) {
      navigate(-1);
      return;
    }
    navigate(fallbackPath, { replace: true });
  }, [navigate, fallbackPath]);
}
