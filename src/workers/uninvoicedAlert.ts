import axios from 'axios';
import cron from 'node-cron';
import { config } from '../config';
import { pool } from '../db/pool';
import { bot } from '../telegram/bot';
import logger from '../logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SM8_BASE = config.servicem8.baseUrl;
const SM8_HEADERS = {
  'X-API-Key': config.servicem8.apiKey,
  'Accept': 'application/json',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SM8Job {
  uuid: string;
  generated_job_id: string;
  company_uuid: string;
  status: string;
  date: string;
  completion_date?: string;
  job_description: string;
  active: number;
}

interface SM8Company {
  uuid: string;
  name: string;
}

interface SM8StaffAllocation {
  staff_uuid: string;
  start_time: string;
}

interface UninvoicedJob {
  job_uuid: string;
  job_number: string;
  client_name: string;
  description: string;
  crew_label: string;
  lead_name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return YYYY-MM-DD for yesterday in America/Chicago */
function getYesterdayCT(): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  const parts = yesterday.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Chicago',
  }).split('/');
  // MM/DD/YYYY → YYYY-MM-DD
  return `${parts[2]}-${parts[0]}-${parts[1]}`;
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
// Core detection logic
// ---------------------------------------------------------------------------

export async function checkUninvoicedJobsNow(): Promise<void> {
  try {
    logger.info({ event: 'uninvoiced_check_start' });

    const yesterday = getYesterdayCT();

    // 1. Fetch all active SM8 jobs
    let allJobs: SM8Job[];
    try {
      const res = await axios.get(`${SM8_BASE}/job.json`, {
        headers: SM8_HEADERS,
        timeout: 30000,
      });
      allJobs = res.data || [];
    } catch (err) {
      logger.error({
        event: 'uninvoiced_check_sm8_error',
        error: err instanceof Error ? err.message : String(err),
      });
      return; // Do NOT send partial alerts
    }

    // 2. Filter for jobs completed yesterday
    const completedYesterday = allJobs.filter((j) => {
      const isCompletedStatus = j.status === 'Completed' || j.status === 'Invoice';
      const completionDate = j.completion_date || j.date || '';
      return isCompletedStatus && completionDate.startsWith(yesterday);
    });

    logger.info({
      event: 'uninvoiced_check_completed_jobs',
      yesterday,
      count: completedYesterday.length,
    });

    if (completedYesterday.length === 0) {
      logger.info({ event: 'uninvoiced_check_no_completions', yesterday });
      return;
    }

    // 3. Cross-reference with invoice_cache
    const uninvoicedJobs: UninvoicedJob[] = [];
    const companyCache: Record<string, string> = {};

    // Load crew lead UUID mappings from config_store
    let leadRows: { key: string; value: string }[] = [];
    try {
      const leadRes = await pool.query(
        "SELECT key, value FROM config_store WHERE key LIKE '%_lead_uuid'"
      );
      leadRows = leadRes.rows;
    } catch (err) {
      logger.warn({
        event: 'uninvoiced_check_lead_lookup_error',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Build reverse map: staff_uuid → crew label (e.g. "LP#1", "HP#2")
    const uuidToCrewLabel: Record<string, string> = {};
    for (const row of leadRows) {
      // key format: lp1_lead_uuid → LP#1, hp2_lead_uuid → HP#2
      const match = row.key.match(/^([a-z]{2})(\d+)_lead_uuid$/);
      if (match) {
        const prefix = match[1].toUpperCase();
        const num = match[2];
        uuidToCrewLabel[row.value] = `${prefix}#${num}`;
      }
    }

    // Fetch staff names for lead display
    let staffNameMap: Record<string, string> = {};
    try {
      const staffRes = await axios.get(`${SM8_BASE}/staff.json`, {
        headers: SM8_HEADERS,
        timeout: 15000,
      });
      for (const s of staffRes.data || []) {
        staffNameMap[s.uuid] = s.first || '';
      }
    } catch {
      // Non-fatal — crew labels will still work
    }

    for (const job of completedYesterday) {
      try {
        // Check invoice_cache
        const cacheRes = await pool.query(
          'SELECT invoice_status FROM invoice_cache WHERE sm8_job_uuid = $1',
          [job.uuid]
        );
        const cached = cacheRes.rows[0];
        if (cached && cached.invoice_status !== 'not_invoiced') {
          continue; // Already invoiced/paid/overdue — skip
        }

        // Resolve client name
        if (!companyCache[job.company_uuid]) {
          const company = await fetchSM8Company(job.company_uuid);
          companyCache[job.company_uuid] = company?.name || 'Unknown Client';
        }
        const clientName = companyCache[job.company_uuid];

        // Determine crew label
        let crewLabel = 'Unknown Crew';
        let leadName = '';
        try {
          const allocRes = await axios.get(`${SM8_BASE}/jobstaffallocation.json`, {
            headers: SM8_HEADERS,
            params: { job_uuid: job.uuid },
            timeout: 10000,
          });
          const allocations: SM8StaffAllocation[] = allocRes.data || [];
          if (allocations.length > 0) {
            allocations.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
            const firstStaffUuid = allocations[0].staff_uuid;
            const label = uuidToCrewLabel[firstStaffUuid];
            if (label) {
              crewLabel = label;
              leadName = staffNameMap[firstStaffUuid] || '';
            }
          }
        } catch {
          // Non-fatal — use Unknown Crew
        }

        uninvoicedJobs.push({
          job_uuid: job.uuid,
          job_number: job.generated_job_id || '',
          client_name: clientName,
          description: job.job_description || '',
          crew_label: crewLabel,
          lead_name: leadName,
        });
      } catch (err) {
        logger.warn({
          event: 'uninvoiced_check_job_error',
          job_uuid: job.uuid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({
      event: 'uninvoiced_check_results',
      completed_yesterday: completedYesterday.length,
      uninvoiced: uninvoicedJobs.length,
    });

    if (uninvoicedJobs.length === 0) {
      logger.info({ event: 'uninvoiced_check_all_invoiced' });
      return;
    }

    // 4. Build alert messages
    const recipientEnv = process.env.UNINVOICED_ALERT_RECIPIENTS || '';
    const recipients = recipientEnv.split(',').map((s) => s.trim()).filter(Boolean);

    if (recipients.length === 0) {
      logger.warn({ event: 'uninvoiced_check_no_recipients' });
      return;
    }

    let messages: string[];

    if (uninvoicedJobs.length <= 2) {
      // One message per job
      messages = uninvoicedJobs.map((j) => {
        const crewPart = j.lead_name
          ? `${j.crew_label} ${j.lead_name}`
          : j.crew_label;
        return (
          `⚠️ Uninvoiced job detected — ${crewPart} completed ${j.client_name} ${j.description} ` +
          `yesterday (Job #${j.job_number}). No invoice found in Xero. Please invoice now.`
        );
      });
    } else {
      // One summary message
      const jobLines = uninvoicedJobs.map((j) =>
        `${j.crew_label} — ${j.client_name} ${j.description} (Job #${j.job_number})`
      );
      const summary =
        `⚠️ ${uninvoicedJobs.length} uninvoiced jobs from yesterday:\n\n` +
        jobLines.join('\n') +
        '\n\nPlease invoice each one in ServiceM8 and push to Xero.';
      messages = [summary];
    }

    // 5. Send to all recipients
    let sentCount = 0;
    for (const chatId of recipients) {
      for (const msg of messages) {
        try {
          await bot.sendMessage(chatId, msg);
          sentCount++;
        } catch (err) {
          logger.error({
            event: 'uninvoiced_alert_send_error',
            recipient: chatId,
            error: err instanceof Error ? err.message : String(err),
          });
          // Continue sending to remaining recipients
        }
      }
    }

    logger.info({
      event: 'uninvoiced_alert_sent',
      uninvoiced_jobs: uninvoicedJobs.length,
      recipients: recipients.length,
      messages_sent: sentCount,
    });
  } catch (err) {
    logger.error({
      event: 'uninvoiced_check_error',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function startUninvoicedAlert(): void {
  logger.info({ event: 'uninvoiced_alert_init' });

  // 6:30 AM CT daily
  cron.schedule('30 6 * * *', () => {
    checkUninvoicedJobsNow();
  }, { timezone: 'America/Chicago' });

  logger.info({ event: 'uninvoiced_alert_scheduled', time: '6:30 AM CT' });
}
