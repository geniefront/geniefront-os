import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { BookingExperiencePage } from "./BookingExperiencePage";
const api = vi.hoisted(() => ({
  book: vi.fn(),
  getHostedShop: vi.fn(),
  getServices: vi.fn(),
  getBundles:vi.fn(),
  getPartyAvailability: vi.fn(),
}));
vi.mock("../lib/api", async () => ({
  ...(await vi.importActual("../lib/api")),
  ...api,
}));
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  api.getHostedShop.mockResolvedValue({
    name: "Test Salon",
    slug: "test",
    timezone: "America/New_York",
    currency: "USD",
    publicKey: "pk_test",
    phone: null,
    address: null,
    businessHours: {},
    locales: ["en"],
    onlineBooking: {
      enabled: true,
      maxDaysAhead: 60,
      minMinutesAhead: 0,
      cancelCutoffHours: 4,
    },
    turnstileSiteKey: null,
  });
  api.getBundles.mockResolvedValue({bundles:[]});
  api.getServices.mockResolvedValue({
    categories: [],
    addons: [],
    services: [
      {
        id: "a",
        name: "Massage",
        durationMin: 60,
        priceCents: 5000,
        description: null,
        categoryId: null,
        isAddon: false,
      },
    ],
  });
  api.getPartyAvailability.mockImplementation(async (date, items) => ({
    date,
    timezone: "America/New_York",
    staff: [
      { id: "s1", displayName: "Amy", avatarUrl: null },
      { id: "s2", displayName: "Sam", avatarUrl: null },
    ],
    plans: [
      {
        startsAt: "2026-10-01T14:00:00.000Z",
        items: items.map((i: any) => ({
          ...i,
          staffId: `s${i.guestIndex + 1}`,
          startsAt: "2026-10-01T14:00:00.000Z",
          endsAt: "2026-10-01T15:00:00.000Z",
          durationMin: 60,
          priceCents: 5000,
        })),
      },
    ],
  }));
  api.book.mockResolvedValue({
    bookingId: "booking",
    confirmationCode: "TS-1234",
    manageToken: "token",
    status: "booked",
    startsAt: "2026-10-01T14:00:00.000Z",
    durationMin: 60,
    replayed: false,
  });
});
it("retains a storefront selection, assigns each guest, reviews before atomic submission", async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/test"]}>
        <Routes>
          <Route path="/:slug" element={<BookingExperiencePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole('button',{name:'Add Massage'}));
  await user.click(screen.getByRole('button',{name:/Add to booking/}));
  await user.click(screen.getByRole('button',{name:'Increase Number of guests'}));
  await user.click(screen.getByRole('button',{name:'Guest names'}));
  await user.type(screen.getByLabelText('Guest 2'), 'Alex');
  await user.click(screen.getByRole('button',{name:/Alex/}));
  await user.click(screen.getByRole('button',{name:'Add Massage'}));
  await user.click(screen.getByRole('button',{name:/Add to booking/}));
  await user.click(screen.getAllByRole('button',{name:/^Choose time/})[0]!);
  await user.click(await screen.findByRole('button',{name:'10:00 AM'}));
  await user.click(screen.getAllByRole('button',{name:/^Continue/})[0]!);
  const consent=screen.getByRole('checkbox',{name:'Receive appointment texts'});
  expect(consent).not.toBeChecked();
  await user.click(consent);
  await user.type(screen.getByLabelText("Name"), "Test Guest");
  await user.type(screen.getByLabelText("Mobile phone"), "6175550199");
  await user.click(screen.getByRole("button", { name: "Review appointment" }));
  expect(api.book).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Book appointment" }));
  await waitFor(() => expect(api.book).toHaveBeenCalledTimes(1));
  expect(api.book.mock.calls[0][0]).toMatchObject({
    partySize: 2,
    notes: "Guest 2: Alex",
    customer:{smsOptIn:false,bookingSmsConsent:true},
    items: [
      { guestIndex: 0, quotedPriceCents: 5000 },
      { guestIndex: 1, quotedPriceCents: 5000 },
    ],
  });
  expect(screen.getAllByText(/Alex/).length).toBeGreaterThan(0);
  expect(await screen.findByText("TS-1234")).toBeInTheDocument();
  expect(
    screen.queryByText(/sent the details to your phone/),
  ).not.toBeInTheDocument();
});

it("explains unavailable times and offers another date", async () => {
  api.getPartyAvailability.mockResolvedValue({ date: "2026-10-01", timezone: "America/New_York", staff: [], plans: [] });
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={["/test"]}><Routes><Route path="/:slug" element={<BookingExperiencePage />} /></Routes></MemoryRouter>
  </QueryClientProvider>);
  expect(await screen.findByRole("combobox", { name: "Language" })).toHaveValue("en");
  await user.click(await screen.findByRole("button", { name: "Add Massage" }));
  await user.click(screen.getByRole("button", { name: /Add to booking/ }));
  await user.click(screen.getAllByRole("button", { name: /^Choose time/ })[0]!);
  expect(await screen.findByRole("heading", { name: "No times available for this date" })).toBeInTheDocument();
  expect(screen.getByText("Choose another date or change your specialist preferences.")).toBeInTheDocument();
  const previous = api.getPartyAvailability.mock.calls.at(-1)![0];
  await user.click(screen.getByRole("button", { name: /Check next day/ }));
  await waitFor(() => expect(api.getPartyAvailability.mock.calls.at(-1)![0]).not.toBe(previous));
});
