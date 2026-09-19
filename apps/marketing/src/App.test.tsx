import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from './pages/Home';
import { Success } from './pages/Success';
import { Privacy, Sms, Terms } from './pages/Legal';
import { navigation } from './lib/checkout';
import { MARKETING_PLAN_PRICES_CENTS, MARKETING_PLAN_QUOTAS, PLAN_PRICES_CENTS, PLAN_QUOTAS } from './lib/plans';

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

describe('Marketing sign-in', () => {
  it('home nav and footer link to the desk login origin', () => {
    renderHome();
    const links = screen.getAllByRole('link', { name: /^sign in$/i });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/\/$/);
      expect(link.getAttribute('href')).not.toContain('localhost:5180');
    }
  });
});

describe('Marketing pricing and signup', () => {
  it('15. all three plans render including AI Voice Booking', () => {
    renderHome();
    expect(screen.getByTestId('plan-voice-booking')).toHaveTextContent('AI Voice Booking');
    expect(screen.getByTestId('plan-voice-booking'))
      .toHaveTextContent(`$${MARKETING_PLAN_PRICES_CENTS.voice_booking / 100}`);
    expect(screen.getByTestId('plan-voice-booking'))
      .toHaveTextContent(String(MARKETING_PLAN_QUOTAS.voice_booking.voiceMinutes));
    expect(screen.getByTestId('plan-voice-booking'))
      .toHaveTextContent('Unlimited SMS & Email Appointment Reminders');
    expect(screen.getByTestId('plan-voice-booking'))
      .toHaveTextContent('Appointment management and customer details');
    expect(screen.getByTestId('plan-voice-booking'))
      .toHaveTextContent('Free Managed Shop Showcase Website Creation');
    expect(screen.getByTestId('plan-voice-booking'))
      .toHaveTextContent('No booking-to-checkout / POS register flow');
    expect(screen.getByTestId('plan-voice-booking'))
      .toHaveTextContent('No digital intake / health forms or iPad kiosk');
    expect(screen.getByTestId('plan-voice-booking'))
      .toHaveTextContent('No front-desk AI Copilot operations & turn engine');
    expect(screen.getByTestId('plan-voice-booking'))
      .toHaveTextContent('No room & equipment station management');

    expect(screen.getByTestId('plan-essential')).toHaveTextContent('Essential');
    expect(screen.getByTestId('plan-growth')).toHaveTextContent('Growth');
    expect(screen.getByTestId('plan-essential'))
      .toHaveTextContent(`$${PLAN_PRICES_CENTS.essential / 100}`);
    expect(screen.getByTestId('plan-growth'))
      .toHaveTextContent(`$${PLAN_PRICES_CENTS.growth / 100}`);
    expect(screen.getByTestId('plan-essential'))
      .toHaveTextContent(String(PLAN_QUOTAS.essential.credits));
    expect(screen.getByTestId('plan-growth'))
      .toHaveTextContent(String(PLAN_QUOTAS.growth.voiceMinutes));
  });

  it('16. stale Starter/Enterprise do not render', () => {
    renderHome();
    expect(screen.getByTestId('plan-essential')).not.toHaveTextContent(/Starter|Enterprise|\$89|\$169|\$299/i);
    expect(screen.getByTestId('plan-growth')).not.toHaveTextContent(/Starter|Enterprise|\$89|\$169|\$299/i);
    expect(screen.getByTestId('plan-essential')).toHaveTextContent('Free Managed Website Creation Included');
    expect(screen.getByTestId('plan-growth')).toHaveTextContent('Free Managed Website Creation Included');
    expect(screen.getByTestId('plan-essential')).toHaveTextContent('AI Customer Service Configuration Included');
    expect(screen.getByTestId('plan-growth')).toHaveTextContent('AI Customer Service Configuration Included');
    expect(screen.getByTestId('plan-growth')).toHaveTextContent('VIP Professional 1-to-1 Technical Support');
  });

  it('17. form validation works', async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByTestId('cta-essential'));
    await user.click(screen.getByTestId('checkout-submit'));
    const err = screen.getByTestId('signup-error');
    expect(err).toHaveTextContent('Shop name is required.');
    expect(err).toHaveTextContent('Owner email is required.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigation.assign).not.toHaveBeenCalled();

    await user.type(screen.getByTestId('shop-name'), 'Lotus Nails');
    await user.type(screen.getByTestId('owner-email'), 'not-an-email');
    await user.click(screen.getByTestId('checkout-submit'));
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
    await user.click(screen.getByTestId('cta-growth'));
    await user.type(screen.getByTestId('shop-name'), 'Lotus Nails');
    await user.type(screen.getByTestId('owner-email'), 'owner@maildrop.cc');
    await user.click(screen.getByTestId('checkout-submit'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      shopName: 'Lotus Nails',
      ownerEmail: 'owner@maildrop.cc',
      plan: 'growth',
    });
    expect(navigation.assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_abc');
  });

  it('18b. voice booking trial CTA opens modal and submits checkout', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_voice' }),
    });
    renderHome();
    await user.click(screen.getByTestId('cta-voice-booking'));
    await user.type(screen.getByTestId('shop-name'), 'Golden Lotus Spa');
    await user.type(screen.getByTestId('owner-email'), 'voice@maildrop.cc');
    await user.click(screen.getByTestId('checkout-submit'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      shopName: 'Golden Lotus Spa',
      ownerEmail: 'voice@maildrop.cc',
      plan: 'voice_booking',
    });
    expect(navigation.assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_voice');
  });

  it('19. missing/invalid URL does not redirect', async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByTestId('cta-essential'));
    await user.type(screen.getByTestId('shop-name'), 'Lotus Nails');
    await user.type(screen.getByTestId('owner-email'), 'owner@maildrop.cc');

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await user.click(screen.getByTestId('checkout-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('signup-error')).toBeInTheDocument();
    });
    expect(navigation.assign).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'https://evil.example/phish' }),
    });
    await user.click(screen.getByTestId('checkout-submit'));
    await waitFor(() => {
      expect(navigation.assign).not.toHaveBeenCalled();
    });

    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test' }) });
    await user.click(screen.getByTestId('checkout-submit'));
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

  it('terms, privacy, and SMS routes are not broken', () => {
    renderHome();
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms/');
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy/');
    expect(screen.getByRole('link', { name: 'SMS Terms' })).toHaveAttribute('href', '/sms/');

    render(
      <MemoryRouter>
        <Terms />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
    render(
      <MemoryRouter>
        <Privacy />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    render(
      <MemoryRouter>
        <Sms />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'SMS Terms' })).toBeInTheDocument();
  });
});
