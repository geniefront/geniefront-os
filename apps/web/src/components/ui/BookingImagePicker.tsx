import { useState } from "react";
import {
  BOOKING_MEDIA,
  bookingMediaUrl,
  defaultBookingMedia,
} from "@gf/contracts";
import { ImageUploader } from "./ImageUploader";
import { useLanguage } from "@/LanguageContext";
export function BookingImagePicker({
  value,
  onChange,
  serviceName = "",
  label,
}: {
  value: string;
  onChange: (url: string) => void;
  serviceName?: string;
  label?: string;
}) {
  const { language, t } = useLanguage(),
    zh = language.startsWith("zh");
  const [category, setCategory] = useState("all");
  return (
    <div className="space-y-3">
      <ImageUploader
        label={label ?? (t('settings.mediaServicePhoto'))}
        bucket="store_logos"
        aspectRatio="wide"
        maxWidth={1200}
        maxHeight={900}
        value={value || defaultBookingMedia(serviceName)}
        onChange={onChange}
      />
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          {t('settings.mediaChooseImage')}
        </summary>
        <div className="my-3 flex flex-wrap gap-2">
          <select
            aria-label={t('settings.mediaImageCategory')}
            className="rounded-lg border p-2 text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="all">{t('settings.mediaAllImageCategories')}</option>
            {BOOKING_MEDIA.map((m) => (
              <option key={m.id} value={m.id}>
                {zh ? m.zh : m.en}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-lg border px-3 text-sm"
            onClick={() => onChange("")}
          >
            {t('settings.mediaAutomaticImage')}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {BOOKING_MEDIA.filter(
            (m) => category === "all" || category === m.id,
          ).map((m) => (
            <button
              type="button"
              key={m.id}
              aria-pressed={value === bookingMediaUrl(m.id)}
              className={`overflow-hidden rounded-xl border text-left ${value === bookingMediaUrl(m.id) ? "ring-2 ring-slate-800" : "border-slate-200"}`}
              onClick={() => onChange(bookingMediaUrl(m.id))}
            >
              <img
                className="aspect-square w-full object-cover"
                src={bookingMediaUrl(m.id)}
                alt=""
                loading="lazy"
              />
              <span className="block p-2 text-xs">{zh ? m.zh : m.en}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {t('settings.mediaImageLibraryNote')}
        </p>
      </details>
    </div>
  );
}
