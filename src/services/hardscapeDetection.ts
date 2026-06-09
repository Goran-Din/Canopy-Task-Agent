/**
 * Hardscape detection — shared logic used by both the one-off seed script
 * (scripts/seed-hardscape-prospects.ts) and the hourly SM8 sync worker.
 *
 * Detection method (identical to scripts/hardscape-report.ts):
 *   match jobmaterial.material_uuid → material-catalog items whose item_number
 *   starts with "4230". Any job carrying at least one such line item, in one of
 *   the scanned statuses, is a hardscape job. Scope summary and quoted total are
 *   produced exactly as the report produced them.
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { ProspectStage } from '../types';

const HARDSCAPE_PREFIX = '4230';
const BILLING_ONLY_PREFIXES = ['4230-DEPOSIT', '4230-DEPOSIT-CREDIT', '4230-TOTAL AMOUNT', '4230-TOTAL'];
const SCAN_STATUSES = ['Quote', 'Work Order', 'In Progress', 'Invoice', 'Completed', 'Unsuccessful'];

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
 * prospect pipeline needs. Pulls the full material catalog, job, jobmaterial,
 * and company lists once each.
 */
export async function detectHardscapeJobs(): Promise<DetectedHardscapeJob[]> {
  const [allMaterials, allJobs, allJobmaterials, allCompanies] = await Promise.all([
    sm8Get('/material.json'),
    sm8Get('/job.json'),
    sm8Get('/jobmaterial.json'),
    sm8Get('/company.json'),
  ]);

  // 4230 catalog items, indexed by UUID
  const materialMap = new Map<string, MaterialRecord>();
  for (const m of allMaterials as MaterialRecord[]) {
    if (m.item_number && m.item_number.startsWith(HARDSCAPE_PREFIX)) {
      materialMap.set(m.uuid, m);
    }
  }
  if (materialMap.size === 0) return [];

  const companyMap = new Map<string, any>();
  for (const c of allCompanies) companyMap.set(c.uuid, c);

  const jobMap = new Map<string, any>();
  for (const j of allJobs) jobMap.set(j.uuid, j);

  // Group 4230 line items by job
  const jobHardscapeItems = new Map<string, Array<{ material: MaterialRecord }>>();
  for (const jm of allJobmaterials) {
    if (materialMap.has(jm.material_uuid)) {
      const mat = materialMap.get(jm.material_uuid)!;
      if (!jobHardscapeItems.has(jm.job_uuid)) jobHardscapeItems.set(jm.job_uuid, []);
      jobHardscapeItems.get(jm.job_uuid)!.push({ material: mat });
    }
  }

  const results: DetectedHardscapeJob[] = [];

  for (const [jobUuid, items] of jobHardscapeItems) {
    const job = jobMap.get(jobUuid);
    if (!job) continue;
    if (!SCAN_STATUSES.includes(job.status)) continue;

    const company = job.company_uuid ? companyMap.get(job.company_uuid) : null;
    const customerName = company?.name || 'Unknown';

    const scopeSummary = buildScopeSummary(items, job.job_description || '');

    // Site address from the SM8 job record — normalise embedded newlines to a
    // single readable line and tidy duplicate commas / whitespace.
    const jobAddress = (job.job_address || '')
      .replace(/\s*\n+\s*/g, ', ')
      .replace(/,\s*,/g, ',')
      .replace(/\s+/g, ' ')
      .trim();

    let quotedTotal = parseFloat(job.total_amount || job.job_total || '0');
    if (!quotedTotal || isNaN(quotedTotal)) {
      quotedTotal = allJobmaterials
        .filter((jm: any) => jm.job_uuid === jobUuid)
        .reduce((sum: number, jm: any) => {
          const qty = parseFloat(jm.quantity || jm.qty || '1');
          const price = parseFloat(jm.price || jm.unit_cost || '0');
          return sum + qty * price;
        }, 0);
    }

    results.push({
      sm8_client_uuid: job.company_uuid || 'unknown',
      sm8_client_name: customerName,
      sm8_job_uuid: jobUuid,
      sm8_job_number: job.generated_job_id || jobUuid.slice(0, 8),
      sm8_status: job.status,
      scope_summary: scopeSummary,
      quoted_total: Number.isFinite(quotedTotal) ? quotedTotal : 0,
      job_address: jobAddress,
    });
  }

  return results;
}
