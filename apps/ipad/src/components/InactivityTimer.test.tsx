import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { InactivityTimer } from './InactivityTimer';
import { LanguageProvider } from '../context/LanguageContext';

describe('InactivityTimer Privacy Protection Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers onTimeout when idle timeout and countdown elapse', () => {
    const handleTimeout = vi.fn();
    render(
      <LanguageProvider>
        <InactivityTimer
          onTimeout={handleTimeout}
          idleTimeoutSeconds={2}
          countdownSeconds={2}
          enabled={true}
        />
      </LanguageProvider>,
    );

    // Advance past idle timeout (2s)
    act(() => {
      vi.advanceTimersByTime(2100);
    });

    expect(screen.getByText('您还在操作吗？')).toBeInTheDocument();

    // Advance countdown past (2s)
    act(() => {
      vi.advanceTimersByTime(2100);
    });

    expect(handleTimeout).toHaveBeenCalledTimes(1);
  });

  it('immediately triggers onTimeout when page visibility becomes hidden', () => {
    const handleTimeout = vi.fn();
    render(
      <LanguageProvider>
        <InactivityTimer
          onTimeout={handleTimeout}
          idleTimeoutSeconds={60}
          countdownSeconds={10}
          enabled={true}
        />
      </LanguageProvider>,
    );

    act(() => {
      Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(handleTimeout).toHaveBeenCalledTimes(1);
  });
});
