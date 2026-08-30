import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from './pages/Home';
import { Success } from './pages/Success';
import { Privacy, Terms } from './pages/Legal';
import { navigation } from './lib/checkout';
import { PLAN_PRICES_CENTS, PLAN_QUOTAS } from './lib/plans';
import { formatUsdMonthly } from './lib/money';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(navigation, 'assign').mockImplementation(() => undefined);
});

function renderHome() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
}

describe('Marketing pricing and signup', () => {
  it('15. both canonical plans render', () => {
    renderHome();
    expect(screen.getByTestId('plan-essential')).toHaveTextContent('Essential');
    expect(screen.getByTestId('plan-growth')).toHaveTextContent('Growth');
    expect(screen.getByTestId('plan-essential'))
      .toHaveTextContent(formatUsdMonthly(PLAN_PRICES_CENTS.essential));
    expect(screen.getByTestId('plan-growth'))
      .toHaveTextContent(formatUsdMonthly(PLAN_PRICES_CENTS.growth));
    expect(screen.getByTestId('plan-essential'))
      .toHaveTextContent(String(PLAN_QUOTAS.essential.credits));
    expect(screen.getByTestId('plan-growth'))
      .toHaveTextContent(String(PLAN_QUOTAS.growth.voiceMinutes));
  });

  it('16. stale Starter/Enterprise do not render', () => {
    renderHome();
    expect(screen.queryByText(/Starter/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Enterprise/i)).not.toBeInTheDocument();
    expect(screen.queryByText('$89')).not.toBeInTheDocument();
    expect(screen.queryByText('$169')).not.toBeInTheDocument();
    expect(screen.queryByText('$299')).not.toBeInTheDocument();
  });

  it('17. form validation works', async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByTestId('cta-essential'));
    const err = screen.getByTestId('signup-error');
    expect(err).toHaveTextContent('Shop name is required.');
    expect(err).toHaveTextContent('Owner email is required.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigation.assign).not.toHaveBeenCalled();

    await user.type(screen.getByTestId('shop-name'), 'Lotus Nails');
    await user.type(screen.getByTestId('owner-email'), 'not-an-email');
    await user.click(screen.getByTestId('cta-growth'));
    expect(screen.getByTestId('signup-error')).toHaveTextContent('Enter a valid owner email.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('18. valid response redirects to Stripe URL', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }),
    });
    renderHome();
    await user.type(screen.getByTestId('shop-name'), 'Lotus Nails');
    await user.type(screen.getByTestId('owner-email'), 'owner@example.test');
    await user.click(screen.getByTestId('cta-growth'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      shopName: 'Lotus Nails',
      ownerEmail: 'owner@example.test',
      plan: 'growth',
    });
    expect(navigation.assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_abc');
  });

  it('19. missing/invalid URL does not redirect', async () => {
    const user = userEvent.setup();
    renderHome();
    await user.type(screen.getByTestId('shop-name'), 'Lotus Nails');
    await user.type(screen.getByTestId('owner-email'), 'owner@example.test');

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await user.click(screen.getByTestId('cta-essential'));
    await waitFor(() => {
      expect(screen.getByTestId('signup-error')).toBeInTheDocument();
    });
    expect(navigation.assign).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'https://evil.example/phish' }),
    });
    await user.click(screen.getByTestId('cta-essential'));
    await waitFor(() => {
      expect(navigation.assign).not.toHaveBeenCalled();
    });

    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test' }) });
    await user.click(screen.getByTestId('cta-essential'));
    await waitFor(() => {
      expect(navigation.assign).not.toHaveBeenCalled();
    });
  });

  it('20. success page does not claim payment without a verified session', () => {
    render(
      <MemoryRouter>
        <Success />
      </MemoryRouter>,
    );
    const msg = screen.getByTestId('success-message');
    expect(screen.getByTestId('success-state')).toHaveTextContent('invalid');
    expect(msg).toHaveTextContent(/could not confirm/i);
    expect(msg.textContent).not.toMatch(/checkout completed/i);
    expect(msg.textContent).not.toMatch(/payment (was )?received/i);
    expect(msg.textContent).not.toMatch(/account is (ready|active)/i);
    expect(screen.queryByRole('link', { name: /log in/i })).not.toBeInTheDocument();
  });

  it('21. verified session_id shows confirmed checkout, still not activated', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'confirmed', plan: 'essential' }),
    });
    render(
      <MemoryRouter initialEntries={['/signup/success?session_id=cs_test_gfsuccesslookupabc123']}>
        <Success />
      </MemoryRouter>,
    );
    const msg = await screen.findByText(/checkout completed/i);
    expect(screen.getByTestId('success-state')).toHaveTextContent('confirmed');
    expect(msg).toHaveTextContent(/not active yet/i);
    expect(msg.textContent).not.toMatch(/account is (ready|active)/i);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(
      '/v1/public/signup-session?session_id=cs_test_gfsuccesslookupabc123',
    ));
  });

  it('22. pending lookup does not claim payment was received', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'pending', plan: 'essential' }),
    });
    render(
      <MemoryRouter initialEntries={['/signup/success?session_id=cs_test_gfsuccesslookupabc123']}>
        <Success />
      </MemoryRouter>,
    );
    const msg = await screen.findByTestId('success-message');
    expect(await screen.findByTestId('success-state')).toHaveTextContent('pending');
    expect(msg).toHaveTextContent(/confirming your signup/i);
    expect(msg.textContent).not.toMatch(/checkout completed/i);
    expect(msg.textContent).not.toMatch(/payment (was )?received/i);
  });

  it('23. unknown session_id does not claim payment', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'invalid' }),
    });
    render(
      <MemoryRouter initialEntries={['/signup/success?session_id=cs_test_unknownsessionid999']}>
        <Success />
      </MemoryRouter>,
    );
    const msg = await screen.findByText(/could not confirm/i);
    expect(screen.getByTestId('success-state')).toHaveTextContent('invalid');
    expect(msg.textContent).not.toMatch(/checkout completed/i);
  });

  it('terms and privacy routes are not broken', () => {
    renderHome();
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');

    render(
      <MemoryRouter>
        <Terms />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Placeholder — final legal copy pending/)).toBeInTheDocument();
    render(
      <MemoryRouter>
        <Privacy />
      </MemoryRouter>,
    );
    expect(screen.getAllByText(/Placeholder — final legal copy pending/).length).toBeGreaterThan(0);
  });
});
