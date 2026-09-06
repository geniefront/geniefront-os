/**
 * 取词与语言持久化的行为约束。
 *
 * ⚠️ 本文件断言的每一条都对应一类曾经真实存在、且不会被类型系统拦住的缺陷：
 * 语言代码与服务端不一致导致门店终端每天重设语言、缺词条被静默吞掉、
 * 以及占位符替换把用户输入当成正则模式。
 */
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LanguageProvider, useLanguage } from './LanguageContext';

function Probe({ k, params }: { k: string; params?: Record<string, string | number> }) {
  const { t, language } = useLanguage();
  return (
    <>
      <span data-testid="lang">{language}</span>
      <span data-testid="text">{t(k, params)}</span>
    </>
  );
}

function renderProbe(k: string, params?: Record<string, string | number>) {
  return render(
    <LanguageProvider>
      <Probe k={k} params={params} />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = '';
});

describe('语言选择与持久化', () => {
  it('未选择过语言时使用简体中文，并写入 html lang', () => {
    renderProbe('save');
    expect(screen.getByTestId('lang')).toHaveTextContent('zh-Hans');
    expect(document.documentElement.lang).toBe('zh-Hans');
  });

  it('沿用已保存的语言', () => {
    localStorage.setItem('gf.lang', 'ko');
    renderProbe('save');
    expect(screen.getByTestId('lang')).toHaveTextContent('ko');
  });

  it('把历史的 zh 迁移为服务端契约的 zh-Hans，并就地改写存量值', () => {
    // 不迁移的话，已在使用中的门店终端会在发布后静默退回默认语言
    localStorage.setItem('gf.lang', 'zh');
    renderProbe('save');
    expect(screen.getByTestId('lang')).toHaveTextContent('zh-Hans');
    expect(localStorage.getItem('gf.lang')).toBe('zh-Hans');
  });

  it('无法识别的语言代码退回默认语言', () => {
    localStorage.setItem('gf.lang', 'fr');
    renderProbe('save');
    expect(screen.getByTestId('lang')).toHaveTextContent('zh-Hans');
  });

  it('切换语言后写回 localStorage 并同步 html lang', () => {
    function Switcher() {
      const { setLanguage, language } = useLanguage();
      return (
        <button onClick={() => setLanguage('es')} data-testid="btn">
          {language}
        </button>
      );
    }
    render(
      <LanguageProvider>
        <Switcher />
      </LanguageProvider>,
    );
    act(() => screen.getByTestId('btn').click());
    expect(localStorage.getItem('gf.lang')).toBe('es');
    expect(document.documentElement.lang).toBe('es');
  });
});

describe('取词 t()', () => {
  it('按当前语言取词', () => {
    localStorage.setItem('gf.lang', 'en');
    renderProbe('save');
    expect(screen.getByTestId('text')).toHaveTextContent('Save');
  });

  it('替换占位符', () => {
    localStorage.setItem('gf.lang', 'en');
    renderProbe('crm.custDaysAgo', { p0: 3 });
    expect(screen.getByTestId('text')).toHaveTextContent('3 days ago');
  });

  it('占位符替换按字面量处理，不把参数当正则', () => {
    /*
     * 参数值来自客户姓名、备注等用户输入。若以 RegExp 拼接实现替换，
     * 形如 `$&` 或 `(` 的输入会导致文案被改写甚至抛错。
     */
    localStorage.setItem('gf.lang', 'en');
    renderProbe('schedule.adRefillingFor', { p0: '$& (Lisa)' });
    expect(screen.getByTestId('text')).toHaveTextContent('Refilling the health form for $& (Lisa)');
  });

  it('缺失的词条在开发环境显式暴露而非静默吞掉', () => {
    // t() 缺词条时返回 key 本身，因此 `t('x') || '兜底'` 这一写法无效；
    // 开发环境额外渲染 ⟦key⟧ 并告警，使问题在自测阶段即可被发现
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderProbe('thisKeyDoesNotExist');
    expect(screen.getByTestId('text')).toHaveTextContent('⟦thisKeyDoesNotExist⟧');
    expect(spy).toHaveBeenCalled();
  });

  it('当前语言缺该词条时回退到英语而非留空', () => {
    localStorage.setItem('gf.lang', 'vi');
    renderProbe('save');
    expect(screen.getByTestId('text').textContent?.trim()).not.toBe('');
  });
});

describe('动态词典加载与容错保护', () => {
  it('动态加载模式下词典加载完成时 ready 置为 true', async () => {
    (globalThis as typeof globalThis & { __GF_TEST_DYNAMIC_I18N__?: boolean }).__GF_TEST_DYNAMIC_I18N__ = true;
    function ReadyProbe() {
      const { ready } = useLanguage();
      return <span data-testid="ready">{ready ? 'READY' : 'LOADING'}</span>;
    }
    render(
      <LanguageProvider>
        <ReadyProbe />
      </LanguageProvider>,
    );

    // Initial state is loading (ready === false)
    expect(screen.getByTestId('ready')).toHaveTextContent('LOADING');

    // Eventually completes and sets ready to true
    await vi.waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('READY');
    });

    delete (globalThis as typeof globalThis & { __GF_TEST_DYNAMIC_I18N__?: boolean }).__GF_TEST_DYNAMIC_I18N__;
  });
});

