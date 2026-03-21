import axios from 'axios';
import cron from 'node-cron';
import { config } from '../config';
import { getAccessToken } from '../tools/xero';
import { getConfigValue } from '../db/queries';
import { pool } from '../db/pool';
import logger from '../logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XERO_API_URL = 'https://api.xero.com/api.xro/2.0';
const SM8_BASE = config.servicem8.baseUrl;
const SM8_HEADERS = {
  'X-API-Key': config.servicem8.apiKey,
  'Accept': 'application/json',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Xero types
// ---------------------------------------------------------------------------

interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber: string;
  Contact: { Name: string };
  Status: string;
  Total: number;
  AmountDue: number;
  DueDate: string;
  DateString?: string;
  Date: string;
  FullyPaidOnDate?: string;
}

// ---------------------------------------------------------------------------
// SM8 types
// ---------------------------------------------------------------------------

interface SM8Job {
  uuid: string;
  generated_job_id: string;
  company_uuid: string;
  status: string;
  active: number;
}

interface SM8Company {
  uuid: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchXeroInvoices(): Promise<XeroInvoice[]> {
  const token = await getAccessToken();
  const tenantId = await getConfigValue('xero_tenant_id');
  if (!tenantId) throw new Error('Xero tenant ID not configured.');

  const res = await axios.get(`${XERO_API_URL}/Invoices`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-Tenant-Id': tenantId,
      Accept: 'application/json',
    },
    params: { Statuses: 'AUTHORISED,PAID' },
    timeout: 30000,
  });

  return res.data?.Invoices || [];
}

async function fetchSM8Jobs(): Promise<SM8Job[]> {
  const res = await axios.get(`${SM8_BASE}/job.json`, {
    headers: SM8_HEADERS,
    timeout: 30000,
  });
  return res.data || [];
}

async function fetchSM8Company(companyUuid: string): Promise<SM8Company | null> {
  try {
    const res = await axios.get(`${SM8_BASE}/company.json`, {
      headers: SM8_HEADERS,
      params: { uuid: companyUuid },
      timeout: 10000,
    });
    return res.data?.[0] || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core sync
// ---------------------------------------------------------------------------

async function syncInvoices(): Promise<void> {
  try {
    logger.info({ event: 'invoice_sync_start' });

    // 1. Fetch Xero invoices
    let xeroInvoices: XeroInvoice[];
    try {
      xeroInvoices = await fetchXeroInvoices();
    } catch (err) {
      logger.error({
        event: 'invoice_sync_xero_error',
        error: err instanceof Error ? err.message : String(err),
      });
      return; // Keep existing cache
    }

    // 2. Build lookup map: normalizeName(Contact.Name) → most recent invoice
    const invoiceMap = new Map<string, XeroInvoice>();
    for (const inv of xeroInvoices) {
      if (!inv.Contact?.Name) continue;
      const key = normalizeName(inv.Contact.Name);
      const existing = invoiceMap.get(key);
      if (!existing || (inv.Date || '') > (existing.Date || '')) {
        invoiceMap.set(key, inv);
      }
    }

    logger.info({
      event: 'invoice_sync_xero_loaded',
      total_invoices: xeroInvoices.length,
      unique_contacts: invoiceMap.size,
    });

    // 3. Fetch SM8 jobs and filter
    let allJobs: SM8Job[];
    try {
      allJobs = await fetchSM8Jobs();
    } catch (err) {
      logger.error({
        event: 'invoice_sync_sm8_error',
        error: err instanceof Error ? err.message : String(err),
      });
      return; // Keep existing cache
    }

    const relevantJobs = allJobs.filter(
      (j) =>
        j.active === 1 &&
        (j.status === 'Work Order' || j.status === 'In Progress' || j.status === 'Completed')
    );

    logger.info({
      event: 'invoice_sync_sm8_loaded',
      total_jobs: allJobs.length,
      relevant_jobs: relevantJobs.length,
    });

    // 4. Resolve company names and match to Xero
    const companyCache: Record<string, string> = {};
    let matchedCount = 0;
    let unmatchedNames: string[] = [];

    for (const job of relevantJobs) {
      try {
        // Resolve client name
        if (!companyCache[job.company_uuid]) {
          const company = await fetchSM8Company(job.company_uuid);
          companyCache[job.company_uuid] = company?.name || '';
        }
        const clientName = companyCache[job.company_uuid];
        if (!clientName) continue;

        // Look up in Xero map
        const normalizedClient = normalizeName(clientName);
        const xeroInv = invoiceMap.get(normalizedClient);

        let invoiceStatus = 'not_invoiced';
        let xeroInvoiceId: string | null = null;
        let invoiceNumber: string | null = null;
        let invoiceAmount: number | null = null;
        let dueDate: string | null = null;
        let paidDate: string | null = null;

        if (xeroInv) {
          matchedCount++;
          xeroInvoiceId = xeroInv.InvoiceID;
          invoiceNumber = xeroInv.InvoiceNumber;
          invoiceAmount = xeroInv.Total;

          // Parse due date
          const dueDateStr = xeroInv.DueDate
            ? xeroInv.DueDate.replace(/\/Date\((\d+)\)\//, (_m, ms) =>
                new Date(parseInt(ms)).toISOString().split('T')[0]
              )
            : null;
          dueDate = dueDateStr;

          if (xeroInv.Status === 'PAID') {
            invoiceStatus = 'paid';
            // Parse paid date
            paidDate = xeroInv.FullyPaidOnDate
              ? xeroInv.FullyPaidOnDate.replace(/\/Date\((\d+)\)\//, (_m, ms) =>
                  new Date(parseInt(ms)).toISOString().split('T')[0]
                )
              : null;
          } else if (xeroInv.Status === 'AUTHORISED') {
            if (dueDateStr && dueDateStr < todayISO()) {
              invoiceStatus = 'overdue';
            } else {
              invoiceStatus = 'invoiced';
            }
          }
        } else {
          if (!unmatchedNames.includes(clientName)) {
            unmatchedNames.push(clientName);
          }
        }

        // 5. Upsert into invoice_cache
        await pool.query(
          `INSERT INTO invoice_cache
            (sm8_job_uuid, sm8_client_name, division, xero_invoice_id,
             invoice_number, invoice_amount, invoice_status, due_date, paid_date, last_synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
           ON CONFLICT (sm8_job_uuid) DO UPDATE SET
             sm8_client_name = EXCLUDED.sm8_client_name,
             division = EXCLUDED.division,
             xero_invoice_id = EXCLUDED.xero_invoice_id,
             invoice_number = EXCLUDED.invoice_number,
             invoice_amount = EXCLUDED.invoice_amount,
             invoice_status = EXCLUDED.invoice_status,
             due_date = EXCLUDED.due_date,
             paid_date = EXCLUDED.paid_date,
             last_synced_at = NOW()`,
          [
            job.uuid,
            clientName,
            'landscape_project',
            xeroInvoiceId,
            invoiceNumber,
            invoiceAmount,
            invoiceStatus,
            dueDate,
            paidDate,
          ]
        );
      } catch (err) {
        logger.warn({
          event: 'invoice_sync_job_error',
          job_uuid: job.uuid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 6. Sync hardscape prospects
    let hardscapeMatched = 0;
    try {
      const hardscapeResult = await pool.query(`
        SELECT sm8_job_uuid, sm8_client_name
        FROM hardscape_prospects
        WHERE stage NOT IN ('completed', 'closed_lost')
        AND sm8_job_uuid IS NOT NULL
      `);

      for (const row of hardscapeResult.rows) {
        try {
          const normalizedClient = normalizeName(row.sm8_client_name);
          const xeroInv = invoiceMap.get(normalizedClient);

          let invoiceStatus = 'not_invoiced';
          let xeroInvoiceId: string | null = null;
          let invoiceNumber: string | null = null;
          let invoiceAmount: number | null = null;
          let dueDate: string | null = null;
          let paidDate: string | null = null;

          if (xeroInv) {
            hardscapeMatched++;
            xeroInvoiceId = xeroInv.InvoiceID;
            invoiceNumber = xeroInv.InvoiceNumber;
            invoiceAmount = xeroInv.Total;

            const dueDateStr = xeroInv.DueDate
              ? xeroInv.DueDate.replace(/\/Date\((\d+)\)\//, (_m, ms) =>
                  new Date(parseInt(ms)).toISOString().split('T')[0]
                )
              : null;
            dueDate = dueDateStr;

            if (xeroInv.Status === 'PAID') {
              invoiceStatus = 'paid';
              paidDate = xeroInv.FullyPaidOnDate
                ? xeroInv.FullyPaidOnDate.replace(/\/Date\((\d+)\)\//, (_m, ms) =>
                    new Date(parseInt(ms)).toISOString().split('T')[0]
                  )
                : null;
            } else if (xeroInv.Status === 'AUTHORISED') {
              if (dueDateStr && dueDateStr < todayISO()) {
                invoiceStatus = 'overdue';
              } else {
                invoiceStatus = 'invoiced';
              }
            }
          }

          await pool.query(
            `INSERT INTO invoice_cache
              (sm8_job_uuid, sm8_client_name, division, xero_invoice_id,
               invoice_number, invoice_amount, invoice_status, due_date, paid_date, last_synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
             ON CONFLICT (sm8_job_uuid) DO UPDATE SET
               sm8_client_name = EXCLUDED.sm8_client_name,
               division = EXCLUDED.division,
               xero_invoice_id = EXCLUDED.xero_invoice_id,
               invoice_number = EXCLUDED.invoice_number,
               invoice_amount = EXCLUDED.invoice_amount,
               invoice_status = EXCLUDED.invoice_status,
               due_date = EXCLUDED.due_date,
               paid_date = EXCLUDED.paid_date,
               last_synced_at = NOW()`,
            [
              row.sm8_job_uuid,
              row.sm8_client_name,
              'hardscape',
              xeroInvoiceId,
              invoiceNumber,
              invoiceAmount,
              invoiceStatus,
              dueDate,
              paidDate,
            ]
          );
        } catch (err) {
          logger.warn({
            event: 'invoice_sync_hardscape_job_error',
            job_uuid: row.sm8_job_uuid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info({
        event: 'invoice_sync_hardscape_loaded',
        prospects: hardscapeResult.rows.length,
        xero_matched: hardscapeMatched,
      });
    } catch (err) {
      logger.error({
        event: 'invoice_sync_hardscape_error',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 7. Log summary
    if (unmatchedNames.length > 0) {
      logger.info({
        event: 'invoice_sync_unmatched_clients',
        count: unmatchedNames.length,
        names: unmatchedNames.slice(0, 20),
      });
    }

    logger.info({
      event: 'invoice_sync_complete',
      landscape_synced: relevantJobs.length,
      landscape_matched: matchedCount,
      hardscape_matched: hardscapeMatched,
      unmatched: unmatchedNames.length,
    });
  } catch (err) {
    logger.error({
      event: 'invoice_sync_error',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export async function runInvoiceSyncNow(): Promise<void> {
  await syncInvoices();
}

export function startInvoiceSync(): void {
  logger.info({ event: 'invoice_sync_init' });

  // Run immediately on startup
  syncInvoices();

  // Every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    syncInvoices();
  }, { timezone: 'America/Chicago' });

  logger.info({ event: 'invoice_sync_scheduled', interval: '15min' });
}
