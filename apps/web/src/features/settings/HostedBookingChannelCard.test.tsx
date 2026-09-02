import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HostedBookingChannelCard } from './HostedBookingChannelCard';

vi.mock('@/LanguageContext', () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars?.p0 ? `${key}:${vars.p0}` : key,
  }),
}));

vi.mock('@heroui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heroui/react')>();
  return { ...actual, toast: { success: vi.fn(), danger: vi.fn() } };
});

describe('HostedBookingChannelCard', () => {
  it('uses one canonical URL for copy, open, and QR', () => {
    render(
      <HostedBookingChannelCard
        origin="https://book.geniefront.com"
        slug="lotus-nails"
        bookableCount={4}
        onSaveSlug={async () => {}}
        saving={false}
        slugError={null}
      />,
    );
    const url = screen.getByTestId('hosted-url').textContent;
    expect(url).toBe('https://book.geniefront.com/lotus-nails');
    expect(screen.getByTestId('hosted-copy')).toBeInTheDocument();
    expect(screen.getByTestId('hosted-open')).toBeInTheDocument();
    expect(screen.getByTestId('hosted-qr')).toBeInTheDocument();
  });
});
