import {BookingImagePicker} from '@/components/ui/BookingImagePicker';
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  publicBookingProfileSchema,
  pickText,
  type PublicBookingProfile,
} from "@gf/contracts";
import { ImageUploader } from "@/components/ui/ImageUploader";
import { useSession } from "@/lib/session";
import { runCommand } from "@/lib/api";
import type { ServiceItem } from "./types";

export function PublicBookingProfileCard({
  profile,
  services,
  resourceTypes = [],
}: {
  profile?: PublicBookingProfile;
  services: ServiceItem[];
  resourceTypes?: Array<{ id: string; name: Record<string, string> }>;
}) {
  const [draft, setDraft] = useState(() =>
    publicBookingProfileSchema.parse(profile ?? {}),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const queryClient = useQueryClient();
  const { membershipId } = useSession();
  const patch = (p: Partial<PublicBookingProfile>) => {
    setDraft((d) => ({ ...d, ...p }));
    setMessage("");
  };
  async function save() {
    setBusy(true);
    setMessage("");
    try {
      await runCommand(
        "location.savePublicBookingProfile",
        publicBookingProfileSchema.parse(draft),
        membershipId!,
      );
      await queryClient.invalidateQueries({ queryKey: ["desk", "settings"] });
      setMessage("已保存 / Saved");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存失败 / Could not save");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded-2xl border bg-white p-5">
      <h2 className="text-lg font-bold">预约展示页 / Public booking page</h2>
      <label className="block">最多同行人数 / Maximum guests<input type="number" min={1} max={10} className="ml-3 rounded border p-2" value={draft.maxPartySize} onChange={e=>patch({maxPartySize:Number(e.target.value)})}/></label>
      <label className="block">
        店铺介绍 / About
        <textarea
          className="mt-2 w-full rounded-lg border p-3"
          maxLength={3000}
          value={draft.description}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </label>
      <label className="block">
        到店、停车说明 / Arrival instructions
        <textarea
          className="mt-2 w-full rounded-lg border p-3"
          maxLength={2000}
          value={draft.arrivalInstructions}
          onChange={(e) => patch({ arrivalInstructions: e.target.value })}
        />
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        <ImageUploader
          label="Logo"
          bucket="store_logos"
          value={draft.logoUrl}
          onChange={(logoUrl) => patch({ logoUrl })}
        />
        <BookingImagePicker label="封面 / Cover" value={draft.coverUrl} onChange={coverUrl=>patch({coverUrl})}/>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {[...draft.photoUrls, ...(draft.photoUrls.length < 8 ? [""] : [])].map(
          (url, i) => (
            <ImageUploader
              key={i}
              label={`照片 / Photo ${i + 1}`}
              bucket="store_logos"
              aspectRatio="wide"
              maxWidth={1200}
              maxHeight={900}
              value={url}
              onChange={(value) => {
                const photoUrls = [...draft.photoUrls];
                if (value) photoUrls[i] = value;
                else photoUrls.splice(i, 1);
                patch({ photoUrls });
              }}
            />
          ),
        )}
      </div>
      <fieldset className="space-y-2 rounded-xl border p-4">
        <legend>独立门店通知 / Shop notifications</legend>
        <p className="text-sm">
          顾客未填写 Email
          时仍通知门店。发送至门店资料中的邮箱/电话；原样邮件抄送单独保留。短信按现有渠道审批与计费规则执行。
        </p>
        {(["email", "sms"] as const).map((channel) => (
          <label key={channel} className="flex gap-2">
            <input
              type="checkbox"
              checked={draft.shopNotifications[channel]}
              onChange={(e) =>
                patch({
                  shopNotifications: {
                    ...draft.shopNotifications,
                    [channel]: e.target.checked,
                  },
                })
              }
            />
            {channel.toUpperCase()}
          </label>
        ))}
      </fieldset>
      <details>
        <summary className="cursor-pointer font-semibold">
          项目图片、详情与展示顺序 / Service presentation
        </summary>
        <div className="mt-4 space-y-4">
          {services
            .filter((s) => s.active)
            .map((s) => {
              const entry = draft.services[s.id] ?? {
                visible: s.onlineBookable,
                imageUrl: "",
                description: "",
                sort: 0,
                resourceTypeId: null as string | null,
              };
              const change = (p: Partial<typeof entry>) =>
                patch({
                  services: { ...draft.services, [s.id]: { ...entry, ...p } },
                });
              return (
                <div key={s.id} className="space-y-3 rounded-xl border p-4">
                  <h3 className="font-semibold">{s.displayName}</h3>
                  <label className="flex gap-2">
                    <input
                      type="checkbox"
                      checked={entry.visible ?? s.onlineBookable}
                      onChange={(e) => change({ visible: e.target.checked })}
                    />
                    公开展示 / Show publicly
                  </label>
                  <label className="block">
                    详情 / Details
                    <textarea
                      className="w-full rounded-lg border p-2"
                      maxLength={5000}
                      value={entry.description}
                      onChange={(e) => change({ description: e.target.value })}
                    />
                  </label>
                  <label className="block">
                    排序 / Order
                    <input
                      className="ml-3 rounded border p-2"
                      type="number"
                      min={0}
                      max={10000}
                      value={entry.sort}
                      onChange={(e) => change({ sort: Number(e.target.value) })}
                    />
                  </label>
                  <label className="block">
                    所需房间/座位类型 / Required resource
                    <select
                      className="ml-3 rounded border p-2"
                      value={entry.resourceTypeId ?? ""}
                      onChange={(e) =>
                        change({ resourceTypeId: e.target.value || null })
                      }
                    >
                      <option value="">无需预留 / None</option>
                      {resourceTypes.map((r) => (
                        <option key={r.id} value={r.id}>
                          {pickText(r.name, "en")}
                        </option>
                      ))}
                    </select>
                  </label>
                  <BookingImagePicker value={entry.imageUrl} serviceName={s.displayName} onChange={imageUrl=>change({imageUrl})}/>
                </div>
              );
            })}
        </div>
      </details>
      <p className="text-sm text-slate-500">
        在线可预约、分类与价格在项目设置中维护。仅公开展示但不可预约的项目会提示联系门店。
      </p>
      <button
        type="button"
        className="rounded-lg bg-teal-700 px-5 py-3 font-semibold text-white disabled:opacity-50"
        disabled={busy}
        onClick={() => void save()}
      >
        {busy ? "保存中 / Saving…" : "保存展示页 / Save page"}
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
