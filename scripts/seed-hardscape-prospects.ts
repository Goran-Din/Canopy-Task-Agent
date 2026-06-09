/**
 * Seed hardscape_prospects from the current ServiceM8 hardscape jobs.
 *
 * One-off, idempotent. Detection is shared with the sync worker
 * (src/services/hardscapeDetection.ts) and uses the same 4230 catalog match as
 * scripts/hardscape-report.ts. Dedupe is keyed on sm8_job_uuid:
 *   - NEW job  → insert with stage mapped from SM8 status.
 *   - KNOWN job → refresh data fields only (name, scope, quoted total, status);
 *                 stage / crew / assigned_to / notes are left untouched.
 *
 * Usage (on the docker agent-network so canopy-agent-db resolves):
 *   docker run --rm --network canopy-task-agent_agent-network \
 *     -v "$PWD":/app -w /app --env-file .env \
 *     node:20 npx ts-node scripts/seed-hardscape-prospects.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { pool } from '../src/db/pool';
import { detectHardscapeJobs, stageForStatus } from '../src/services/hardscapeDetection';
import { upsertDetectedProspect } from '../src/db/hardscapeQueries';

async function main(): Promise<void> {
  console.log('Detecting current hardscape jobs from ServiceM8…');
  const jobs = await detectHardscapeJobs();
  console.log(`Detected ${jobs.length} hardscape jobs.\n`);

  let inserted = 0;
  let updated = 0;
  const statusCounts: Record<string, number> = {};

  for (const job of jobs) {
    statusCounts[job.sm8_status] = (statusCounts[job.sm8_status] || 0) + 1;
    try {
      const result = await upsertDetectedProspect(job, stageForStatus(job.sm8_status));
      if (result === 'inserted') {
        inserted++;
        console.log(`  + INSERT  #${job.sm8_job_number.padEnd(8)} ${job.sm8_status.padEnd(12)} → ${stageForStatus(job.sm8_status).padEnd(18)} ${job.sm8_client_name}`);
      } else {
        updated++;
        console.log(`  ~ refresh #${job.sm8_job_number.padEnd(8)} ${job.sm8_status.padEnd(12)} (stage unchanged)        ${job.sm8_client_name}`);
      }
    } catch (err) {
      console.error(`  ! FAILED  #${job.sm8_job_number} ${job.sm8_client_name}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log('\nSM8 status breakdown of detected jobs:');
  for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(14)} ${count}`);
  }

  console.log(`\nSeed complete: ${inserted} inserted, ${updated} refreshed, ${jobs.length} detected.`);

  const finalCounts = await pool.query(
    'SELECT stage, COUNT(*) FROM hardscape_prospects GROUP BY stage ORDER BY COUNT(*) DESC'
  );
  console.log('\nProspect counts by stage:');
  for (const row of finalCounts.rows) {
    console.log(`  ${String(row.stage).padEnd(20)} ${row.count}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
