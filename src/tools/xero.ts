import axios from 'axios';
import { config } from '../config';
import { getConfigValue, setConfigValue } from '../db/queries';
import { XeroQueryInput } from '../types';

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

async function xeroGet(path: string, params?: Record<string, string>): Promise<{ Invoices?: XeroInvoice[] }> {
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
    timeout: 10000,
  });

  return response.data;
}

interface XeroInvoice {
  InvoiceNumber: string;
  Contact?: { Name: string };
  Status: string;
  Total: number;
  AmountDue: number;
  DueDateString?: string;
  DateString?: string;
}

function formatInvoice(inv: XeroInvoice): string {
  const status = inv.Status === 'PAID' ? '✅ Paid' : inv.Status === 'VOIDED' ? '🚫 Voided' : '⏳ Unpaid';
  const due = inv.DueDateString ? ` · Due ${inv.DueDateString}` : '';
  return `${inv.InvoiceNumber} · ${inv.Contact?.Name || 'Unknown'} · ${inv.Total.toFixed(2)} · ${status}${due}`;
}

export async function queryXeroInvoices(input: XeroQueryInput): Promise<{ result: string }> {
  switch (input.query_type) {
    case 'invoice_status': {
      if (input.invoice_number) {
        const data = await xeroGet('Invoices', { InvoiceNumbers: input.invoice_number });
        const invoices = data.Invoices || [];
        if (invoices.length === 0) return { result: `No invoice found for ${input.invoice_number}.` };
        return { result: invoices.map(formatInvoice).join('\n') };
      }
      if (input.client_name) {
        const data = await xeroGet('Invoices', {
          ContactName: input.client_name,
          Statuses: 'AUTHORISED,SENT,PAID',
        });
        const invoices = (data.Invoices || []).slice(0, 5);
        if (invoices.length === 0) return { result: `No invoices found for "${input.client_name}".` };
        return { result: `${input.client_name} invoices:\n` + invoices.map(formatInvoice).join('\n') };
      }
      return { result: 'Please provide a client name or invoice number.' };
    }

    case 'outstanding': {
      const data = await xeroGet('Invoices', { Statuses: 'AUTHORISED,SENT' });
      const invoices = data.Invoices || [];
      if (invoices.length === 0) return { result: 'No outstanding invoices.' };
      const total = invoices.reduce((sum: number, inv: XeroInvoice) => sum + inv.AmountDue, 0);
      return {
        result: `Outstanding invoices (${invoices.length}) · Total: ${total.toFixed(2)}\n` +
          invoices.map(formatInvoice).join('\n'),
      };
    }

    case 'client_balance': {
      if (!input.client_name) return { result: 'Client name is required for balance query.' };
      const data = await xeroGet('Invoices', {
        ContactName: input.client_name,
        Statuses: 'AUTHORISED,SENT',
      });
      const invoices = data.Invoices || [];
      if (invoices.length === 0) return { result: `No outstanding balance for "${input.client_name}".` };
      const total = invoices.reduce((sum: number, inv: XeroInvoice) => sum + inv.AmountDue, 0);
      return {
        result: `${input.client_name} · Outstanding balance: ${total.toFixed(2)}\n` +
          invoices.map(formatInvoice).join('\n'),
      };
    }

    case 'overdue': {
      const today = new Date().toISOString().split('T')[0];
      const data = await xeroGet('Invoices', { Statuses: 'AUTHORISED,SENT' });
      const overdue = (data.Invoices || []).filter(
        (inv: XeroInvoice) => inv.DueDateString && inv.DueDateString < today
      );
      if (overdue.length === 0) return { result: 'No overdue invoices.' };
      const total = overdue.reduce((sum: number, inv: XeroInvoice) => sum + inv.AmountDue, 0);
      return {
        result: `Overdue invoices (${overdue.length}) · Total: ${total.toFixed(2)}\n` +
          overdue.map(formatInvoice).join('\n'),
      };
    }

    default:
      return { result: 'Unknown query type.' };
  }
}
