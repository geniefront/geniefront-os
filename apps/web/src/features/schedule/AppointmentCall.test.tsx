import { it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppointmentCall } from "./AppointmentCall";
vi.mock("@/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/session", () => ({
  useSession: () => ({ membershipId: "staff" }),
}));
vi.mock("@/lib/time", () => ({
  useStoreTime: () => ({ dateTime: (value: string) => value }),
}));
vi.mock("@/components/ui/Button", () => ({
  Button: ({ children }: any) => <button>{children}</button>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      calls: [
        {
          callId: "created",
          startedAt: "2026-09-20",
          createdBooking: true,
          hasRecording: true,
          billingStatus: "settled",
          summary: "First call",
          transcript: [{ role: "user", text: "Book please" }],
          actions: [],
        },
        {
          callId: "changed",
          startedAt: "2026-09-21",
          createdBooking: false,
          hasRecording: true,
          billingStatus: "pending",
          summary: null,
          transcript: [],
          actions: [
            { action: "reschedule", outcome: "completed" },
            { action: "cancel", outcome: "requested" },
          ],
        },
      ],
    },
  }),
}));
it("shows all related recordings, actual outcomes and pending transcript independently", () => {
  const html = renderToStaticMarkup(
    <AppointmentCall appointmentId="web-booking" />,
  );
  expect(html).toContain("(2)");
  expect(html.match(/bookingCallRecording/g)).toHaveLength(2);
  expect(html).toContain("voiceActionCreated");
  expect(html).toContain("voiceActionRescheduled");
  expect(html).toContain("voiceActionCancelRequested");
  expect(html).not.toContain("voiceActionCancelled");
  expect(html).toContain("bookingCallProcessing");
  expect(html).toContain("Book please");
});
