/**
 * One-off backfill: populate hardscape_prospects.job_address from the SM8 job
 * record for EVERY prospect that has an sm8_job_uuid — including prospects that
 * the 4230 detection no longer surfaces (e.g. jobs whose line items changed).
 * Prospects with no linked SM8 job are left blank.
 *
 * Read-only with respect to everything else: it writes ONLY job_address.
 *
 * Usage (on the docker agent-network so canopy-agent-db resolves):
 *   docker run --rm --network canopy-task-agent_agent-network \
 *     -v "$PWD":/app -w /app --env-file .env \
 *     node:20 npx ts-node --transpile-only scripts/backfill-job-address.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import axios from 'axios';
import { pool } from '../src/db/pool';
import { config } from '../src/config';

const sm8 = axios.create({
  baseURL: config.servicem8.baseUrl,
  headers: { 'X-API-Key': config.servicem8.apiKey, Accept: 'application/json' },
  timeout: 20000,
});

function normalizeAddress(raw: string): string {
  return (raw || '')
    .replace(/\s*\n+\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, sm8_job_uuid, sm8_client_name
     FROM hardscape_prospects
     WHERE sm8_job_uuid IS NOT NULL
     ORDER BY id`
  );
  console.log(`Backfilling job_address for ${rows.length} linked prospects…`);

  let updated = 0;
  let blank = 0;
  let failed = 0;

  for (const r of rows) {
    try {
      const res = await sm8.get(`/job/${r.sm8_job_uuid}.json`);
      const address = normalizeAddress(res.data?.job_address || '');
      await pool.query(
        'UPDATE hardscape_prospects SET job_address = $1, updated_at = NOW() WHERE id = $2',
        [address || null, r.id]
      );
      if (address) {
        updated++;
        console.log(`  ✓ #${r.id} ${r.sm8_client_name} → ${address}`);
      } else {
        blank++;
        console.log(`  · #${r.id} ${r.sm8_client_name} → (no address on job)`);
      }
    } catch (err) {
      failed++;
      console.error(`  ! #${r.id} ${r.sm8_client_name}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\nDone: ${updated} with address, ${blank} blank, ${failed} failed.`);
  await pool.end();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
