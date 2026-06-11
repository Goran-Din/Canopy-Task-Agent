import axios from 'axios';
import cron from 'node-cron';
import { config } from '../config';
import { pool } from '../db/pool';
import { getConfigValue, setConfigValue } from '../db/queries';
import { bot } from '../telegram/bot';
import { addProspectComment, upsertDetectedProspect } from '../db/hardscapeQueries';
import { detectHardscapeJobs, stageForStatus } from '../services/hardscapeDetection';
import logger from '../logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SM8_BASE = config.servicem8.baseUrl;
const SM8_HEADERS = {
  'X-API-Key': config.servicem8.apiKey,
  'Accept': 'application/json',
};

const GORAN_CHAT_ID = 1996235953;

// ---------------------------------------------------------------------------
// JOB 1 — One-way SM8 → dashboard pull of hardscape jobs (every 2 hours).
//   • READS from ServiceM8 and writes only to hardscape_prospects — it never
//     calls any ServiceM8 write endpoint.
//   • Refresh SM8 reference fields (client name, SM8 status, address) for every
//     prospect linked to a detected job; scope/quoted total refresh ONLY while
//     their is_manual flag is false (see upsertDetectedProspect). Stage, crew,
//     assigned_to, notes, design #, hidden flags, GDrive + the date fields are
//     NEVER touched — those are manually controlled.
//   • Auto-create a prospect for any new 4230 job that isn't tracked yet,
//     setting the initial stage from the SM8 status (skip-list honoured).
// ---------------------------------------------------------------------------

export interface HardscapeSyncSummary {
  added: number;
  refreshed: number;
  total: number;
  ranAt: string;   // ISO timestamp of completion
}

// Single-instance lock shared by the manual endpoint and the 2-hour cron, so
// only one pull runs at a time (manual OR cron).
let syncRunning = false;

export function isHardscapeSyncRunning(): boolean {
  return syncRunning;
}

/**
 * Run the one-way SM8 → dashboard pull behind the single-instance lock. Returns
 * the run summary, or { alreadyRunning: true } when a pull is already in flight.
 * Invoked by BOTH the 2-hour cron and POST /dashboard/sync — never starts a
 * second concurrent sync. This is read-only against ServiceM8 (no SM8 writes).
 */
export async function runHardscapeSync(): Promise<HardscapeSyncSummary | { alreadyRunning: true }> {
  if (syncRunning) {
    logger.info({ event: 'hardscape_sync_skipped_locked' });
    return { alreadyRunning: true };
  }
  syncRunning = true;
  try {
    return await syncHardscapeJobs();
  } finally {
    syncRunning = false;
  }
}

async function syncHardscapeJobs(): Promise<HardscapeSyncSummary> {
  logger.info({ event: 'hardscape_sync_jobs_start' });

  const jobs = await detectHardscapeJobs();

  // Skip list: jobs the user explicitly excluded from auto-add.
  let skipUuids: string[] = [];
  try {
    const skipJson = await getConfigValue('hardscape_skip_jobs');
    if (skipJson) skipUuids = JSON.parse(skipJson);
  } catch {
    // invalid JSON — treat as empty
  }

  // Which job UUIDs already exist as prospects?
  const existingRes = await pool.query(
    'SELECT sm8_job_uuid FROM hardscape_prospects WHERE sm8_job_uuid IS NOT NULL'
  );
  const existingUuids = new Set(
    existingRes.rows.map((r: { sm8_job_uuid: string }) => r.sm8_job_uuid)
  );

  let created = 0;
  let refreshed = 0;

  for (const job of jobs) {
    const isNew = !existingUuids.has(job.sm8_job_uuid);

    // Never auto-create a job the user chose to skip. Existing prospects are
    // always refreshed (data fields only), regardless of the skip list.
    if (isNew && skipUuids.includes(job.sm8_job_uuid)) continue;

    try {
      const result = await upsertDetectedProspect(job, stageForStatus(job.sm8_status));
      if (result === 'inserted') {
        created++;
        try {
          await bot.sendMessage(
            GORAN_CHAT_ID,
            `🏗️ Job #${job.sm8_job_number} — ${job.sm8_client_name} added to the Hardscape Pipeline.`
          );
        } catch {
          // notification failure is non-fatal
        }
        logger.info({
          event: 'hardscape_prospect_auto_added',
          job_uuid: job.sm8_job_uuid,
          client: job.sm8_client_name,
        });
      } else {
        refreshed++;
      }
    } catch (err) {
      logger.error({
        event: 'hardscape_sync_job_error',
        job_uuid: job.sm8_job_uuid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info({ event: 'hardscape_sync_jobs_complete', detected: jobs.length, created, refreshed });

  const summary: HardscapeSyncSummary = {
    added: created,
    refreshed,
    total: jobs.length,
    ranAt: new Date().toISOString(),
  };

  // Record the result for the dashboard's "last synced" display (every run —
  // manual and cron). Non-fatal if the write fails.
  try {
    await setConfigValue('hardscape_last_sync', JSON.stringify(summary));
  } catch (err) {
    logger.error({
      event: 'hardscape_last_sync_write_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return summary;
}

// ---------------------------------------------------------------------------
// JOB 2 — Pull SM8 job activity / comment sync (5 past every hour)
// ---------------------------------------------------------------------------

async function syncJobActivities(): Promise<void> {
  logger.info({ event: 'hardscape_activity_sync_start' });

  try {
    // Get active prospects with SM8 job links
    const prospectsRes = await pool.query(
      `SELECT id, sm8_job_uuid, sm8_client_name FROM hardscape_prospects
       WHERE sm8_job_uuid IS NOT NULL
       AND stage NOT IN ('completed', 'lost_opportunity')`
    );
    const prospects: Array<{ id: number; sm8_job_uuid: string; sm8_client_name: string }> = prospectsRes.rows;

    let totalSynced = 0;

    for (const prospect of prospects) {
      try {
        const actRes = await axios.get(`${SM8_BASE}/jobactivity.json`, {
          headers: SM8_HEADERS,
          params: { job_uuid: prospect.sm8_job_uuid },
          timeout: 10000,
        });
        const activities: Array<{
          uuid: string;
          note?: string;
          type?: string;
          staff_name?: string;
          date?: string;
        }> = actRes.data || [];

        for (const act of activities) {
          // Check if already synced
          const exists = await pool.query(
            'SELECT 1 FROM prospect_comments WHERE sm8_activity_uuid = $1',
            [act.uuid]
          );
          if (exists.rows.length > 0) continue;

          const content = act.note && act.note.trim()
            ? act.note.trim()
            : `${act.type || 'Activity'} — ${act.staff_name || 'Unknown'}`;

          await addProspectComment({
            prospect_id: prospect.id,
            source: 'sm8_sync',
            author: 'SM8',
            content,
            sm8_activity_uuid: act.uuid,
            editable: false,
            activity_date: act.date ? new Date(act.date) : new Date(),
          });
          totalSynced++;
        }

        // Mark prospect as synced
        await pool.query(
          'UPDATE hardscape_prospects SET sm8_last_synced = NOW() WHERE id = $1',
          [prospect.id]
        );
      } catch (err) {
        logger.error({
          event: 'hardscape_activity_sync_prospect_error',
          prospect_id: prospect.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({
      event: 'hardscape_activity_sync_complete',
      prospects_checked: prospects.length,
      activities_synced: totalSynced,
    });
  } catch (err) {
    logger.error({
      event: 'hardscape_activity_sync_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// NOTE: SM8 job-completion auto-advance removed (Stage 1 CRM migration).
// The pipeline stage is now manually controlled — ServiceM8 job status must
// never overwrite it. Activity → comment sync (Job 2) remains intact.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Start all cron jobs
// ---------------------------------------------------------------------------

export function startHardscapeSync(): void {
  // Job 1 — one-way SM8 → dashboard pull: refresh SM8 reference fields + auto-create
  // new jobs. Runs every 2 hours (at :00). Reads from ServiceM8 only; never writes back.
  cron.schedule('0 */2 * * *', () => {
    runHardscapeSync().catch((err) =>
      logger.error({ event: 'hardscape_sync_jobs_cron_error', error: String(err) })
    );
  }, { timezone: 'America/Chicago' });

  // Job 2 — sync SM8 activities (5 past every hour)
  cron.schedule('5 * * * *', () => {
    syncJobActivities().catch((err) =>
      logger.error({ event: 'hardscape_activity_cron_error', error: String(err) })
    );
  }, { timezone: 'America/Chicago' });

  // Run Job 2 immediately on startup to catch missed activity
  syncJobActivities().catch((err) =>
    logger.error({ event: 'hardscape_activity_startup_error', error: String(err) })
  );

  logger.info({ event: 'hardscape_sync_started', jobs: ['sync_jobs@every-2h', 'sync_activities@:05'] });
}
