import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBookingRealtime } from "./useBookingRealtime";
const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  remove: vi.fn(),
  setAuth: vi.fn(),
  channel: vi.fn(),
  session: {
    membership: { locationId: "shop-a" },
    membershipId: "member-a",
    session: { access_token: "test-token" },
    isOnline: true,
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock("@/lib/session", () => ({ useSession: () => mocks.session }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    realtime: { setAuth: mocks.setAuth },
    channel: mocks.channel,
    removeChannel: mocks.remove,
  },
}));
let receive: () => void;
let connection: (status: string) => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  const channel = {
    on: vi.fn((_type, _filter, callback) => {
      receive = callback;
      return channel;
    }),
    subscribe: vi.fn((callback) => {
      connection = callback;
      return channel;
    }),
  };
  mocks.channel.mockReturnValue(channel);
  mocks.session.isOnline = true;
});
afterEach(() => vi.useRealTimers());
it("refreshes tenant-scoped calendar reads after a booking broadcast and removes its subscription", () => {
  const { unmount } = renderHook(useBookingRealtime);
  expect(mocks.channel).toHaveBeenCalledWith("location:shop-a", {
    config: { private: true },
  });
  act(() => receive());
  expect(mocks.invalidate).toHaveBeenCalledWith({
    queryKey: ["desk", "day", "member-a"],
  });
  expect(mocks.invalidate).toHaveBeenCalledWith({
    queryKey: ["desk", "days", "member-a"],
  });
  unmount();
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});
it("reconciles on disconnect but does not poll a healthy connection", () => {
  const { unmount } = renderHook(useBookingRealtime);
  act(() => connection("SUBSCRIBED"));
  mocks.invalidate.mockClear();
  act(() => vi.advanceTimersByTime(30000));
  expect(mocks.invalidate).not.toHaveBeenCalled();
  act(() => connection("CHANNEL_ERROR"));
  act(() => vi.advanceTimersByTime(30000));
  expect(mocks.invalidate).toHaveBeenCalledTimes(3);
  unmount();
});
