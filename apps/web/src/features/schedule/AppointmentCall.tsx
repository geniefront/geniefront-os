import { CallConversation, type ConversationLine } from '@/features/comms/CallConversation';
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/session";
import { apiGet } from "@/lib/api";
import { useLanguage } from "@/LanguageContext";
import { Button } from "@/components/ui/Button";
export function AppointmentCall({ appointmentId }: { appointmentId: string }) {
  const { membershipId } = useSession(),
    { t } = useLanguage(),
    [audio, setAudio] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const q = useQuery({
    queryKey: ["appointment-call", appointmentId, membershipId],
    queryFn: () =>
      apiGet<{
        call: {
          callId: string;
          summary: string | null;
          transcript: ConversationLine[];
          hasRecording: boolean;
        } | null;
      }>(`/v1/desk/appointments/${appointmentId}/call`),
    refetchInterval: (query) => (query.state.data?.call ? false : 15000),
  });
  useEffect(() => {
    setAudio("");
    setError(false);
    setBusy(false);
  }, [appointmentId, membershipId]);
  const call = q.data?.call;
  async function play() {
    if (!call) return;
    setBusy(true);
    setError(false);
    try {
      const r = await apiGet<{ url: string }>(
        `/v1/desk/calls/${call.callId}/recording`,
      );
      setAudio(r.url);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-xl border bg-white p-4">
      <summary className="cursor-pointer font-semibold">
        {t("bookingCallDetails")}
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        {q.isError ? (
          <p role="alert">{t("bookingCallError")}</p>
        ) : !call ? (
          <p>{t("bookingCallProcessing")}</p>
        ) : (
          <>
            {call.summary && (
              <p className="whitespace-pre-wrap">{call.summary}</p>
            )}
            {call.hasRecording &&
              (audio ? (
                <audio controls src={audio} className="w-full" />
              ) : (
                <Button isPending={busy} onPress={() => void play()}>
                  {t("bookingCallRecording")}
                </Button>
              ))}
            {error && <p role="alert">{t("bookingCallError")}</p>}
            <div className="max-h-96 space-y-3 overflow-auto">
              <CallConversation lines={call.transcript} />
            </div>
          </>
        )}
      </div>
    </details>
  );
}
