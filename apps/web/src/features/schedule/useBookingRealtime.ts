import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";

/** Public booking mutations invalidate authorized desk reads; no PII in broadcasts. */
export function useBookingRealtime() {
  const { membership, membershipId, session, isOnline } = useSession();
  const client = useQueryClient();
  useEffect(() => {
    if (!membership || !membershipId || !session?.access_token || !isOnline)
      return;
    let live = false;
    let lastRefresh = 0;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      lastRefresh = Date.now();
      void client.invalidateQueries({
        queryKey: ["desk", "day", membershipId],
      });
      void client.invalidateQueries({
        queryKey: ["desk", "days", membershipId],
      });
      void client.invalidateQueries({
        queryKey: ["desk", "appointment-detail"],
      });
    };
    void supabase.realtime.setAuth(session.access_token);
    const channel = supabase
      .channel(`location:${membership.locationId}`, {
        config: { private: true },
      })
      .on("broadcast", { event: "appointment.changed" }, refresh)
      .subscribe((status) => {
        live = status === "SUBSCRIBED";
        if (live) refresh();
      });
    const timer = window.setInterval(() => {
      if (!live || Date.now() - lastRefresh >= 60000) refresh();
    }, 30000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      void supabase.removeChannel(channel);
    };
  }, [
    membership?.locationId,
    membershipId,
    session?.access_token,
    isOnline,
    client,
  ]);
}
