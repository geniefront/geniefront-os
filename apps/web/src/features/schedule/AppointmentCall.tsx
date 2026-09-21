import {
  CallConversation,
  type ConversationLine,
} from "@/features/comms/CallConversation";
import { VoiceActivityLabels } from "@/features/comms/VoiceActivityLabels";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/session";
import { apiGet } from "@/lib/api";
import { useLanguage } from "@/LanguageContext";
import { useStoreTime } from "@/lib/time";
import { Button } from "@/components/ui/Button";
interface Call {
  callId: string;
  startedAt: string | null;
  summary: string | null;
  transcript: ConversationLine[];
  hasRecording: boolean;
  createdBooking: boolean;
  billingStatus: string;
  actions: Array<{ action: string; outcome: string }>;
}
function Recording({ call }: { call: Call }) {
  const { t } = useLanguage();
  const [audio, setAudio] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  async function play() {
    setBusy(true);
    setError(false);
    try {
      setAudio(
        (
          await apiGet<{ url: string }>(
            `/v1/desk/calls/${call.callId}/recording`,
          )
        ).url,
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {call.hasRecording &&
        (audio ? (
          <audio controls src={audio} className="w-full" />
        ) : (
          <Button isPending={busy} onPress={() => void play()}>
            {t("bookingCallRecording")}
          </Button>
        ))}
      {error && <p role="alert">{t("bookingCallError")}</p>}
    </>
  );
}
export function AppointmentCall({ appointmentId }: { appointmentId: string }) {
  const { membershipId } = useSession(),
    { t } = useLanguage(),
    time = useStoreTime();
  const q = useQuery({
    queryKey: ["appointment-call", appointmentId, membershipId],
    queryFn: async () => {
      const data = await apiGet<{ calls?: Call[]; call?: Call | null }>(
        `/v1/desk/appointments/${appointmentId}/call`,
      );
      return {
        calls:
          data.calls ??
          (data.call
            ? [
                {
                  ...data.call,
                  actions: data.call.actions ?? [],
                  createdBooking: data.call.createdBooking ?? true,
                  billingStatus: data.call.billingStatus ?? "legacy",
                },
              ]
            : []),
      };
    },
    refetchInterval: 15000,
  });
  return (
    <details className="rounded-xl border bg-white p-4">
      <summary className="cursor-pointer font-semibold">
        {t("bookingCallDetails")}{" "}
        {q.data?.calls.length ? `(${q.data.calls.length})` : ""}
      </summary>
      <div className="mt-3 space-y-4 text-sm">
        {q.isError ? (
          <p role="alert">{t("bookingCallError")}</p>
        ) : !q.data?.calls.length ? (
          <p>{t("bookingCallEmpty")}</p>
        ) : (
          q.data.calls.map((call) => (
            <section key={call.callId} className="space-y-3 rounded border p-3">
              <div>
                {call.startedAt && (
                  <p className="mb-2 text-xs text-slate-500">
                    {time.dateTime(call.startedAt)}
                  </p>
                )}
                {call.createdBooking && (
                  <span className="mr-2 text-xs">
                    {t("voiceActionCreated")}
                  </span>
                )}
                <VoiceActivityLabels actions={call.actions} />
              </div>
              {call.summary && (
                <p className="whitespace-pre-wrap">{call.summary}</p>
              )}
              <Recording key={`${membershipId}:${call.callId}`} call={call} />
              {!call.transcript.length && (
                <p className="text-slate-500">
                  {t(
                    call.billingStatus === "review"
                      ? "voiceTranscriptReview"
                      : "bookingCallProcessing",
                  )}
                </p>
              )}
              <div className="max-h-96 overflow-auto">
                <CallConversation lines={call.transcript} />
              </div>
            </section>
          ))
        )}
      </div>
    </details>
  );
}
