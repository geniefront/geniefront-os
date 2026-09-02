import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Unsubscribe } from './Unsubscribe';

vi.mock('@/lib/api', () => ({ API_BASE: 'http://api.test' }));

function renderPage(search = '?t=tok_1') {
  return render(
    <MemoryRouter initialEntries={[`/unsubscribe${search}`]}>
      <Routes>
        <Route path="/unsubscribe" element={<Unsubscribe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('营销邮件退订页', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('先展示确认，不在打开时发 POST', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    expect(screen.getByRole('heading', { name: /unsubscribe from marketing emails/i })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('点确认后 POST 公开接口，然后显示已退订', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage('?t=abc%201');
    await user.click(screen.getByRole('button', { name: /^unsubscribe$/i }));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/public/v1/email/unsubscribe?t=abc%201',
      { method: 'POST' },
    );
    expect(await screen.findByRole('heading', { name: /you are unsubscribed/i })).toBeInTheDocument();
    expect(screen.getByText(/appointment confirmations/i)).toBeInTheDocument();
  });
});
