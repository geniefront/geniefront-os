import { useState } from "react";
/** Keep mixed catalogs aligned, including missing or broken remote images. */
export function ServiceImage({
  src,
  className = "",
}: {
  src?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={`service-image ${className}`} aria-hidden="true">
      {src && failed !== src ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} />
      ) : (
        <svg viewBox="0 0 32 32" fill="none">
          <path d="M16 25C8 25 5 19 6 12c5 0 9 3 10 8 1-5 5-8 10-8 1 7-2 13-10 13Z" />
          <path d="M16 20c-4-4-4-9 0-14 4 5 4 10 0 14Z" />
        </svg>
      )}
    </span>
  );
}
