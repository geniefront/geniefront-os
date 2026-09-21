import { useLanguage } from "@/LanguageContext";
export function VoiceActivityLabels({
  actions,
}: {
  actions: Array<{ action: string; outcome: string }>;
}) {
  const { t } = useLanguage();
  return (
    <>
      {[
        ...new Map(
          actions.map((a) => [`${a.action}:${a.outcome}`, a]),
        ).values(),
      ].map((a) => (
        <span
          key={`${a.action}:${a.outcome}`}
          className="mr-2 inline-block rounded bg-teal-50 px-2 py-1 text-xs text-teal-800"
        >
          {t(
            a.action === "lookup"
              ? "voiceActionLookup"
              : a.action === "cancel"
                ? a.outcome === "completed"
                  ? "voiceActionCancelled"
                  : "voiceActionCancelRequested"
                : a.outcome === "completed"
                  ? "voiceActionRescheduled"
                  : "voiceActionRescheduleRequested",
          )}
        </span>
      ))}
    </>
  );
}
