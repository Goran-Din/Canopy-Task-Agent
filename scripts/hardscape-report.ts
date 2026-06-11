/**
 * Hardscape Jobs Report — One-off Excel report generator
 *
 * Uses the shared 3-signal hardscape detection (src/services/hardscapeDetection.ts):
 * a job is a hardscape job if it was created by a configured creator (Marcin),
 * OR its category is a configured hardscape category, OR it has ≥1 line item
 * resolving to a catalog item_number starting "4230". Runs across all jobs,
 * all (scanned) statuses, all-time — no date filter — then writes a formatted
 * Excel workbook with a "Matched By" column and uploads it to Nextcloud.
 *
 * Usage (on the docker agent-network so config_store / canopy-agent-db resolves;
 * detection still works on the host — config_store reads just fall back to the
 * built-in creator/category defaults):
 *   docker run --rm --network canopy-task-agent_agent-network \
 *     -v "$PWD":/app -w /app --env-file .env \
 *     node:20 npx ts-node scripts/hardscape-report.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import axios from 'axios';
import ExcelJS from 'exceljs';
import fs from 'fs';

import { detectHardscapeJobs, DetectedHardscapeJob, MatchSignal } from '../src/services/hardscapeDetection';
import { pool } from '../src/db/pool';

// ─── Constants ─────────────────────────────────────────────────────────────

const SCAN_STATUSES = ['Quote', 'Work Order', 'In Progress', 'Invoice', 'Completed', 'Unsuccessful'];

const TODAY = new Date().toISOString().split('T')[0];
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');
const REPORT_PATH = path.join(REPORT_DIR, `Hardscape-Jobs-Report-${TODAY}.xlsx`);

// ─── Row shape ─────────────────────────────────────────────────────────────

interface HardscapeJobRow {
  jobId: string;
  customerName: string;
  scopeSummary: string;
  status: string;
  hardscapeItems: string;
  quotedTotal: number | null; // null → blank cell (creator/category-only jobs)
  jobDate: string;
  jobUuid: string;
  matchedBy: string; // "creator + category" etc.
}

/** Stable, readable label for a matched_by signal set. */
function formatMatchedBy(signals: MatchSignal[]): string {
  const order: MatchSignal[] = ['creator', 'category', 'itemcode'];
  return order.filter((s) => signals.includes(s)).join(' + ');
}

function buildRows(jobs: DetectedHardscapeJob[]): HardscapeJobRow[] {
  const rows: HardscapeJobRow[] = jobs.map((j) => ({
    jobId: j.sm8_job_number,
    customerName: j.sm8_client_name,
    scopeSummary: j.scope_summary,
    status: j.sm8_status,
    hardscapeItems: j.hardscape_items,
    // Only itemcode jobs carry a meaningful quoted total; others stay blank.
    quotedTotal: j.matched_by.includes('itemcode') ? j.quoted_total : null,
    jobDate: j.job_date,
    jobUuid: j.sm8_job_uuid,
    matchedBy: formatMatchedBy(j.matched_by),
  }));

  // Sort by Status then Job Date (newest first) — unchanged from prior report.
  const statusOrder: Record<string, number> = {
    Quote: 1, 'Work Order': 2, 'In Progress': 3, Invoice: 4, Completed: 5, Unsuccessful: 6,
  };
  rows.sort((a, b) => {
    const sa = statusOrder[a.status] || 99;
    const sb = statusOrder[b.status] || 99;
    if (sa !== sb) return sa - sb;
    return (b.jobDate || '').localeCompare(a.jobDate || '');
  });

  return rows;
}

// ─── Write Excel ─────────────────────────────────────────────────────────────

interface Breakdown {
  total: number;
  byMatchedBy: Record<string, number>;
  byStatus: Record<string, number>;
  missedByOld: number; // matched by creator/category but NOT itemcode
}

function computeBreakdown(rows: HardscapeJobRow[]): Breakdown {
  const byMatchedBy: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let missedByOld = 0;
  for (const r of rows) {
    byMatchedBy[r.matchedBy] = (byMatchedBy[r.matchedBy] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (!r.matchedBy.split(' + ').includes('itemcode')) missedByOld++;
  }
  return { total: rows.length, byMatchedBy, byStatus, missedByOld };
}

async function writeExcel(rows: HardscapeJobRow[], breakdown: Breakdown): Promise<void> {
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
    { header: 'Matched By', key: 'matchedBy', width: 22 },
  ];
  ws1.getRow(1).font = { bold: true };
  ws1.getRow(1).alignment = { vertical: 'middle' };
  ws1.views = [{ state: 'frozen', ySplit: 1, xSplit: 0 }];

  for (const row of rows) {
    const dataRow = ws1.addRow({
      ...row,
      quotedTotal: row.quotedTotal === null ? '' : row.quotedTotal,
    });
    if (row.quotedTotal !== null) dataRow.getCell(6).numFmt = '$#,##0.00';
  }

  // Auto-width based on content
  ws1.columns.forEach((col) => {
    if (!col || !col.eachCell) return;
    let maxLen = String(col.header || '').length;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? '').length;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(Math.max(maxLen + 2, 10), 65);
  });

  // ── Sheet 2: Summary ──
  const ws2 = workbook.addWorksheet('Summary');
  ws2.columns = [
    { header: 'Metric', key: 'metric', width: 52 },
    { header: 'Value', key: 'value', width: 90 },
  ];
  ws2.getRow(1).font = { bold: true };

  const notes: Array<{ metric: string; value: string }> = [
    { metric: 'Report Run Date', value: TODAY },
    { metric: 'Detection Rule', value: 'created_by Marcin OR category "Hardscape Projects" OR ≥1 line item with item_number starting "4230" (OR, not AND)' },
    { metric: 'Hardscape Jobs Found', value: String(breakdown.total) },
    { metric: '', value: '' },
    { metric: 'Breakdown by Matched By', value: '' },
  ];
  for (const [key, count] of Object.entries(breakdown.byMatchedBy).sort((a, b) => b[1] - a[1])) {
    notes.push({ metric: `  ${key}`, value: String(count) });
  }
  notes.push({ metric: '', value: '' });
  notes.push({ metric: 'Breakdown by Status', value: '' });
  for (const status of SCAN_STATUSES) {
    const count = breakdown.byStatus[status] || 0;
    if (count > 0) notes.push({ metric: `  ${status}`, value: String(count) });
  }
  notes.push({ metric: '', value: '' });
  notes.push({
    metric: 'Caught by creator/category but NOT by 4230',
    value: `${breakdown.missedByOld}  (jobs the old item-code-only detection would have MISSED)`,
  });
  notes.push({ metric: '', value: '' });
  notes.push({
    metric: 'Methodology',
    value:
      'Signals A (creator) and B (category) read /job.json fields that persist through the entire ' +
      'Quote → Work Order → Completed lifecycle, so converted jobs that have lost their line items are ' +
      'still captured. Signal C (item code) resolves jobmaterial.material_uuid → /material.item_number and ' +
      'mainly fires on Quotes. Jobs matched only by creator/category have no 4230 line items, so their ' +
      'Scope Summary, Hardscape Items, and Quoted Total are intentionally blank.',
  });

  for (const nr of notes) ws2.addRow(nr);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  await workbook.xlsx.writeFile(REPORT_PATH);
  console.log(`Excel report saved: ${REPORT_PATH}`);
}

// ─── Nextcloud upload (best-effort) ────────────────────────────────────────

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
  console.log('║    HARDSCAPE JOBS REPORT (3-signal) — Canopy Task Agent   ║');
  console.log(`║    ${TODAY}                                            ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log('Detecting hardscape jobs (creator OR category OR 4230 item code)…');
  const jobs = await detectHardscapeJobs();
  const rows = buildRows(jobs);
  const breakdown = computeBreakdown(rows);
  console.log(`Detected ${rows.length} hardscape jobs.\n`);

  await writeExcel(rows, breakdown);
  const ncLink = await uploadToNextcloud();

  // ── Final console summary ──
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║    REPORT COMPLETE                                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`File: ${REPORT_PATH}`);
  if (ncLink) console.log(`Nextcloud: ${ncLink}`);

  console.log(`\nTotal hardscape jobs found: ${breakdown.total}`);

  console.log('\nBreakdown by Matched By:');
  for (const [key, count] of Object.entries(breakdown.byMatchedBy).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(26)} ${count}`);
  }

  console.log('\nBreakdown by Status:');
  for (const status of SCAN_STATUSES) {
    const count = breakdown.byStatus[status] || 0;
    if (count > 0) console.log(`  ${status.padEnd(16)} ${count}`);
  }

  console.log(
    `\nCaught by creator OR category but NOT by 4230 (old detection would have MISSED): ${breakdown.missedByOld}`
  );
}

main()
  .then(async () => {
    await pool.end().catch(() => undefined);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('FATAL:', err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
