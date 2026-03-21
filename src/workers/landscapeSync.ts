import axios from 'axios';
import cron from 'node-cron';
import { config } from '../config';
import { getConfigValue } from '../db/queries';
import { pool } from '../db/pool';
import { bot } from '../telegram/bot';
import logger from '../logger';
import { LandscapeCrewSchedule, LandscapeJobCard, LandscapeCrewId } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CREW_IDS: LandscapeCrewId[] = ['lp1', 'lp2', 'lp3', 'lp4'];

const CREW_COLORS: Record<LandscapeCrewId, string> = {
  lp1: '#2563EB',
  lp2: '#EAB308',
  lp3: '#EA580C',
  lp4: '#9333EA',
};

const ALERT_RECIPIENTS = [8049966920, 5028364135, 1996235953]; // Erick, Mark, Goran

const SM8_BASE = config.servicem8.baseUrl;
const SM8_HEADERS = {
  'X-API-Key': config.servicem8.apiKey,
  'Accept': 'application/json',
};

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface ScheduleCache {
  today: LandscapeCrewSchedule[];
  tomorrow: LandscapeCrewSchedule[];
  lastSync: string | null;
}

let scheduleCache: ScheduleCache = {
  today: [],
  tomorrow: [],
  lastSync: null,
};

export function getScheduleCache(): ScheduleCache {
  return scheduleCache;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return YYYY-MM-DD for today and tomorrow in America/Chicago */
function getDatesCT(): { todayStr: string; tomorrowStr: string; todayLabel: string; tomorrowLabel: string } {
  const now = new Date();
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    d.toLocaleDateString('en-US', { ...opts, timeZone: 'America/Chicago' });

  const todayStr = fmt(now, { year: 'numeric', month: '2-digit', day: '2-digit' })
    .split('/').map((p, i) => i === 2 ? p : p.padStart(2, '0')).join('/');
  // Convert MM/DD/YYYY → YYYY-MM-DD
  const [tM, tD, tY] = todayStr.split('/');
  const todayISO = `${tY}-${tM}-${tD}`;

  const tom = new Date(now.getTime() + 86400000);
  const tomStr = fmt(tom, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const [toM, toD, toY] = tomStr.split('/');
  const tomorrowISO = `${toY}-${toM}-${toD}`;

  const todayLabel = fmt(now, { weekday: 'long', month: 'long', day: 'numeric' });
  const tomorrowLabel = fmt(tom, { weekday: 'long', month: 'long', day: 'numeric' });

  return { todayStr: todayISO, tomorrowStr: tomorrowISO, todayLabel, tomorrowLabel };
}

function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    });
  } catch {
    return dateStr;
  }
}

// ---------------------------------------------------------------------------
// SM8 data fetchers
// ---------------------------------------------------------------------------

interface SM8Job {
  uuid: string;
  generated_job_id: string;
  company_uuid: string;
  status: string;
  job_description: string;
  date: string;
  job_address: string;
  total_estimate_hours?: number;
}

interface SM8StaffAllocation {
  uuid: string;
  job_uuid: string;
  staff_uuid: string;
  start_time: string;
}

interface SM8Staff {
  uuid: string;
  first: string;
  last: string;
  active: number;
}

interface SM8Company {
  uuid: string;
  name: string;
}

async function fetchAllActiveJobs(): Promise<SM8Job[]> {
  const res = await axios.get(`${SM8_BASE}/job.json`, { headers: SM8_HEADERS, timeout: 30000 });
  return res.data || [];
}

async function fetchStaffAllocations(jobUuid: string): Promise<SM8StaffAllocation[]> {
  const res = await axios.get(`${SM8_BASE}/jobstaffallocation.json`, {
    headers: SM8_HEADERS,
    params: { job_uuid: jobUuid },
    timeout: 15000,
  });
  return res.data || [];
}

async function fetchAllStaff(): Promise<SM8Staff[]> {
  const res = await axios.get(`${SM8_BASE}/staff.json`, { headers: SM8_HEADERS, timeout: 15000 });
  return res.data || [];
}

async function fetchCompany(companyUuid: string): Promise<SM8Company | null> {
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
// Core sync logic
// ---------------------------------------------------------------------------

async function syncSchedule(): Promise<void> {
  try {
    logger.info({ event: 'landscape_sync_start' });

    // 1. Load crew lead UUIDs from config_store
    const leadUuids: Record<LandscapeCrewId, string> = { lp1: '', lp2: '', lp3: '', lp4: '' };
    for (const crewId of CREW_IDS) {
      const val = await getConfigValue(`${crewId}_lead_uuid`);
      if (!val) {
        logger.warn({ event: 'landscape_sync_missing_lead', crew: crewId });
        continue;
      }
      leadUuids[crewId] = val;
    }

    // Build reverse lookup: staff_uuid → crew_id
    const uuidToCrewId: Record<string, LandscapeCrewId> = {};
    for (const crewId of CREW_IDS) {
      if (leadUuids[crewId]) {
        uuidToCrewId[leadUuids[crewId]] = crewId;
      }
    }

    // 2. Fetch all staff to build name lookup
    const allStaff = await fetchAllStaff();
    const staffNameMap: Record<string, string> = {};
    for (const s of allStaff) {
      staffNameMap[s.uuid] = s.first;
    }

    // 3. Get lead display names from staff data
    const leadNames: Record<LandscapeCrewId, string> = { lp1: '', lp2: '', lp3: '', lp4: '' };
    for (const crewId of CREW_IDS) {
      leadNames[crewId] = staffNameMap[leadUuids[crewId]] || crewId.toUpperCase();
    }

    // 4. Fetch all active jobs and filter for today/tomorrow + correct statuses
    const { todayStr, tomorrowStr } = getDatesCT();
    const allJobs = await fetchAllActiveJobs();
    const relevantJobs = allJobs.filter(
      (j) =>
        (j.date === todayStr || j.date === tomorrowStr) &&
        (j.status === 'Work Order' || j.status === 'In Progress')
    );

    logger.info({
      event: 'landscape_sync_jobs_filtered',
      total_jobs: allJobs.length,
      relevant_jobs: relevantJobs.length,
      today: todayStr,
      tomorrow: tomorrowStr,
    });

    // 5. For each relevant job, fetch staff allocations and determine crew
    const companyCache: Record<string, string> = {};
    const todayCrewJobs: Record<LandscapeCrewId, LandscapeJobCard[]> = { lp1: [], lp2: [], lp3: [], lp4: [] };
    const tomorrowCrewJobs: Record<LandscapeCrewId, LandscapeJobCard[]> = { lp1: [], lp2: [], lp3: [], lp4: [] };

    for (const job of relevantJobs) {
      try {
        const allocations = await fetchStaffAllocations(job.uuid);
        if (allocations.length === 0) continue;

        // Sort by start_time ascending — first staff determines crew
        allocations.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
        const firstStaffUuid = allocations[0].staff_uuid;
        const crewId = uuidToCrewId[firstStaffUuid];
        if (!crewId) continue; // Not one of the 4 LP crew leads

        // Resolve client name
        if (!companyCache[job.company_uuid]) {
          const company = await fetchCompany(job.company_uuid);
          companyCache[job.company_uuid] = company?.name || 'Unknown Client';
        }
        const clientName = companyCache[job.company_uuid];

        // Build employees list
        const employees = allocations.map((a) => ({
          uuid: a.staff_uuid,
          name: staffNameMap[a.staff_uuid] || 'Unknown',
          is_lead: a.staff_uuid === leadUuids[crewId],
        }));

        // Fetch comment from job_comments table
        let comment: string | null = null;
        try {
          const commentRes = await pool.query(
            'SELECT comment_text FROM job_comments WHERE sm8_job_uuid = $1',
            [job.uuid]
          );
          comment = commentRes.rows[0]?.comment_text || null;
        } catch {
          // ignore — table may be empty
        }

        // Determine job status
        let jobStatus: 'scheduled' | 'in_progress' | 'completed' = 'scheduled';
        if (job.status === 'In Progress') jobStatus = 'in_progress';

        const card: LandscapeJobCard = {
          job_uuid: job.uuid,
          job_number: job.generated_job_id || '',
          client_name: clientName,
          address: job.job_address || '',
          description: job.job_description || '',
          scheduled_start: allocations[0].start_time || '',
          estimated_hours: job.total_estimate_hours || 0,
          status: jobStatus,
          employees,
          invoice: null,
          comment,
        };

        if (job.date === todayStr) {
          todayCrewJobs[crewId].push(card);
        } else {
          tomorrowCrewJobs[crewId].push(card);
        }
      } catch (err) {
        logger.warn({
          event: 'landscape_sync_job_error',
          job_uuid: job.uuid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 6. Build LandscapeCrewSchedule arrays
    const WORK_DAY_HOURS = 8;

    function buildSchedules(crewJobs: Record<LandscapeCrewId, LandscapeJobCard[]>): LandscapeCrewSchedule[] {
      return CREW_IDS.map((crewId) => {
        const jobs = crewJobs[crewId].sort((a, b) =>
          (a.scheduled_start || '').localeCompare(b.scheduled_start || '')
        );
        const totalHours = jobs.reduce((sum, j) => sum + j.estimated_hours, 0);
        const openHours = Math.max(0, WORK_DAY_HOURS - totalHours);
        return {
          crew_id: crewId,
          lead_name: leadNames[crewId],
          color: CREW_COLORS[crewId],
          jobs,
          total_hours: totalHours,
          has_open_time: openHours > 0,
          open_hours: openHours,
        };
      });
    }

    const todaySchedules = buildSchedules(todayCrewJobs);
    const tomorrowSchedules = buildSchedules(tomorrowCrewJobs);

    // 7. Update cache
    scheduleCache = {
      today: todaySchedules,
      tomorrow: tomorrowSchedules,
      lastSync: new Date().toISOString(),
    };

    // Log summary
    for (const s of todaySchedules) {
      logger.info({
        event: 'landscape_sync_crew',
        day: 'today',
        crew: s.crew_id,
        lead: s.lead_name,
        jobs: s.jobs.length,
        hours: s.total_hours,
      });
    }
    for (const s of tomorrowSchedules) {
      logger.info({
        event: 'landscape_sync_crew',
        day: 'tomorrow',
        crew: s.crew_id,
        lead: s.lead_name,
        jobs: s.jobs.length,
        hours: s.total_hours,
      });
    }

    logger.info({ event: 'landscape_sync_complete', lastSync: scheduleCache.lastSync });
  } catch (err) {
    logger.error({
      event: 'landscape_sync_error',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Morning alert
// ---------------------------------------------------------------------------

function buildMorningMessage(): string {
  const { todayLabel } = getDatesCT();
  const lines: string[] = [];

  lines.push('🌿 Good morning — Landscape Crew Schedule');
  lines.push(`Today: ${todayLabel}`);

  for (const crew of scheduleCache.today) {
    const crewLabel = crew.crew_id.toUpperCase().replace('LP', 'LP#');
    lines.push(`${crewLabel} ${crew.lead_name} — ${crew.jobs.length} jobs · ${crew.total_hours} hrs`);
    for (const job of crew.jobs) {
      const time = formatTime(job.scheduled_start);
      lines.push(`  ${time} #${job.job_number} ${job.client_name} — ${job.description} (${job.estimated_hours}h)`);
    }
  }

  // Tomorrow warnings for empty crews
  for (const crew of scheduleCache.tomorrow) {
    if (crew.jobs.length === 0) {
      const crewLabel = crew.crew_id.toUpperCase().replace('LP', 'LP#');
      lines.push(`⚠️ Tomorrow: ${crewLabel} ${crew.lead_name} has no jobs scheduled.`);
    }
  }

  return lines.join('\n');
}

export async function sendMorningAlertNow(): Promise<void> {
  try {
    // Run a fresh sync first so data is current
    await syncSchedule();

    const message = buildMorningMessage();

    for (const chatId of ALERT_RECIPIENTS) {
      try {
        await bot.sendMessage(chatId, message);
        logger.info({ event: 'morning_alert_sent', recipient: chatId });
      } catch (err) {
        logger.error({
          event: 'morning_alert_send_error',
          recipient: chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({ event: 'morning_alert_complete' });
  } catch (err) {
    logger.error({
      event: 'morning_alert_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// On-demand fetch for arbitrary date (used by dashboard route)
// ---------------------------------------------------------------------------

export async function fetchScheduleForDate(dateStr: string): Promise<LandscapeCrewSchedule[]> {
  // Load crew lead UUIDs from config_store
  const leadUuids: Record<LandscapeCrewId, string> = { lp1: '', lp2: '', lp3: '', lp4: '' };
  for (const crewId of CREW_IDS) {
    const val = await getConfigValue(`${crewId}_lead_uuid`);
    if (val) leadUuids[crewId] = val;
  }

  const uuidToCrewId: Record<string, LandscapeCrewId> = {};
  for (const crewId of CREW_IDS) {
    if (leadUuids[crewId]) uuidToCrewId[leadUuids[crewId]] = crewId;
  }

  const allStaff = await fetchAllStaff();
  const staffNameMap: Record<string, string> = {};
  for (const s of allStaff) staffNameMap[s.uuid] = s.first;

  const leadNames: Record<LandscapeCrewId, string> = { lp1: '', lp2: '', lp3: '', lp4: '' };
  for (const crewId of CREW_IDS) leadNames[crewId] = staffNameMap[leadUuids[crewId]] || crewId.toUpperCase();

  const allJobs = await fetchAllActiveJobs();
  const relevantJobs = allJobs.filter(
    (j) => j.date === dateStr && (j.status === 'Work Order' || j.status === 'In Progress')
  );

  const companyCache: Record<string, string> = {};
  const crewJobs: Record<LandscapeCrewId, LandscapeJobCard[]> = { lp1: [], lp2: [], lp3: [], lp4: [] };

  for (const job of relevantJobs) {
    try {
      const allocations = await fetchStaffAllocations(job.uuid);
      if (allocations.length === 0) continue;
      allocations.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
      const crewId = uuidToCrewId[allocations[0].staff_uuid];
      if (!crewId) continue;

      if (!companyCache[job.company_uuid]) {
        const company = await fetchCompany(job.company_uuid);
        companyCache[job.company_uuid] = company?.name || 'Unknown Client';
      }

      const employees = allocations.map((a) => ({
        uuid: a.staff_uuid,
        name: staffNameMap[a.staff_uuid] || 'Unknown',
        is_lead: a.staff_uuid === leadUuids[crewId],
      }));

      let comment: string | null = null;
      try {
        const commentRes = await pool.query('SELECT comment_text FROM job_comments WHERE sm8_job_uuid = $1', [job.uuid]);
        comment = commentRes.rows[0]?.comment_text || null;
      } catch { /* ignore */ }

      let jobStatus: 'scheduled' | 'in_progress' | 'completed' = 'scheduled';
      if (job.status === 'In Progress') jobStatus = 'in_progress';

      crewJobs[crewId].push({
        job_uuid: job.uuid,
        job_number: job.generated_job_id || '',
        client_name: companyCache[job.company_uuid],
        address: job.job_address || '',
        description: job.job_description || '',
        scheduled_start: allocations[0].start_time || '',
        estimated_hours: job.total_estimate_hours || 0,
        status: jobStatus,
        employees,
        invoice: null,
        comment,
      });
    } catch { /* skip job */ }
  }

  const WORK_DAY_HOURS = 8;
  return CREW_IDS.map((crewId) => {
    const jobs = crewJobs[crewId].sort((a, b) => (a.scheduled_start || '').localeCompare(b.scheduled_start || ''));
    const totalHours = jobs.reduce((sum, j) => sum + j.estimated_hours, 0);
    const openHours = Math.max(0, WORK_DAY_HOURS - totalHours);
    return {
      crew_id: crewId,
      lead_name: leadNames[crewId],
      color: CREW_COLORS[crewId],
      jobs,
      total_hours: totalHours,
      has_open_time: openHours > 0,
      open_hours: openHours,
    };
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function startLandscapeSync(): void {
  logger.info({ event: 'landscape_sync_init' });

  // Run immediately on startup
  syncSchedule();

  // Every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    syncSchedule();
  }, { timezone: 'America/Chicago' });

  // Morning alert at 6:30 AM CT daily
  cron.schedule('30 6 * * *', () => {
    sendMorningAlertNow();
  }, { timezone: 'America/Chicago' });

  logger.info({ event: 'landscape_sync_scheduled', interval: '15min', alert: '6:30 AM CT' });
}
