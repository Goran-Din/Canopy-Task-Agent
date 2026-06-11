/**
 * Hardscape detection — shared logic used by the one-off seed script
 * (scripts/seed-hardscape-prospects.ts), the Excel report
 * (scripts/hardscape-report.ts), and the hourly SM8 sync worker.
 *
 * A job is a hardscape job if ANY of these three signals fire (OR, not AND):
 *   A) "creator"  — created_by_staff_uuid is one of the configured creator
 *                   UUIDs (default: Marcin Lemanski).
 *   B) "category" — category_uuid is one of the configured category UUIDs
 *                   (default: the "Hardscape Projects" category).
 *   C) "itemcode" — the job carries ≥1 jobmaterial line item whose material
 *                   resolves to a catalog item_number starting "4230"
 *                   (the original detection; matching unchanged).
 *
 * Signals A and B read /job.json fields that persist through the entire
 * Quote → Work Order → Completed lifecycle. Signal C only works while line
 * items exist (mainly Quotes). Each detected job reports which signals fired
 * via `matched_by`. Only jobs in one of the scanned statuses are considered.
 *
 * The creator/category UUID lists are read from config_store keys
 * `hardscape_creator_uuids` / `hardscape_category_uuids` (each a JSON array)
 * when available, falling back to the built-in defaults below. This lets more
 * creators/categories be added later without a code change. The config read
 * degrades gracefully: if config_store is unreachable (e.g. the report run
 * outside the docker network) the defaults are used.
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { getConfigValue } from '../db/queries';
import { ProspectStage } from '../types';

const HARDSCAPE_PREFIX = '4230';
const BILLING_ONLY_PREFIXES = ['4230-DEPOSIT', '4230-DEPOSIT-CREDIT', '4230-TOTAL AMOUNT', '4230-TOTAL'];
const SCAN_STATUSES = ['Quote', 'Work Order', 'In Progress', 'Invoice', 'Completed', 'Unsuccessful'];

// Signal A/B defaults (confirmed from ServiceM8 discovery). Overridable via the
// config_store keys below — arrays so more values can be added without a deploy.
const DEFAULT_HARDSCAPE_CREATOR_UUIDS = ['0b8200fb-d98a-44e5-8c30-23c6fef14acb']; // Marcin Lemanski
const DEFAULT_HARDSCAPE_CATEGORY_UUIDS = ['0e351232-cb5e-4890-afcd-23c729412b2b']; // "Hardscape Projects"
const CONFIG_KEY_CREATOR_UUIDS = 'hardscape_creator_uuids';
const CONFIG_KEY_CATEGORY_UUIDS = 'hardscape_category_uuids';

export type MatchSignal = 'creator' | 'category' | 'itemcode';

// ServiceM8 job status → initial pipeline stage (applied only to NEW prospects).
const STATUS_TO_STAGE: Record<string, ProspectStage> = {
  'Quote': 'quote_sent',
  'Work Order': 'scheduled_for_work',
  'In Progress': 'work_in_progress',
  'Invoice': 'completed',
  'Completed': 'completed',
  'Unsuccessful': 'lost_opportunity',
};

export function stageForStatus(status: string): ProspectStage {
  return STATUS_TO_STAGE[status] || 'quote_sent';
}

export interface DetectedHardscapeJob {
  sm8_client_uuid: string;
  sm8_client_name: string;
  sm8_job_uuid: string;
  sm8_job_number: string;
  sm8_status: string;
  scope_summary: string;
  quoted_total: number;
  job_address: string;
  // Which of the three signals flagged this job (any of creator/category/itemcode).
  matched_by: MatchSignal[];
  // SM8 job.date — surfaced for reporting. Empty string when absent.
  job_date: string;
  // Human-readable "4230-CODE: name; …" list of the matched 4230 line items.
  // Empty when the job matched only by creator/category (no 4230 line items).
  hardscape_items: string;
}

interface MaterialRecord {
  uuid: string;
  name?: string;
  item_number?: string;
}

const sm8Api: AxiosInstance = axios.create({
  baseURL: config.servicem8.baseUrl,
  headers: { 'X-API-Key': config.servicem8.apiKey, Accept: 'application/json' },
  timeout: 30000,
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function sm8Get(endpoint: string, retries = 3): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await sm8Api.get(endpoint);
      return res.data;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 429 || (status && status >= 500)) {
        await delay(Math.min(2000 * Math.pow(2, attempt - 1), 15000));
        continue;
      }
      if (attempt === retries) throw err;
      await delay(1000 * attempt);
    }
  }
}

function isBillingOnly(itemNumber: string): boolean {
  const upper = itemNumber.toUpperCase();
  return BILLING_ONLY_PREFIXES.some((bp) => upper === bp.toUpperCase() || upper.startsWith(bp.toUpperCase()));
}

/**
 * Read a JSON-array UUID list from config_store, falling back to `fallback` if
 * the key is missing, malformed, or config_store is unreachable. The read is
 * intentionally best-effort so detection still runs outside the docker network
 * (e.g. the report run on the host, where the DB host does not resolve).
 */
async function resolveUuidList(key: string, fallback: string[]): Promise<string[]> {
  try {
    const raw = await getConfigValue(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const uuids = parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
        if (uuids.length > 0) return uuids;
      }
    }
  } catch {
    // Missing key, invalid JSON, or DB unreachable — fall back to defaults.
  }
  return fallback;
}

function buildScopeSummary(
  items: Array<{ material: MaterialRecord }>,
  jobDescription: string
): string {
  const workItems = items.filter(({ material }) => !isBillingOnly(material.item_number || ''));

  if (workItems.length > 0) {
    const distinctNames = [...new Set(workItems.map(({ material }) => {
      const rawName = (material.name || material.item_number || '').trim();
      if (rawName.length > 80) {
        const firstSentence = rawName.split(/\.\s/)[0];
        return firstSentence.length <= 100 ? firstSentence : rawName.substring(0, 77) + '…';
      }
      return rawName;
    }))];

    let scopeSummary: string;
    if (distinctNames.length === 1) {
      scopeSummary = distinctNames[0] + '.';
    } else if (distinctNames.length === 2) {
      scopeSummary = distinctNames.join(' and ') + '.';
    } else {
      const last = distinctNames.pop()!;
      scopeSummary = distinctNames.join(', ') + ', and ' + last + '.';
    }
    if (scopeSummary.length > 300) scopeSummary = scopeSummary.substring(0, 297) + '…';
    return scopeSummary;
  }

  const desc = (jobDescription || '').trim();
  return desc
    ? desc.substring(0, 200) + (desc.length > 200 ? '…' : '') + ' (from job description)'
    : '(no scope details available)';
}

/**
 * Returns every current hardscape job from ServiceM8 with the fields the
 * prospect pipeline needs, applying the 3-signal OR rule (creator / category /
 * itemcode). Pulls the full material catalog, job, jobmaterial, and company
 * lists once each, and resolves the creator/category UUID lists from
 * config_store (with built-in fallbacks).
 */
export async function detectHardscapeJobs(): Promise<DetectedHardscapeJob[]> {
  const [allMaterials, allJobs, allJobmaterials, allCompanies] = await Promise.all([
    sm8Get('/material.json'),
    sm8Get('/job.json'),
    sm8Get('/jobmaterial.json'),
    sm8Get('/company.json'),
  ]);

  // Signal A/B configuration — config_store overrides, else built-in defaults.
  const [creatorUuids, categoryUuids] = await Promise.all([
    resolveUuidList(CONFIG_KEY_CREATOR_UUIDS, DEFAULT_HARDSCAPE_CREATOR_UUIDS),
    resolveUuidList(CONFIG_KEY_CATEGORY_UUIDS, DEFAULT_HARDSCAPE_CATEGORY_UUIDS),
  ]);
  const creatorSet = new Set(creatorUuids);
  const categorySet = new Set(categoryUuids);

  // Signal C — 4230 catalog items, indexed by UUID (matching unchanged).
  const materialMap = new Map<string, MaterialRecord>();
  for (const m of allMaterials as MaterialRecord[]) {
    if (m.item_number && m.item_number.startsWith(HARDSCAPE_PREFIX)) {
      materialMap.set(m.uuid, m);
    }
  }

  const companyMap = new Map<string, any>();
  for (const c of allCompanies) companyMap.set(c.uuid, c);

  // Group 4230 line items by job (Signal C source).
  const jobHardscapeItems = new Map<string, Array<{ material: MaterialRecord }>>();
  for (const jm of allJobmaterials) {
    if (materialMap.has(jm.material_uuid)) {
      const mat = materialMap.get(jm.material_uuid)!;
      if (!jobHardscapeItems.has(jm.job_uuid)) jobHardscapeItems.set(jm.job_uuid, []);
      jobHardscapeItems.get(jm.job_uuid)!.push({ material: mat });
    }
  }

  const results: DetectedHardscapeJob[] = [];

  // Evaluate all three signals per job. Iterating allJobs de-duplicates by job
  // (one record per uuid) and lets creator/category-only jobs through even when
  // they carry no 4230 line items.
  for (const job of allJobs) {
    if (!SCAN_STATUSES.includes(job.status)) continue;

    const items = jobHardscapeItems.get(job.uuid) || [];
    const matchedBy: MatchSignal[] = [];
    if (job.created_by_staff_uuid && creatorSet.has(job.created_by_staff_uuid)) matchedBy.push('creator');
    if (job.category_uuid && categorySet.has(job.category_uuid)) matchedBy.push('category');
    if (items.length > 0) matchedBy.push('itemcode');

    if (matchedBy.length === 0) continue; // A OR B OR C — none fired

    const company = job.company_uuid ? companyMap.get(job.company_uuid) : null;
    const customerName = company?.name || 'Unknown';

    // Scope summary & item list come from the 4230 line items. When the job
    // matched only by creator/category these are intentionally blank.
    const hasItems = items.length > 0;
    const scopeSummary = hasItems ? buildScopeSummary(items, job.job_description || '') : '';
    const hardscapeItems = hasItems
      ? items
          .map(({ material }) => `${material.item_number}: ${(material.name || '').substring(0, 80)}`)
          .join('; ')
      : '';

    // Site address from the SM8 job record — normalise embedded newlines to a
    // single readable line and tidy duplicate commas / whitespace.
    const jobAddress = (job.job_address || '')
      .replace(/\s*\n+\s*/g, ', ')
      .replace(/,\s*,/g, ',')
      .replace(/\s+/g, ' ')
      .trim();

    // Quoted total is only meaningful for jobs with 4230 line items; for
    // creator/category-only jobs (no line items) it stays 0 / blank.
    let quotedTotal = 0;
    if (hasItems) {
      quotedTotal = parseFloat(job.total_amount || job.job_total || '0');
      if (!quotedTotal || isNaN(quotedTotal)) {
        quotedTotal = allJobmaterials
          .filter((jm: any) => jm.job_uuid === job.uuid)
          .reduce((sum: number, jm: any) => {
            const qty = parseFloat(jm.quantity || jm.qty || '1');
            const price = parseFloat(jm.price || jm.unit_cost || '0');
            return sum + qty * price;
          }, 0);
      }
    }

    results.push({
      sm8_client_uuid: job.company_uuid || 'unknown',
      sm8_client_name: customerName,
      sm8_job_uuid: job.uuid,
      sm8_job_number: job.generated_job_id || job.uuid.slice(0, 8),
      sm8_status: job.status,
      scope_summary: scopeSummary,
      quoted_total: Number.isFinite(quotedTotal) ? quotedTotal : 0,
      job_address: jobAddress,
      matched_by: matchedBy,
      job_date: job.date || '',
      hardscape_items: hardscapeItems,
    });
  }

  return results;
}
