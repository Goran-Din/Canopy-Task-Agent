import axios from 'axios';
import cron from 'node-cron';
import { config } from '../config';
import { getAccessToken } from '../tools/xero';
import { getConfigValue, setConfigValue } from '../db/queries';
import { pool } from '../db/pool';
import logger from '../logger';

// ---------------------------------------------------------------------------
// On-demand sync state (the "Sync from Xero" button) — see runInvoiceSyncNow.
// ---------------------------------------------------------------------------

// Structured result so callers (the dashboard endpoint) can show a friendly
// message instead of a raw error, especially for the Xero daily-limit case.
export interface InvoiceSyncResult {
  status: 'ok' | 'day_limited' | 'already_running' | 'cooldown' | 'error';
  invoicesFetched?: number;        // total Xero invoices paged in
  prospectInvoicesUpserted?: number; // rows written to prospect_invoices
  hardscapeMatchedByJobNumber?: number;
  hardscapeMatchedByClientName?: number;
  hardscapeUnmatched?: number;
  retryAfterSeconds?: number;      // day_limited / cooldown: when to try again
  ranAt?: string;                  // ISO timestamp of completion
  message?: string;
}

// Thrown by fetchXeroPage when Xero reports the *daily* quota is exhausted, so
// syncInvoices can surface a structured day_limited result rather than erroring.
class XeroDayLimitError extends Error {
  retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super(`Xero daily rate limit exhausted (retry-after ${retryAfterSeconds ?? '?'}s)`);
    this.name = 'XeroDayLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Single-instance lock (cron + manual share it) and last-run stamp for the
// manual cooldown. Manual clicks within MANUAL_COOLDOWN_MS of the last run are
// rejected so rapid clicks can't pile up Xero calls.
let invoiceSyncRunning = false;
let lastInvoiceSyncAt = 0; // epoch ms when the last run STARTED (any source)
const MANUAL_COOLDOWN_MS = 60_000;

export function isInvoiceSyncRunning(): boolean {
  return invoiceSyncRunning;
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// GET one Xero page, retrying on a transient 429 (minute-limit) by honouring
// Retry-After, capped so a run never blocks for long. A *daily*-limit 429
// (x-rate-limit-problem: day) resets only after hours, so there's no point
// retrying within a run — surface it immediately so the caller keeps the
// existing cache and the next scheduled run picks up once the quota resets.
async function fetchXeroPage(
  page: number,
  token: string,
  tenantId: string
): Promise<XeroInvoice[]> {
  const MAX_RETRIES = 4;
  const MAX_WAIT_MS = 65000; // never block a run longer than ~1 min per page

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await axios.get(`${XERO_API_URL}/Invoices`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Xero-Tenant-Id': tenantId,
          Accept: 'application/json',
        },
        params: { Statuses: 'AUTHORISED,PAID', page },
        timeout: 30000,
      });
      return res.data?.Invoices || [];
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const headers = (axios.isAxiosError(err) ? err.response?.headers : undefined) || {};
      const problem = headers['x-rate-limit-problem'];
      const retryAfter = parseInt(String(headers['retry-after'] || ''), 10);

      // Daily quota exhausted — won't recover within this run. Bail out.
      if (status === 429 && problem === 'day') {
        logger.error({
          event: 'invoice_sync_xero_day_limit',
          retry_after_s: Number.isFinite(retryAfter) ? retryAfter : null,
          day_remaining: headers['x-daylimit-remaining'],
        });
        throw new XeroDayLimitError(Number.isFinite(retryAfter) ? retryAfter : null);
      }

      // Transient 429 (minute/app limit) — back off and retry, capped.
      if (status === 429 && attempt <= MAX_RETRIES) {
        const waitMs = Math.min(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt,
          MAX_WAIT_MS
        );
        logger.warn({
          event: 'invoice_sync_xero_429_retry',
          page, attempt, problem: problem || null, wait_ms: waitMs,
        });
        await sleep(waitMs);
        continue;
      }

      throw err;
    }
  }
}

// Fetch ALL AUTHORISED + PAID invoices, paging until a short page is returned.
// (Xero caps each page at 100; DRAFT/SUBMITTED are intentionally not fetched —
// they map to "not invoiced".) Each page is 429-aware (see fetchXeroPage), and
// pages are lightly paced so a full ~12-page run stays well under Xero's
// 60-calls/minute limit.
async function fetchXeroInvoices(): Promise<XeroInvoice[]> {
  const token = await getAccessToken();
  const tenantId = await getConfigValue('xero_tenant_id');
  if (!tenantId) throw new Error('Xero tenant ID not configured.');

  const all: XeroInvoice[] = [];
  let page = 1;
  const MAX_PAGES = 100; // safety stop (~10k invoices)

  while (page <= MAX_PAGES) {
    const batch = await fetchXeroPage(page, token, tenantId);
    all.push(...batch);
    if (batch.length < 100) break; // last page
    page++;
    await sleep(250); // pace pages: ~4/s keeps us under the 60/min minute limit
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

// Upsert ALL Xero invoices matched to a hardscape prospect into prospect_invoices
// (the new multi-invoice billing source for the 4b Completed view), idempotent by
// xero_invoice_id. Stores the RAW Xero status (paid / authorised); the display
// status is computed on read in the feed. source='manual' rows are never touched,
// and stale source='xero' rows (no longer matched) are pruned for this prospect.
async function syncProspectInvoices(prospectId: number, invs: XeroInvoice[]): Promise<number> {
  const keepIds: string[] = [];

  for (const inv of invs) {
    if (!inv.InvoiceID) continue;
    keepIds.push(inv.InvoiceID);
    const rawStatus = (inv.Status || '').toLowerCase();
    const paidDate = rawStatus === 'paid' ? parseXeroDate(inv.FullyPaidOnDate) : null;

    await pool.query(
      `INSERT INTO prospect_invoices
         (prospect_id, invoice_number, amount, note, source, xero_invoice_id, status, due_date, paid_date)
       VALUES ($1, $2, $3, $4, 'xero', $5, $6, $7, $8)
       ON CONFLICT (xero_invoice_id) WHERE xero_invoice_id IS NOT NULL DO UPDATE SET
         prospect_id    = EXCLUDED.prospect_id,
         invoice_number = EXCLUDED.invoice_number,
         amount         = EXCLUDED.amount,
         note           = EXCLUDED.note,
         source         = 'xero',
         status         = EXCLUDED.status,
         due_date       = EXCLUDED.due_date,
         paid_date      = EXCLUDED.paid_date`,
      [
        prospectId,
        inv.InvoiceNumber || null,
        inv.Total ?? null,
        inv.Reference || null,
        inv.InvoiceID,
        rawStatus || null,
        parseXeroDate(inv.DueDate),
        paidDate,
      ]
    );
  }

  // Prune Xero rows that no longer match this prospect (e.g. Reference changed).
  // <> ALL('{}') is vacuously true, so an empty keep-set clears all xero rows.
  // Manual rows (source='manual') are intentionally left alone.
  await pool.query(
    `DELETE FROM prospect_invoices
     WHERE prospect_id = $1 AND source = 'xero' AND xero_invoice_id <> ALL($2::text[])`,
    [prospectId, keepIds]
  );

  return keepIds.length;
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

async function syncInvoices(): Promise<InvoiceSyncResult> {
  if (invoiceSyncRunning) {
    logger.info({ event: 'invoice_sync_skipped_locked' });
    return { status: 'already_running' };
  }
  invoiceSyncRunning = true;
  lastInvoiceSyncAt = Date.now();

  let prospectInvoicesUpserted = 0;

  try {
    logger.info({ event: 'invoice_sync_start' });

    // 1. Fetch Xero invoices
    let xeroInvoices: XeroInvoice[];
    try {
      xeroInvoices = await fetchXeroInvoices();
    } catch (err) {
      // Daily quota exhausted — surface a structured day_limited result so the
      // dashboard shows a friendly "try again later" instead of a failure.
      if (err instanceof XeroDayLimitError) {
        const result: InvoiceSyncResult = {
          status: 'day_limited',
          retryAfterSeconds: err.retryAfterSeconds ?? undefined,
          ranAt: new Date().toISOString(),
          message: 'Xero daily limit reached',
        };
        await persistLastSync(result);
        return result;
      }
      logger.error({
        event: 'invoice_sync_xero_error',
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'error', message: 'Xero fetch failed', ranAt: new Date().toISOString() };
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
        SELECT id, sm8_job_uuid, sm8_job_number, sm8_client_name
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

          // NEW (Phase 4a): persist ALL matched invoices for this prospect into
          // prospect_invoices (multiple per job), idempotent by xero_invoice_id.
          // invoice_cache above stays as the single-match badge source.
          prospectInvoicesUpserted += await syncProspectInvoices(row.id, matched);
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
      // Hardscape (Xero) matching above already completed — only the landscape
      // pass needs SM8. Report success for the work that landed rather than
      // discarding it; the next run retries the landscape pass.
      logger.error({
        event: 'invoice_sync_sm8_error',
        error: err instanceof Error ? err.message : String(err),
      });
      const result: InvoiceSyncResult = {
        status: 'ok',
        invoicesFetched: xeroInvoices.length,
        prospectInvoicesUpserted,
        hardscapeMatchedByJobNumber: hsJobMatched,
        hardscapeMatchedByClientName: hsNameMatched,
        hardscapeUnmatched: hsTotal - hsJobMatched - hsNameMatched,
        ranAt: new Date().toISOString(),
        message: 'Hardscape invoices synced (landscape pass skipped — ServiceM8 unavailable)',
      };
      await persistLastSync(result);
      return result;
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
      prospect_invoices_upserted: prospectInvoicesUpserted,
    });

    const result: InvoiceSyncResult = {
      status: 'ok',
      invoicesFetched: xeroInvoices.length,
      prospectInvoicesUpserted,
      hardscapeMatchedByJobNumber: hsJobMatched,
      hardscapeMatchedByClientName: hsNameMatched,
      hardscapeUnmatched: hsTotal - hsJobMatched - hsNameMatched,
      ranAt: new Date().toISOString(),
    };
    await persistLastSync(result);
    return result;
  } catch (err) {
    logger.error({
      event: 'invoice_sync_error',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { status: 'error', message: 'Invoice sync failed', ranAt: new Date().toISOString() };
  } finally {
    invoiceSyncRunning = false;
  }
}

// Record the last invoice-sync result for the dashboard's "Last synced" label.
// Non-fatal if the write fails. day_limited runs are recorded too (so the UI can
// show when we last tried), but a successful 'ok' overwrites it next time.
async function persistLastSync(result: InvoiceSyncResult): Promise<void> {
  try {
    await setConfigValue('xero_invoice_last_sync', JSON.stringify(result));
  } catch (err) {
    logger.error({
      event: 'invoice_sync_last_sync_write_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Run the Xero invoice sync once. The hourly cron calls this with no options;
 * the dashboard "Sync from Xero" button calls it with { manual: true }, which
 * adds a ~60s cooldown so rapid clicks can't stack Xero calls. Always returns a
 * structured result — including { status: 'day_limited' } when Xero's daily
 * quota is exhausted — rather than throwing.
 */
export async function runInvoiceSyncNow(opts?: { manual?: boolean }): Promise<InvoiceSyncResult> {
  if (opts?.manual && lastInvoiceSyncAt) {
    const sinceMs = Date.now() - lastInvoiceSyncAt;
    if (sinceMs < MANUAL_COOLDOWN_MS && !invoiceSyncRunning) {
      return {
        status: 'cooldown',
        retryAfterSeconds: Math.ceil((MANUAL_COOLDOWN_MS - sinceMs) / 1000),
        message: 'Just synced — try again shortly',
      };
    }
  }
  return await syncInvoices();
}

export function startInvoiceSync(): void {
  logger.info({ event: 'invoice_sync_init' });

  // Run immediately on startup
  syncInvoices();

  // Hourly. Each run now pages through ALL ~1,180 invoices (≈12 Xero calls),
  // so the previous every-15-min cadence was ~1,150 Xero calls/day for this
  // worker alone and was exhausting the 5,000/day tenant quota. Hourly keeps
  // billing data fresh while cutting that to ~290/day.
  cron.schedule('0 * * * *', () => {
    syncInvoices();
  }, { timezone: 'America/Chicago' });

  logger.info({ event: 'invoice_sync_scheduled', interval: '1h' });
}
