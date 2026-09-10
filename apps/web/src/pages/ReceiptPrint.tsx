import { useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ReceiptDocument, type ReceiptData } from '@/features/printing/ReceiptDocument';
import { openPrintPreview } from '@/features/printing/preview';

export function ReceiptPrint() {
  const { ticketId } = useParams();
  const { membershipId, status } = useSession();
  const navigate = useNavigate();
  const documentRef = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ['desk', 'receipt', membershipId, ticketId],
    queryFn: () => apiGet<ReceiptData>(`/v1/desk/tickets/${ticketId}/receipt`),
    enabled: status === 'ready' && Boolean(membershipId && ticketId),
    refetchOnWindowFocus: false,
  });
  return <main className="min-h-dvh bg-slate-100 p-4">
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap gap-3 mb-4 print:hidden">
        <button className="rounded-lg border bg-white px-4 py-3" onClick={() => navigate('/checkout')}>Back to checkout</button>
        <button className="rounded-lg bg-teal-700 px-4 py-3 text-white disabled:opacity-50" disabled={!query.data || query.isFetching} onClick={() => openPrintPreview(documentRef.current, `Receipt ${ticketId}`, 'thermal')}>Print / Save PDF</button>
      </div>
      {query.isLoading && <p>Loading receipt…</p>}
      {query.isError && <div role="alert"><p>Receipt could not be loaded. Payment has not been retried.</p><button onClick={() => void query.refetch()}>Retry receipt</button></div>}
      {query.data && <div ref={documentRef} className="rounded-lg bg-white p-6"><ReceiptDocument data={query.data}/></div>}
    </div>
  </main>;
}
