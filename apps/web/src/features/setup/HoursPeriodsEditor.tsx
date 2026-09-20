import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useLanguage } from "@/LanguageContext";
export type DayHours = {
  open: string;
  close: string;
  periods?: Array<{ open: string; close: string }>;
};
export function HoursPeriodsEditor({
  value,
  onChange,
  label,
}: {
  value: DayHours;
  onChange: (v: DayHours) => void;
  label: string;
}) {
  const { language } = useLanguage();
  const zh = language.startsWith("zh");
  const periods = value.periods ?? [{ open: value.open, close: value.close }];
  const update = (next: Array<{ open: string; close: string }>) =>
    onChange({ open: next[0]!.open, close: next.at(-1)!.close, periods: next });
  return (
    <div className="grid gap-2 min-w-0">
      {periods.map((p, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            type="time"
            className="w-28"
            aria-label={`${label} ${i + 1} ${zh ? "开始" : "Start"}`}
            value={p.open}
            onChange={(e) =>
              update(
                periods.map((v, n) =>
                  n === i ? { ...v, open: e.target.value } : v,
                ),
              )
            }
          />
          <span>—</span>
          <Input
            type="time"
            className="w-28"
            aria-label={`${label} ${i + 1} ${zh ? "结束" : "End"}`}
            value={p.close}
            onChange={(e) =>
              update(
                periods.map((v, n) =>
                  n === i ? { ...v, close: e.target.value } : v,
                ),
              )
            }
          />
          {periods.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${zh ? "删除时段" : "Remove period"} ${i + 1}`}
              onClick={() => update(periods.filter((_, n) => n !== i))}
            >
              ×
            </Button>
          )}
        </div>
      ))}
      {periods.length < 6 && (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => {
            const last = periods.at(-1)!;
            const minutes = (v: string) =>
              Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
            const clock = (m: number) =>
              `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
            const start = minutes(last.open),
              rawEnd = minutes(last.close),
              end = rawEnd <= start ? rawEnd + 1440 : rawEnd;
            const middle = Math.floor((start + end) / 120) * 60;
            if (end - start >= 180 && middle + 60 < 1440)
              update([
                ...periods.slice(0, -1),
                { open: last.open, close: clock(middle) },
                { open: clock(middle + 60), close: last.close },
              ]);
            else
              update([
                ...periods,
                { open: last.close, close: clock(end + 60) },
              ]);
          }}
        >
          + {zh ? "添加时段" : "Add period"}
        </Button>
      )}
    </div>
  );
}
