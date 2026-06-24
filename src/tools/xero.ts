import axios from 'axios';
import { config } from '../config';
import { getConfigValue, setConfigValue } from '../db/queries';
import { XeroQueryInput } from '../types';
import { getJobByNumber, getClientJobsForBilling } from './servicem8';

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_API_URL = 'https://api.xero.com/api.xro/2.0';

export async function getAccessToken(): Promise<string> {
  const stored = await getConfigValue('xero_access_token');
  const expiry = await getConfigValue('xero_token_expiry');

  if (stored && expiry && new Date(expiry) > new Date(Date.now() + 60000)) {
    return stored;
  }

  const refreshToken = await getConfigValue('xero_refresh_token');
  if (!refreshToken) {
    throw new Error('Xero refresh token not configured. Run the Xero OAuth setup first (CA-XERO-SETUP).');
  }

  const credentials = Buffer.from(`${config.xero.clientId}:${config.xero.clientSecret}`).toString('base64');

  const response = await axios.post(
    XERO_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  const { access_token, refresh_token, expires_in } = response.data;
  const expiryDate = new Date(Date.now() + expires_in * 1000);

  await setConfigValue('xero_access_token', access_token, expiryDate);
  await setConfigValue('xero_refresh_token', refresh_token);

  return access_token;
}

/** Update a Xero contact's AccountNumber field */
export async function updateXeroAccountNumber(contactId: string, accountNumber: string): Promise<boolean> {
  try {
    const tenantId = await getConfigValue('xero_tenant_id');
    if (!tenantId) throw new Error('Xero tenant ID not configured.');

    const token = await getAccessToken();

    await axios.post(
      `${XERO_API_URL}/Contacts`,
      { Contacts: [{ ContactID: contactId, AccountNumber: accountNumber }] },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Xero-Tenant-Id': tenantId,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    return true;
  } catch {
    return false;
  }
}

async function xeroGet(path: string, params?: Record<string, string | number>): Promise<any> {
  const tenantId = await getConfigValue('xero_tenant_id');
  if (!tenantId) throw new Error('Xero tenant ID not configured.');

  const token = await getAccessToken();

  const response = await axios.get(`${XERO_API_URL}/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-Tenant-Id': tenantId,
      Accept: 'application/json',
    },
    params,
    timeout: 15000,
  });

  return response.data;
}

interface XeroInvoice {
  InvoiceNumber: string;
  Contact?: { Name: string; ContactID?: string };
  Status: string;
  Total: number;
  AmountDue: number;
  Reference?: string;
  DueDateString?: string;
  DateString?: string;
}

interface XeroContactLite {
  ContactID: string;
  Name: string;
  ContactStatus?: string;
}

function formatInvoice(inv: XeroInvoice): string {
  const status = inv.Status === 'PAID' ? '✅ Paid' : inv.Status === 'VOIDED' ? '🚫 Voided' : '⏳ Unpaid';
  const due = inv.DueDateString ? ` · Due ${inv.DueDateString}` : '';
  const ref = inv.Reference ? ` · Ref "${inv.Reference}"` : '';
  return `${inv.InvoiceNumber} · ${inv.Contact?.Name || 'Unknown'} · $${inv.Total.toFixed(2)} · ${status} (due $${inv.AmountDue.toFixed(2)})${ref}${due}`;
}

// ---------------------------------------------------------------------------
// Correct Xero retrieval helpers (the bare ContactName param is IGNORED by Xero,
// and results are paged 100/req — these resolve the contact and page fully).
// ---------------------------------------------------------------------------

const UNPAID_STATUSES = 'AUTHORISED,SENT';

/** Page through every invoice matching the given params (page size is 100). */
async function getInvoicesPaged(params: Record<string, string | number>): Promise<XeroInvoice[]> {
  const all: XeroInvoice[] = [];
  let page = 1;
  // Hard cap to avoid runaway loops; 100 pages = 10k invoices.
  while (page <= 100) {
    const data = await xeroGet('Invoices', { ...params, page });
    const batch: XeroInvoice[] = data.Invoices || [];
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

/**
 * Resolve a Xero contact by name. Uses a Contains search (Xero contact names
 * differ from SM8 names) then disambiguates IN CODE: prefer an exact
 * case-insensitive match; otherwise a single candidate; otherwise 'ambiguous'.
 * Never guesses among several distinct contacts.
 */
export async function resolveXeroContact(name: string): Promise<{
  status: 'ok' | 'none' | 'ambiguous';
  contact?: XeroContactLite;
  candidates?: string[];
}> {
  const term = name.trim().toLowerCase().replace(/"/g, '');
  if (!term) return { status: 'none' };

  const data = await xeroGet('Contacts', { where: `Name.ToLower().Contains("${term}")` });
  const contacts: XeroContactLite[] = (data.Contacts || []).filter(
    (c: XeroContactLite) => c.ContactStatus !== 'ARCHIVED'
  );
  if (contacts.length === 0) return { status: 'none' };
  if (contacts.length === 1) return { status: 'ok', contact: contacts[0] };

  const exact = contacts.filter((c) => c.Name.toLowerCase() === name.trim().toLowerCase());
  if (exact.length === 1) return { status: 'ok', contact: exact[0] };

  return { status: 'ambiguous', candidates: contacts.slice(0, 8).map((c) => c.Name) };
}

/** All invoices for a resolved contact, fully paged. */
async function getInvoicesForContact(contactId: string): Promise<XeroInvoice[]> {
  return getInvoicesPaged({ ContactIDs: contactId });
}

/**
 * Word-boundary-safe test that an invoice Reference points at a given job
 * number. Matches "#400", "Job #400", "job 400", "for job#400" but NOT "#4000"
 * or "#40" when looking for 400 (no adjacent digit). Leading zeros tolerated.
 */
export function referenceMatchesJob(reference: string | undefined, jobNumber: string): boolean {
  if (!reference || !jobNumber) return false;
  const n = String(jobNumber).trim().replace(/^0+/, '');
  if (!n) return false;
  const re = new RegExp(`(?:#|job\\s*#?\\s*)0*${n}(?!\\d)`, 'i');
  return re.test(reference);
}

// ---------------------------------------------------------------------------
// Deposit invoice creation
// ---------------------------------------------------------------------------

export async function createDepositInvoice(params: {
  xeroContactId: string;
  contactName: string;
  jobNumber: string;
  sm8JobUuid?: string;
  lineItems: Array<{ description: string; unitAmount: number }>;
  depositAmount: number;
  depositPercent: number;
  totalProjectAmount: number;
  paymentTerms: string;
  projectType: 'hardscape' | 'landscape';
  dueDate?: string;
}): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const tenantId = await getConfigValue('xero_tenant_id');
  if (!tenantId) throw new Error('Xero tenant ID not configured.');
  const token = await getAccessToken();

  const accountCode = params.projectType === 'hardscape' ? '4230' : '4220';

  // Build line items: original items as zero-quantity context lines + deposit line
  const xeroLineItems = [
    ...params.lineItems.map((li) => ({
      Description: li.description,
      UnitAmount: li.unitAmount,
      Quantity: 0,
      AccountCode: accountCode,
    })),
    {
      Description: `Project Deposit \u2013 ${params.depositPercent}% (Project Quote Job#${params.jobNumber} Total Amount $${params.totalProjectAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
      UnitAmount: params.depositAmount,
      Quantity: 1,
      AccountCode: accountCode,
    },
  ];

  // Default due date: 7 days from now
  const dueMs = params.dueDate
    ? new Date(params.dueDate).getTime()
    : Date.now() + 7 * 86400000;
  const dueDateXero = `/Date(${dueMs})/`;

  const remaining = params.totalProjectAmount - params.depositAmount;
  const fmtTotal = params.totalProjectAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDeposit = params.depositAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtRemaining = remaining.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const invoiceNotes = `Total Project Value: $${fmtTotal}\n\nPayment Terms: ${params.paymentTerms}\n\nThis invoice covers the ${params.depositPercent}% deposit ($${fmtDeposit}).\nRemaining balance due on completion: $${fmtRemaining}`;

  const body = {
    Invoices: [{
      Type: 'ACCREC',
      Contact: { ContactID: params.xeroContactId },
      Status: 'DRAFT',
      Reference: `Job #${params.jobNumber} \u2014 Deposit ${params.depositPercent}%`,
      Narration: invoiceNotes,
      LineAmountTypes: 'Exclusive',
      DueDate: dueDateXero,
      LineItems: xeroLineItems,
      ...(params.sm8JobUuid ? { Url: `https://go.servicem8.com/#job,${params.sm8JobUuid}` } : {}),
    }],
  };

  const response = await axios.post(`${XERO_API_URL}/Invoices`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  const created = response.data?.Invoices?.[0];
  if (!created?.InvoiceID) throw new Error('Xero did not return an invoice ID.');

  return {
    invoiceId: created.InvoiceID,
    invoiceNumber: created.InvoiceNumber || 'DRAFT',
  };
}

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function queryXeroInvoices(input: XeroQueryInput): Promise<{ result: string }> {
  switch (input.query_type) {
    case 'invoice_status': {
      if (input.invoice_number) {
        const data = await xeroGet('Invoices', { InvoiceNumbers: input.invoice_number });
        const invoices: XeroInvoice[] = data.Invoices || [];
        if (invoices.length === 0) return { result: `No invoice found for ${input.invoice_number}.` };
        return { result: invoices.map(formatInvoice).join('\n') };
      }
      if (input.client_name) {
        const resolved = await resolveXeroContact(input.client_name);
        if (resolved.status === 'none') {
          return { result: `I can't find a Xero contact named "${input.client_name}". Check the spelling or create the contact first.` };
        }
        if (resolved.status === 'ambiguous') {
          return { result: `Multiple Xero contacts match "${input.client_name}":\n${resolved.candidates!.map((n) => `• ${n}`).join('\n')}\nWhich one?` };
        }
        const invoices = await getInvoicesForContact(resolved.contact!.ContactID);
        if (invoices.length === 0) return { result: `No invoices on file for ${resolved.contact!.Name}.` };
        const unpaid = invoices.filter((i) => i.Status === 'AUTHORISED' || i.Status === 'SENT');
        const due = unpaid.reduce((s, i) => s + i.AmountDue, 0);
        const lines = invoices
          .sort((a, b) => (b.DateString || '').localeCompare(a.DateString || ''))
          .slice(0, 30)
          .map(formatInvoice);
        const more = invoices.length > 30 ? `\n…and ${invoices.length - 30} more` : '';
        return {
          result: `${resolved.contact!.Name} — ${invoices.length} invoice(s), ${unpaid.length} unpaid totalling $${fmt(due)}:\n${lines.join('\n')}${more}`,
        };
      }
      return { result: 'Please provide a client name or invoice number.' };
    }

    case 'job_billing': {
      const jobNumber = (input.job_number || '').trim();
      if (!jobNumber) return { result: 'Please provide a job number.' };

      const job = await getJobByNumber(jobNumber);
      if (!job) return { result: `I can't find job #${jobNumber} in ServiceM8.` };

      const resolved = await resolveXeroContact(job.clientName);
      if (resolved.status === 'ambiguous') {
        return { result: `Job #${job.jobNumber} is for ${job.clientName}, but multiple Xero contacts match that name:\n${resolved.candidates!.map((n) => `• ${n}`).join('\n')}\nWhich one?` };
      }
      if (resolved.status === 'none') {
        return { result: `Job #${job.jobNumber} (${job.clientName}) has not been invoiced yet — no Xero contact on file for this client.` };
      }

      const invoices = await getInvoicesForContact(resolved.contact!.ContactID);
      const matched = invoices.filter((i) => referenceMatchesJob(i.Reference, job.jobNumber));
      if (matched.length === 0) {
        return { result: `Job #${job.jobNumber} (${job.clientName}) has not been invoiced yet. No Xero invoice references this job number.` };
      }

      const invoicedTotal = matched.reduce((s, i) => s + i.Total, 0);
      const dueTotal = matched.reduce((s, i) => s + i.AmountDue, 0);
      const deposits = matched.filter((i) => /deposit/i.test(i.Reference || ''));
      const depositPaid = deposits.length > 0 && deposits.every((i) => i.Status === 'PAID' || i.AmountDue === 0);
      const depositLine = deposits.length > 0
        ? `\nDeposit invoice: ${depositPaid ? '✅ paid' : '⏳ NOT paid'} (${deposits.map((d) => d.InvoiceNumber).join(', ')})`
        : '\nNo deposit invoice found referencing this job.';

      return {
        result: `Job #${job.jobNumber} — ${job.clientName}\n` +
          `Quoted total (SM8): $${fmt(job.total)}\n` +
          `Invoiced in Xero: $${fmt(invoicedTotal)} across ${matched.length} invoice(s); outstanding $${fmt(dueTotal)}.${depositLine}\n` +
          matched.map(formatInvoice).join('\n'),
      };
    }

    case 'outstanding': {
      const invoices = await getInvoicesPaged({ Statuses: UNPAID_STATUSES });
      if (invoices.length === 0) return { result: 'No outstanding invoices.' };
      const total = invoices.reduce((sum, inv) => sum + inv.AmountDue, 0);
      return {
        result: `Outstanding invoices (${invoices.length}) · Total due: $${fmt(total)}\n` +
          invoices.slice(0, 30).map(formatInvoice).join('\n') +
          (invoices.length > 30 ? `\n…and ${invoices.length - 30} more` : ''),
      };
    }

    case 'client_balance': {
      if (!input.client_name) return { result: 'Client name is required for balance query.' };

      // (a) Unpaid on invoices — needs the Xero contact.
      const resolved = await resolveXeroContact(input.client_name);
      if (resolved.status === 'ambiguous') {
        return { result: `Multiple Xero contacts match "${input.client_name}":\n${resolved.candidates!.map((n) => `• ${n}`).join('\n')}\nWhich one?` };
      }

      let contactInvoices: XeroInvoice[] = [];
      let unpaidOnInvoices = 0;
      if (resolved.status === 'ok') {
        contactInvoices = await getInvoicesForContact(resolved.contact!.ContactID);
        unpaidOnInvoices = contactInvoices
          .filter((i) => i.Status === 'AUTHORISED' || i.Status === 'SENT')
          .reduce((s, i) => s + i.AmountDue, 0);
      }

      // (b) Completed/quoted work not yet invoiced — from SM8 job totals minus what
      //     has been invoiced for each job (matched by job # in the invoice Reference).
      const sm8 = await getClientJobsForBilling(input.client_name);
      if (resolved.status === 'none' && sm8.status === 'none') {
        return { result: `I can't find a client named "${input.client_name}" in Xero or ServiceM8.` };
      }
      if (sm8.status === 'ambiguous') {
        return { result: `Multiple ServiceM8 clients match "${input.client_name}":\n${sm8.candidates!.map((n) => `• ${n}`).join('\n')}\nWhich one?` };
      }

      const jobBreakdown: string[] = [];
      let completedUninvoiced = 0;
      if (sm8.status === 'ok') {
        for (const job of sm8.jobs) {
          const invoicedForJob = contactInvoices
            .filter((i) => referenceMatchesJob(i.Reference, job.jobNumber))
            .reduce((s, i) => s + i.Total, 0);
          const gap = Math.max(0, job.total - invoicedForJob);
          if (gap > 0) {
            completedUninvoiced += gap;
            jobBreakdown.push(`  • Job #${job.jobNumber} (${job.status}): $${fmt(gap)} not invoiced` + (invoicedForJob > 0 ? ` (of $${fmt(job.total)}, $${fmt(invoicedForJob)} invoiced)` : ` ($${fmt(job.total)})`));
          }
        }
      }

      const who = resolved.status === 'ok' ? resolved.contact!.Name : sm8.companyName || input.client_name;
      const aNote = resolved.status === 'ok' ? '' : ' (no Xero contact on file)';
      const lines: string[] = [
        `${who} owes — two separate figures:`,
        `1) Unpaid on sent invoices (collectable now): $${fmt(unpaidOnInvoices)}${aNote}`,
        `2) Completed/quoted work not yet invoiced (billing gap): $${fmt(completedUninvoiced)}`,
      ];
      if (jobBreakdown.length) lines.push(...jobBreakdown);
      if (resolved.status === 'ok' && contactInvoices.some((i) => i.Status === 'AUTHORISED' || i.Status === 'SENT')) {
        lines.push('Unpaid invoices:');
        lines.push(
          ...contactInvoices
            .filter((i) => i.Status === 'AUTHORISED' || i.Status === 'SENT')
            .slice(0, 20)
            .map((i) => '  ' + formatInvoice(i))
        );
      }
      return { result: lines.join('\n') };
    }

    case 'overdue': {
      const today = new Date().toISOString().split('T')[0];
      const invoices = await getInvoicesPaged({ Statuses: UNPAID_STATUSES });
      const overdue = invoices.filter((inv) => inv.DueDateString && inv.DueDateString < today);
      if (overdue.length === 0) return { result: 'No overdue invoices.' };
      const total = overdue.reduce((sum, inv) => sum + inv.AmountDue, 0);
      return {
        result: `Overdue invoices (${overdue.length}) · Total due: $${fmt(total)}\n` +
          overdue.slice(0, 30).map(formatInvoice).join('\n') +
          (overdue.length > 30 ? `\n…and ${overdue.length - 30} more` : ''),
      };
    }

    default:
      return { result: 'Unknown query type.' };
  }
}
