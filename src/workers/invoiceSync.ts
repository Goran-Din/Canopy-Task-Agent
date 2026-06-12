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
  Reference?: string;
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

// Fetch ALL AUTHORISED + PAID invoices, paging until a short page is returned.
// (Xero caps each page at 100; DRAFT/SUBMITTED are intentionally not fetched —
// they map to "not invoiced".)
async function fetchXeroInvoices(): Promise<XeroInvoice[]> {
  const token = await getAccessToken();
  const tenantId = await getConfigValue('xero_tenant_id');
  if (!tenantId) throw new Error('Xero tenant ID not configured.');

  const all: XeroInvoice[] = [];
  let page = 1;
  const MAX_PAGES = 100; // safety stop (~10k invoices)

  while (page <= MAX_PAGES) {
    const res = await axios.get(`${XERO_API_URL}/Invoices`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Xero-Tenant-Id': tenantId,
        Accept: 'application/json',
      },
      params: { Statuses: 'AUTHORISED,PAID', page },
      timeout: 30000,
    });
    const batch: XeroInvoice[] = res.data?.Invoices || [];
    all.push(...batch);
    if (batch.length < 100) break; // last page
    page++;
  }

  logger.info({ event: 'invoice_sync_xero_pages', pages: page, fetched: all.length });
  return all;
}

// Parse a Xero date (either "/Date(ms+0000)/" or ISO) to a yyyy-mm-dd string.
function parseXeroDate(raw?: string): string | null {
  if (!raw) return null;
  const epoch = raw.match(/\/Date\((\d+)/);
  if (epoch) return new Date(parseInt(epoch[1], 10)).toISOString().split('T')[0];
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString().split('T')[0];
}

// Epoch ms for sorting "most recent" invoice; 0 if unparseable.
function xeroDateMs(raw?: string): number {
  if (!raw) return 0;
  const epoch = raw.match(/\/Date\((\d+)/);
  if (epoch) return parseInt(epoch[1], 10);
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

interface InvoiceMatch {
  invoiceStatus: string;       // paid | invoiced | overdue | not_invoiced
  xeroInvoiceId: string | null;
  invoiceNumber: string | null;
  invoiceAmount: number | null;
  dueDate: string | null;
  paidDate: string | null;
}

const NO_MATCH: InvoiceMatch = {
  invoiceStatus: 'not_invoiced',
  xeroInvoiceId: null,
  invoiceNumber: null,
  invoiceAmount: null,
  dueDate: null,
  paidDate: null,
};

// Derive a single badge state from one or more matched invoices for a job.
// Outstanding wins: any AUTHORISED past due -> overdue; else any AUTHORISED -> invoiced
// (Sent); else (all PAID) -> paid. The representative invoice (for number/amount/dates)
// is the outstanding one when outstanding, else the most recent.
function computeMatch(invs: XeroInvoice[]): InvoiceMatch {
  if (!invs || invs.length === 0) return { ...NO_MATCH };

  const today = todayISO();
  const byNewest = (a: XeroInvoice, b: XeroInvoice) => xeroDateMs(b.Date) - xeroDateMs(a.Date);
  const authorised = invs.filter((i) => i.Status === 'AUTHORISED');

  let status: string;
  let rep: XeroInvoice;

  if (authorised.length > 0) {
    const overdue = authorised.filter((i) => {
      const d = parseXeroDate(i.DueDate);
      return d !== null && d < today;
    });
    if (overdue.length > 0) {
      status = 'overdue';
      rep = [...overdue].sort(byNewest)[0];
    } else {
      status = 'invoiced';
      rep = [...authorised].sort(byNewest)[0];
    }
  } else {
    status = 'paid';
    rep = [...invs].sort(byNewest)[0];
  }

  return {
    invoiceStatus: status,
    xeroInvoiceId: rep.InvoiceID,
    invoiceNumber: rep.InvoiceNumber,
    invoiceAmount: rep.Total,
    dueDate: parseXeroDate(rep.DueDate),
    paidDate: status === 'paid' ? parseXeroDate(rep.FullyPaidOnDate) : null,
  };
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

    // 2. Build lookup maps from the FULL invoice set:
    //    • invoiceMap   — normalizeName(Contact.Name) → most recent invoice  (landscape)
    //    • nameMap      — normalizeName(Contact.Name) → all invoices         (hardscape name fallback)
    //    • jobNumberMap — job # parsed from Reference via #(\d+) → all invoices (hardscape primary)
    const invoiceMap = new Map<string, XeroInvoice>();
    const nameMap = new Map<string, XeroInvoice[]>();
    const jobNumberMap = new Map<string, XeroInvoice[]>();

    for (const inv of xeroInvoices) {
      if (inv.Contact?.Name) {
        const key = normalizeName(inv.Contact.Name);
        const existing = invoiceMap.get(key);
        if (!existing || xeroDateMs(inv.Date) > xeroDateMs(existing.Date)) {
          invoiceMap.set(key, inv);
        }
        const list = nameMap.get(key);
        if (list) list.push(inv);
        else nameMap.set(key, [inv]);
      }
      const refMatch = (inv.Reference || '').match(/#(\d+)/);
      if (refMatch) {
        const jobNo = refMatch[1];
        const list = jobNumberMap.get(jobNo);
        if (list) list.push(inv);
        else jobNumberMap.set(jobNo, [inv]);
      }
    }

    logger.info({
      event: 'invoice_sync_xero_loaded',
      total_invoices: xeroInvoices.length,
      unique_contacts: nameMap.size,
      ref_job_numbers: jobNumberMap.size,
    });

    // 3. HARDSCAPE prospects FIRST (no SM8 calls — fast), so their badges refresh
    //    ahead of the slow landscape loop. Includes completed/lost (no stage filter).
    //    PRIMARY:  sm8_job_number ↔ #<digits> parsed from an invoice Reference.
    //    FALLBACK: client name, but only when it maps to exactly ONE invoice — never guess.
    // invoice_cache is keyed on sm8_job_uuid (shared by both divisions). Track the
    // hardscape job uuids so the landscape loop below never clobbers a hardscape
    // row with a name-only match.
    const hardscapeUuids = new Set<string>();
    let hsJobMatched = 0;
    let hsNameMatched = 0;
    let hsTotal = 0;
    try {
      const hardscapeResult = await pool.query(`
        SELECT sm8_job_uuid, sm8_job_number, sm8_client_name
        FROM hardscape_prospects
        WHERE sm8_job_uuid IS NOT NULL
      `);
      hsTotal = hardscapeResult.rows.length;

      for (const row of hardscapeResult.rows) {
        try {
          hardscapeUuids.add(row.sm8_job_uuid);
          let matched: XeroInvoice[] = [];
          let how: 'job_number' | 'client_name_single' | 'none' = 'none';

          // PRIMARY — job number parsed from a Reference
          const jobNo = row.sm8_job_number ? String(row.sm8_job_number).trim() : '';
          if (jobNo) {
            const byJob = jobNumberMap.get(jobNo);
            if (byJob && byJob.length > 0) {
              matched = byJob;
              how = 'job_number';
            }
          }

          // FALLBACK — single unambiguous client-name match
          if (matched.length === 0 && row.sm8_client_name) {
            const byName = nameMap.get(normalizeName(row.sm8_client_name));
            if (byName && byName.length === 1) {
              matched = byName;
              how = 'client_name_single';
            }
          }

          if (how === 'job_number') hsJobMatched++;
          else if (how === 'client_name_single') hsNameMatched++;

          const m = computeMatch(matched);

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
              m.xeroInvoiceId,
              m.invoiceNumber,
              m.invoiceAmount,
              m.invoiceStatus,
              m.dueDate,
              m.paidDate,
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
        prospects: hsTotal,
        matched_by_job_number: hsJobMatched,
        matched_by_client_name: hsNameMatched,
        unmatched: hsTotal - hsJobMatched - hsNameMatched,
      });
    } catch (err) {
      logger.error({
        event: 'invoice_sync_hardscape_error',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 4. Fetch SM8 jobs and filter (landscape)
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

    // 5. Landscape loop — resolve company names, client-name match vs the full set
    const companyCache: Record<string, string> = {};
    let matchedCount = 0;
    let unmatchedNames: string[] = [];

    for (const job of relevantJobs) {
      try {
        // Hardscape jobs are owned by the hardscape matcher above (job-number
        // primary). Skip them so the landscape name-match can't overwrite their
        // shared invoice_cache row.
        if (hardscapeUuids.has(job.uuid)) continue;

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

    // 6. Log summary
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
      hardscape_total: hsTotal,
      hardscape_matched_by_job_number: hsJobMatched,
      hardscape_matched_by_client_name: hsNameMatched,
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
