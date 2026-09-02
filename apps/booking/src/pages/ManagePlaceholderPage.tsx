import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Card, Shell } from '../components/Chrome';

/** Route exists so SPA refresh of /l/:slug/g/:token works. Task 7 owns the real page. */
export function ManagePlaceholderPage() {
  const { slug } = useParams();
  useEffect(() => {
    document.title = 'Appointment';
    let tag = document.querySelector('meta[name="referrer"]');
    if (!tag) {
      tag = document.createElement('meta');
      tag.setAttribute('name', 'referrer');
      document.head.appendChild(tag);
    }
    tag.setAttribute('content', 'no-referrer');
  }, []);
  return (
    <Shell>
      <Card>
        <h1 className="text-xl font-bold">This appointment link is not available yet</h1>
        <p className="mt-3 text-[var(--muted)]">
          If you have a confirmation from {slug ?? 'the shop'}, please call them to view,
          reschedule, or cancel.
        </p>
      </Card>
    </Shell>
  );
}
