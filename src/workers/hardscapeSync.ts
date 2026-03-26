import axios from 'axios';
import cron from 'node-cron';
import { config } from '../config';
import { pool } from '../db/pool';
import { getConfigValue } from '../db/queries';
import { bot } from '../telegram/bot';
import { addProspectComment, updateProspectStage, createProspect } from '../db/hardscapeQueries';
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

const HARDSCAPE_ACCOUNT_CODE = '4230';

// ---------------------------------------------------------------------------
// JOB 1 — Detect new hardscape quotes (top of every hour)
// ---------------------------------------------------------------------------

async function detectNewHardscapeQuotes(): Promise<void> {
  logger.info({ event: 'hardscape_detect_start' });

  try {
    // Fetch all Quote-status jobs from SM8
    const jobsRes = await axios.get(`${SM8_BASE}/job.json`, {
      headers: SM8_HEADERS,
      params: { status: 'Quote' },
      timeout: 15000,
    });
    const allQuotes: Array<{
      uuid: string;
      company_uuid: string;
      generated_job_id?: string;
      job_description?: string;
      date?: string;
    }> = jobsRes.data || [];

    // Filter: created within last 48 hours
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 48);
    const recentQuotes = allQuotes.filter((j) => {
      if (!j.date) return false;
      return new Date(j.date) >= cutoff;
    });

    // Load skip list from config_store
    let skipUuids: string[] = [];
    try {
      const skipJson = await getConfigValue('hardscape_skip_jobs');
      if (skipJson) skipUuids = JSON.parse(skipJson);
    } catch {
      // invalid JSON — treat as empty
    }

    // Load existing prospect UUIDs
    const existingRes = await pool.query(
      'SELECT sm8_job_uuid FROM hardscape_prospects WHERE sm8_job_uuid IS NOT NULL'
    );
    const existingUuids = new Set(existingRes.rows.map((r: { sm8_job_uuid: string }) => r.sm8_job_uuid));

    // Filter to jobs that need checking (not already tracked or skipped)
    const candidates = recentQuotes.filter(
      (j) => !existingUuids.has(j.uuid) && !skipUuids.includes(j.uuid)
    );

    if (candidates.length === 0) {
      logger.info({ event: 'hardscape_detect_complete', quotes_checked: recentQuotes.length, detected: 0 });
      return;
    }

    // Fetch all job materials once and index by job_uuid
    let allMaterials: Array<{ job_uuid: string; name?: string; item_code?: string }> = [];
    try {
      const matRes = await axios.get(`${SM8_BASE}/jobmaterial.json`, {
        headers: SM8_HEADERS,
        timeout: 15000,
      });
      allMaterials = matRes.data || [];
    } catch (err) {
      logger.error({
        event: 'hardscape_detect_materials_error',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const materialsByJob = new Map<string, typeof allMaterials>();
    for (const mat of allMaterials) {
      const list = materialsByJob.get(mat.job_uuid) || [];
      list.push(mat);
      materialsByJob.set(mat.job_uuid, list);
    }

    let detected = 0;

    for (const job of candidates) {
      // Check if any job material has item code 4230
      const jobMats = materialsByJob.get(job.uuid) || [];
      const isHardscape = jobMats.some(
        (m) => m.item_code === HARDSCAPE_ACCOUNT_CODE ||
               (m.name || '').includes(HARDSCAPE_ACCOUNT_CODE)
      );
      if (!isHardscape) continue;

      // Look up company name
      let clientName = 'Unknown Client';
      try {
        const compRes = await axios.get(`${SM8_BASE}/company/${job.company_uuid}.json`, {
          headers: SM8_HEADERS,
          timeout: 10000,
        });
        clientName = compRes.data?.name || clientName;
      } catch {
        // Use default name
      }

      const jobNumber = job.generated_job_id || job.uuid.slice(0, 8);

      try {
        await createProspect({
          sm8_client_uuid: job.company_uuid,
          sm8_client_name: clientName,
          sm8_job_uuid: job.uuid,
          sm8_job_number: jobNumber,
          stage: 'quote_sent',
        });

        await bot.sendMessage(
          GORAN_CHAT_ID,
          `🏗️ Job #${jobNumber} — ${clientName} added to the Hardscape Pipeline.`
        );
        detected++;
        logger.info({ event: 'hardscape_quote_auto_added', job_uuid: job.uuid, client: clientName });
      } catch (err) {
        logger.error({
          event: 'hardscape_detect_add_error',
          job_uuid: job.uuid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({ event: 'hardscape_detect_complete', quotes_checked: recentQuotes.length, detected });
  } catch (err) {
    logger.error({
      event: 'hardscape_detect_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
       AND stage NOT IN ('completed', 'closed_lost')`
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
// JOB 3 — Check SM8 job completion (10 past every hour)
// ---------------------------------------------------------------------------

async function checkJobCompletions(): Promise<void> {
  logger.info({ event: 'hardscape_completion_check_start' });

  try {
    const prospectsRes = await pool.query(
      `SELECT id, sm8_job_uuid, sm8_job_number, sm8_client_name FROM hardscape_prospects
       WHERE stage = 'in_progress' AND sm8_job_uuid IS NOT NULL`
    );
    const prospects: Array<{
      id: number;
      sm8_job_uuid: string;
      sm8_job_number: string | null;
      sm8_client_name: string;
    }> = prospectsRes.rows;

    let completed = 0;

    for (const prospect of prospects) {
      try {
        const jobRes = await axios.get(`${SM8_BASE}/job/${prospect.sm8_job_uuid}.json`, {
          headers: SM8_HEADERS,
          timeout: 10000,
        });
        const job = jobRes.data;

        if (job?.status === 'Completed') {
          // Update prospect stage
          await updateProspectStage(prospect.id, 'completed', new Date());

          // Update crew_schedule
          await pool.query(
            `UPDATE crew_schedule SET status = 'completed', updated_at = NOW()
             WHERE prospect_id = $1`,
            [prospect.id]
          );

          // Add comment
          await addProspectComment({
            prospect_id: prospect.id,
            source: 'agent',
            author: 'Agent',
            content: 'Job completed in SM8 — moved to archive',
          });

          // Notify Goran
          const jobNum = prospect.sm8_job_number || prospect.sm8_job_uuid.slice(0, 8);
          try {
            await bot.sendMessage(
              GORAN_CHAT_ID,
              `✅ Hardscape job #${jobNum} for ${prospect.sm8_client_name} marked complete in SM8.`
            );
          } catch {
            // Notification failure is non-fatal
          }

          completed++;
          logger.info({
            event: 'hardscape_job_completed',
            prospect_id: prospect.id,
            client: prospect.sm8_client_name,
          });
        }
      } catch (err) {
        logger.error({
          event: 'hardscape_completion_check_prospect_error',
          prospect_id: prospect.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({
      event: 'hardscape_completion_check_complete',
      prospects_checked: prospects.length,
      completions_found: completed,
    });
  } catch (err) {
    logger.error({
      event: 'hardscape_completion_check_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Start all cron jobs
// ---------------------------------------------------------------------------

export function startHardscapeSync(): void {
  // Job 1 — detect new hardscape quotes (top of every hour)
  cron.schedule('0 * * * *', () => {
    detectNewHardscapeQuotes().catch((err) =>
      logger.error({ event: 'hardscape_detect_cron_error', error: String(err) })
    );
  }, { timezone: 'America/Chicago' });

  // Job 2 — sync SM8 activities (5 past every hour)
  cron.schedule('5 * * * *', () => {
    syncJobActivities().catch((err) =>
      logger.error({ event: 'hardscape_activity_cron_error', error: String(err) })
    );
  }, { timezone: 'America/Chicago' });

  // Job 3 — check SM8 job completions (10 past every hour)
  cron.schedule('10 * * * *', () => {
    checkJobCompletions().catch((err) =>
      logger.error({ event: 'hardscape_completion_cron_error', error: String(err) })
    );
  }, { timezone: 'America/Chicago' });

  // Run Job 2 immediately on startup to catch missed activity
  syncJobActivities().catch((err) =>
    logger.error({ event: 'hardscape_activity_startup_error', error: String(err) })
  );

  logger.info({ event: 'hardscape_sync_started', jobs: ['detect_quotes@:00', 'sync_activities@:05', 'check_completions@:10'] });
}
