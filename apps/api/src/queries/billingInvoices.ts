/**
 * 订阅发票与税务资料查询（/subscription）
 */

import type postgres from 'postgres';
import type { CommandContext } from '@gf/contracts';

export interface BillingInvoiceItem {
  id: string;
  invoiceNumber: string;
  period: string;
  description: string;
  amountCents: number;
  status: 'paid' | 'pending' | 'failed';
  date: string;
  receiptPdfUrl?: string | null | undefined;
}

export async function loadBillingInvoices(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<{ invoices: BillingInvoiceItem[] }> {
  const rows = await tx<{
    id: string;
    invoice_number: string;
    period: string;
    description: string;
    amount_cents: number;
    status: string;
    date: string;
    receipt_pdf_url: string | null;
  }[]>`
    select id, invoice_number, period, description, amount_cents,
           status, date, receipt_pdf_url
    from billing_invoices
    where org_id = ${ctx.orgId}
    order by created_at desc
    limit 50`;

  return {
    invoices: rows.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoice_number,
      period: r.period,
      description: r.description,
      amountCents: r.amount_cents,
      status: (r.status as 'paid' | 'pending' | 'failed') ?? 'paid',
      date: r.date,
      receiptPdfUrl: r.receipt_pdf_url ?? null,
    })),
  };
}

export interface TaxProfile {
  legalEntityName: string;
  taxId: string;
  billingEmail: string;
}

export async function loadTaxProfile(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<{ taxProfile: TaxProfile | null }> {
  const [acc] = await tx<{ tax_profile: TaxProfile | null }[]>`
    select tax_profile from billing_accounts
    where location_id = ${ctx.locationId} limit 1`;

  return { taxProfile: acc?.tax_profile ?? null };
}
