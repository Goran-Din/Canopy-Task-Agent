/**
 * Hardscape Jobs Report — One-off Excel report generator
 *
 * Finds all ServiceM8 jobs that use at least one item with code prefix "4230"
 * (hardscape) by joining the material catalog to jobmaterial line items,
 * then writes a formatted Excel workbook.
 *
 * Usage:  npx ts-node scripts/hardscape-report.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import axios, { AxiosInstance } from 'axios';
import ExcelJS from 'exceljs';
import fs from 'fs';

// ─── Config (reuse project auth pattern) ───────────────────────────────────

const SM8_API_KEY = process.env.SM8_API_KEY;
const SM8_BASE_URL = process.env.SM8_BASE_URL || 'https://api.servicem8.com/api_1.0';

if (!SM8_API_KEY) {
  console.error('ERROR: SM8_API_KEY not found in .env');
  process.exit(1);
}

const sm8Api: AxiosInstance = axios.create({
  baseURL: SM8_BASE_URL,
  headers: {
    'X-API-Key': SM8_API_KEY,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// ─── Constants ─────────────────────────────────────────────────────────────

const HARDSCAPE_PREFIX = '4230';
const BILLING_ONLY_PREFIXES = ['4230-DEPOSIT', '4230-DEPOSIT-CREDIT', '4230-TOTAL AMOUNT', '4230-TOTAL'];
const SCAN_STATUSES = ['Quote', 'Work Order', 'In Progress', 'Invoice', 'Completed', 'Unsuccessful'];
const HARDSCAPE_KEYWORDS = ['patio', 'paver', 'retaining wall', 'hardscape', 'walkway',
  'driveway', 'concrete', 'pergola', 'stairs', 'drainage', 'stone', 'brick'];

const TODAY = new Date().toISOString().split('T')[0];
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');
const REPORT_PATH = path.join(REPORT_DIR, `Hardscape-Jobs-Report-${TODAY}.xlsx`);

// ─── Helpers ───────────────────────────────────────────────────────────────

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
        const wait = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
        console.log(`  ⏳ ${endpoint} — HTTP ${status} attempt ${attempt}, retrying in ${wait}ms…`);
        await delay(wait);
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

// ─── Step 1a: Discover the item-code field ─────────────────────────────────

interface MaterialRecord {
  uuid: string;
  name: string;
  item_number: string;
  item_description: string;
  price: number;
  active: number;
  [key: string]: unknown;
}

async function discoverAndLoadMaterials(): Promise<Map<string, MaterialRecord>> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('STEP 1a — Load material catalog & find 4230 items');
  console.log('══════════════════════════════════════════════════════\n');

  const allMaterials: MaterialRecord[] = await sm8Get('/material.json');
  console.log(`Material catalog: ${allMaterials.length} total items.`);

  const hardscapeMaterials = allMaterials.filter(
    (m) => m.item_number && m.item_number.startsWith(HARDSCAPE_PREFIX)
  );
  console.log(`Found ${hardscapeMaterials.length} items with item_number starting "4230".\n`);

  if (hardscapeMaterials.length === 0) {
    console.error('STOPPED: No materials with 4230 prefix found in the catalog.');
    process.exit(1);
  }

  // Print them
  for (const m of hardscapeMaterials) {
    const tag = isBillingOnly(m.item_number) ? ' [BILLING-ONLY]' : '';
    console.log(`  ${m.item_number.padEnd(22)} ${(m.name || '').substring(0, 70)}${tag}`);
  }

  // Build UUID → material lookup
  const materialMap = new Map<string, MaterialRecord>();
  for (const m of hardscapeMaterials) {
    materialMap.set(m.uuid, m);
  }

  console.log(`\nItem-code field confirmed: "item_number" on /material.json`);
  console.log(`Matching via "material_uuid" on /jobmaterial.json → material catalog UUIDs.\n`);

  return materialMap;
}

// ─── Step 1b: Coverage check ───────────────────────────────────────────────

interface CoverageResult {
  quotesChecked: number;
  quotesWithLines: number;
  nonQuotesChecked: number;
  nonQuotesWithLines: number;
  summary: string;
}

async function coverageCheck(
  hardscapeUuids: Set<string>,
  allJobs: any[],
  allJobmaterials: any[]
): Promise<CoverageResult> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('STEP 1b — Coverage check: do converted jobs keep 4230 lines?');
  console.log('══════════════════════════════════════════════════════\n');

  // Index jobmaterials by job_uuid for fast lookup
  const jmByJob = new Map<string, any[]>();
  for (const jm of allJobmaterials) {
    if (!jmByJob.has(jm.job_uuid)) jmByJob.set(jm.job_uuid, []);
    jmByJob.get(jm.job_uuid)!.push(jm);
  }

  // Find non-Quote jobs with hardscape keywords
  const nonQuoteCandidates = allJobs.filter((j: any) => {
    if (!['Work Order', 'Completed', 'In Progress', 'Invoice'].includes(j.status)) return false;
    const desc = ((j.job_description || '') + ' ' + (j.job_address || '')).toLowerCase();
    return HARDSCAPE_KEYWORDS.some((kw) => desc.includes(kw));
  });

  console.log(`Found ${nonQuoteCandidates.length} non-Quote jobs with hardscape keywords.`);
  const nonQuoteSample = nonQuoteCandidates.slice(0, 10);

  let nonQuotesChecked = 0;
  let nonQuotesWithLines = 0;

  for (const job of nonQuoteSample) {
    const mats = jmByJob.get(job.uuid) || [];
    const has4230 = mats.some((m: any) => hardscapeUuids.has(m.material_uuid));
    nonQuotesChecked++;
    if (has4230) nonQuotesWithLines++;
    console.log(`  ${job.status.padEnd(14)} #${(job.generated_job_id || '???').padEnd(8)} ${mats.length} line items, 4230 present: ${has4230}`);
  }

  // Check a few Quotes
  const quoteCandidates = allJobs.filter((j: any) =>
    j.status === 'Quote' && HARDSCAPE_KEYWORDS.some((kw) =>
      ((j.job_description || '').toLowerCase()).includes(kw)
    )
  ).slice(0, 5);

  let quotesChecked = 0;
  let quotesWithLines = 0;

  for (const job of quoteCandidates) {
    const mats = jmByJob.get(job.uuid) || [];
    const has4230 = mats.some((m: any) => hardscapeUuids.has(m.material_uuid));
    quotesChecked++;
    if (has4230) quotesWithLines++;
    console.log(`  Quote          #${(job.generated_job_id || '???').padEnd(8)} ${mats.length} line items, 4230 present: ${has4230}`);
  }

  const summary =
    `Quotes: ${quotesWithLines}/${quotesChecked} sampled had 4230 lines. ` +
    `Non-Quotes (WO/IP/Inv/Completed): ${nonQuotesWithLines}/${nonQuotesChecked} sampled had 4230 lines. ` +
    (nonQuotesWithLines < nonQuotesChecked
      ? `Converted jobs whose line items are gone are NOT captured in this report.`
      : `All sampled non-Quote jobs still had their 4230 lines.`);

  console.log(`\nCoverage summary: ${summary}\n`);
  return { quotesChecked, quotesWithLines, nonQuotesChecked, nonQuotesWithLines, summary };
}

// ─── Step 2+3: Match jobs and build rows ───────────────────────────────────

interface HardscapeJobRow {
  jobId: string;
  customerName: string;
  scopeSummary: string;
  status: string;
  hardscapeItems: string;
  quotedTotal: number;
  jobDate: string;
  jobUuid: string;
}

async function buildHardscapeRows(
  materialMap: Map<string, MaterialRecord>,
  allJobs: any[],
  allJobmaterials: any[],
  allCompanies: any[]
): Promise<HardscapeJobRow[]> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('STEP 2+3 — Match jobs & build report rows');
  console.log('══════════════════════════════════════════════════════\n');

  // Index companies by UUID
  const companyMap = new Map<string, any>();
  for (const c of allCompanies) {
    companyMap.set(c.uuid, c);
  }

  // Index jobs by UUID
  const jobMap = new Map<string, any>();
  for (const j of allJobs) {
    jobMap.set(j.uuid, j);
  }

  // Group jobmaterials by job_uuid, keeping only 4230 matches
  const hardscapeUuids = new Set(materialMap.keys());
  const jobHardscapeItems = new Map<string, Array<{ material: MaterialRecord; jm: any }>>();

  for (const jm of allJobmaterials) {
    if (hardscapeUuids.has(jm.material_uuid)) {
      const mat = materialMap.get(jm.material_uuid)!;
      if (!jobHardscapeItems.has(jm.job_uuid)) {
        jobHardscapeItems.set(jm.job_uuid, []);
      }
      jobHardscapeItems.get(jm.job_uuid)!.push({ material: mat, jm });
    }
  }

  console.log(`Jobmaterial records scanned: ${allJobmaterials.length}`);
  console.log(`Jobs with at least one 4230 line item: ${jobHardscapeItems.size}\n`);

  if (jobHardscapeItems.size === 0) {
    console.error('STOPPED: No jobmaterial records matched any 4230 material UUID.');
    process.exit(1);
  }

  const rows: HardscapeJobRow[] = [];

  for (const [jobUuid, items] of jobHardscapeItems) {
    const job = jobMap.get(jobUuid);
    if (!job) {
      console.log(`  WARN: Job ${jobUuid} not in job list — skipped.`);
      continue;
    }

    if (!SCAN_STATUSES.includes(job.status)) {
      continue;
    }

    // Customer name
    const company = job.company_uuid ? companyMap.get(job.company_uuid) : null;
    const customerName = company?.name || 'Unknown';

    // Hardscape items column: all 4230 codes + names
    const allItemLabels = items.map(({ material }) => {
      const code = material.item_number;
      const shortName = (material.name || '').substring(0, 80);
      return `${code}: ${shortName}`;
    });
    const hardscapeItemsStr = allItemLabels.join('; ');

    // Scope summary — exclude billing-only codes
    const workItems = items.filter(({ material }) => !isBillingOnly(material.item_number));

    let scopeSummary: string;
    if (workItems.length > 0) {
      // Build readable names from distinct item names
      const distinctNames = [...new Set(workItems.map(({ material }) => {
        // Use the name but truncate long descriptions to something readable
        const rawName = (material.name || material.item_number).trim();
        // If name is very long (a full description), take first sentence or first ~80 chars
        if (rawName.length > 80) {
          const firstSentence = rawName.split(/\.\s/)[0];
          return firstSentence.length <= 100
            ? firstSentence
            : rawName.substring(0, 77) + '…';
        }
        return rawName;
      }))];

      if (distinctNames.length === 1) {
        scopeSummary = distinctNames[0] + '.';
      } else if (distinctNames.length === 2) {
        scopeSummary = distinctNames.join(' and ') + '.';
      } else {
        const last = distinctNames.pop()!;
        scopeSummary = distinctNames.join(', ') + ', and ' + last + '.';
      }
      if (scopeSummary.length > 300) {
        scopeSummary = scopeSummary.substring(0, 297) + '…';
      }
    } else {
      // Only billing lines — fall back to job description
      const desc = (job.job_description || '').trim();
      scopeSummary = desc
        ? desc.substring(0, 200) + (desc.length > 200 ? '…' : '') + ' (from job description)'
        : '(no scope details available)';
    }

    // Quoted total
    let quotedTotal = parseFloat(job.total_amount || job.job_total || '0');
    if (!quotedTotal || isNaN(quotedTotal)) {
      // Sum line items for this job from ALL jobmaterials (not just 4230)
      quotedTotal = allJobmaterials
        .filter((jm: any) => jm.job_uuid === jobUuid)
        .reduce((sum: number, jm: any) => {
          const qty = parseFloat(jm.quantity || jm.qty || '1');
          const price = parseFloat(jm.price || jm.unit_cost || '0');
          return sum + qty * price;
        }, 0);
    }

    const jobDate = job.date || '';

    rows.push({
      jobId: job.generated_job_id || jobUuid.slice(0, 8),
      customerName,
      scopeSummary,
      status: job.status,
      hardscapeItems: hardscapeItemsStr,
      quotedTotal,
      jobDate,
      jobUuid,
    });
  }

  // Sort by Status then Job Date (newest first)
  const statusOrder: Record<string, number> = {
    'Quote': 1, 'Work Order': 2, 'In Progress': 3,
    'Invoice': 4, 'Completed': 5, 'Unsuccessful': 6,
  };
  rows.sort((a, b) => {
    const sa = statusOrder[a.status] || 99;
    const sb = statusOrder[b.status] || 99;
    if (sa !== sb) return sa - sb;
    return (b.jobDate || '').localeCompare(a.jobDate || '');
  });

  console.log(`Built ${rows.length} report rows (after filtering to valid statuses).\n`);
  return rows;
}

// ─── Step 4: Write Excel ───────────────────────────────────────────────────

async function writeExcel(
  rows: HardscapeJobRow[],
  coverage: CoverageResult,
  totalJobmaterials: number
): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('STEP 4 — Write Excel report');
  console.log('══════════════════════════════════════════════════════\n');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Canopy Task Agent';
  workbook.created = new Date();

  // ── Sheet 1: Hardscape Jobs ──
  const ws1 = workbook.addWorksheet('Hardscape Jobs');

  ws1.columns = [
    { header: 'Job ID', key: 'jobId', width: 12 },
    { header: 'Customer Name', key: 'customerName', width: 30 },
    { header: 'Scope Summary', key: 'scopeSummary', width: 55 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Hardscape Items', key: 'hardscapeItems', width: 50 },
    { header: 'Quoted Total', key: 'quotedTotal', width: 15 },
    { header: 'Job Date', key: 'jobDate', width: 14 },
    { header: 'Job UUID', key: 'jobUuid', width: 38 },
  ];

  // Bold + frozen header
  ws1.getRow(1).font = { bold: true };
  ws1.getRow(1).alignment = { vertical: 'middle' };
  ws1.views = [{ state: 'frozen', ySplit: 1, xSplit: 0 }];

  for (const row of rows) {
    const dataRow = ws1.addRow(row);
    dataRow.getCell(6).numFmt = '$#,##0.00';
  }

  // Auto-width based on content
  ws1.columns.forEach((col) => {
    if (!col || !col.eachCell) return;
    let maxLen = String(col.header || '').length;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const len = String(cell.value || '').length;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(Math.max(maxLen + 2, 10), 65);
  });

  // ── Sheet 2: Coverage Notes ──
  const ws2 = workbook.addWorksheet('Coverage Notes');
  ws2.columns = [
    { header: 'Metric', key: 'metric', width: 50 },
    { header: 'Value', key: 'value', width: 80 },
  ];
  ws2.getRow(1).font = { bold: true };

  // Status breakdown
  const statusCounts: Record<string, number> = {};
  for (const r of rows) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }

  const notesRows: Array<{ metric: string; value: string }> = [
    { metric: 'Report Run Date', value: TODAY },
    { metric: 'Total Jobmaterial Records Scanned', value: String(totalJobmaterials) },
    { metric: 'Hardscape Jobs Found', value: String(rows.length) },
    { metric: '', value: '' },
    { metric: 'Breakdown by Status', value: '' },
  ];

  for (const status of SCAN_STATUSES) {
    const count = statusCounts[status] || 0;
    if (count > 0) {
      notesRows.push({ metric: `  ${status}`, value: String(count) });
    }
  }

  // Check if overwhelmingly Quote
  const quoteCount = statusCounts['Quote'] || 0;
  if (rows.length > 0 && quoteCount > rows.length * 0.7) {
    notesRows.push({ metric: '', value: '' });
    notesRows.push({
      metric: 'NOTE — Possible Under-Representation',
      value: `${quoteCount} of ${rows.length} hardscape jobs (${Math.round(quoteCount / rows.length * 100)}%) are in Quote status. This likely means converted jobs (Work Order, Completed) lose their line items upon conversion and are under-represented here.`,
    });
  }

  notesRows.push({ metric: '', value: '' });
  notesRows.push({ metric: 'Coverage Check (Step 1b)', value: coverage.summary });
  notesRows.push({
    metric: 'Methodology',
    value: 'Detection is based on matching jobmaterial.material_uuid to catalog items whose item_number starts with "4230". Jobs whose line items were removed during status conversion (Quote → Work Order) will not appear in this report.',
  });

  for (const nr of notesRows) {
    ws2.addRow(nr);
  }

  // Save
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  await workbook.xlsx.writeFile(REPORT_PATH);
  console.log(`Excel report saved: ${REPORT_PATH}`);
}

// ─── Step 4b: Nextcloud upload (best-effort) ──────────────────────────────

async function uploadToNextcloud(): Promise<string | null> {
  const ncUrl = process.env.NEXTCLOUD_URL;
  const ncUser = process.env.NEXTCLOUD_ADMIN_USER;
  const ncPass = process.env.NEXTCLOUD_ADMIN_PASS;
  const webdavUser = 'Goran';

  if (!ncUrl || !ncUser || !ncPass) {
    console.log('Nextcloud credentials not found — skipping upload.');
    return null;
  }

  try {
    const fileBuffer = fs.readFileSync(REPORT_PATH);
    const fileName = path.basename(REPORT_PATH);
    const remotePath = `/Reports/${fileName}`;
    const webdavUrl = `${ncUrl}/remote.php/dav/files/${webdavUser}${remotePath}`;

    // Ensure /Reports folder exists
    try {
      await axios.request({
        method: 'MKCOL',
        url: `${ncUrl}/remote.php/dav/files/${webdavUser}/Reports`,
        auth: { username: ncUser, password: ncPass },
        timeout: 10000,
      });
    } catch {
      // Folder may already exist
    }

    await axios.put(webdavUrl, fileBuffer, {
      auth: { username: ncUser, password: ncPass },
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      timeout: 30000,
    });

    const link = `${ncUrl}/apps/files/?dir=/Reports&openfile=${encodeURIComponent(fileName)}`;
    console.log(`Uploaded to Nextcloud: ${link}`);
    return link;
  } catch (err: any) {
    console.log(`Nextcloud upload failed (best-effort): ${err.message}`);
    return null;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║    HARDSCAPE JOBS REPORT — Canopy Task Agent            ║');
  console.log(`║    ${TODAY}                                        ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  // Step 1a: Load material catalog and identify 4230 items
  const materialMap = await discoverAndLoadMaterials();
  const hardscapeUuids = new Set(materialMap.keys());

  // Fetch all data in parallel (3 bulk fetches)
  console.log('Loading all SM8 data (jobs, jobmaterials, companies)…');
  const [allJobs, allJobmaterials, allCompanies] = await Promise.all([
    sm8Get('/job.json'),
    sm8Get('/jobmaterial.json'),
    sm8Get('/company.json'),
  ]);
  console.log(`  Jobs: ${allJobs.length} | Jobmaterials: ${allJobmaterials.length} | Companies: ${allCompanies.length}\n`);

  // Step 1b: Coverage check
  const coverage = await coverageCheck(hardscapeUuids, allJobs, allJobmaterials);

  // Step 2+3: Build rows
  const rows = await buildHardscapeRows(materialMap, allJobs, allJobmaterials, allCompanies);

  // Step 4: Write Excel
  await writeExcel(rows, coverage, allJobmaterials.length);

  // Step 4b: Nextcloud upload
  const ncLink = await uploadToNextcloud();

  // Step 5: Final report
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║    REPORT COMPLETE                                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`File: ${REPORT_PATH}`);
  if (ncLink) console.log(`Nextcloud: ${ncLink}`);
  console.log(`\nTotal hardscape jobs found: ${rows.length}`);
  console.log('\nBreakdown by status:');
  const statusCounts: Record<string, number> = {};
  for (const r of rows) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }
  for (const status of SCAN_STATUSES) {
    const count = statusCounts[status] || 0;
    if (count > 0) {
      console.log(`  ${status.padEnd(16)} ${count}`);
    }
  }
  console.log(`\nCoverage: ${coverage.summary}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
