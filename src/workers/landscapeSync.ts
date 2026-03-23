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

// Track job statuses across sync cycles for completion detection
const previousJobStatuses = new Map<string, string>(); // uuid → status

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

/** Format SM8 time string (already in America/Chicago) as "7:00 AM" */
function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  const m = dateStr.match(/(\d{2}):(\d{2})/);
  if (!m) return dateStr;
  const h = parseInt(m[1], 10);
  const h12 = h % 12 || 12;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h12}:${m[2]} ${ampm}`;
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
  end_time: string;
}

interface SM8JobActivity {
  uuid: string;
  job_uuid: string;
  staff_uuid: string;
  start_date: string;
  end_date: string;
  active: number;
  activity_was_scheduled: number;
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
  // Deprecated — jobstaffallocation endpoint no longer authorized.
  // Kept as fallback; callers should prefer fetchAllJobActivities() bulk fetch.
  try {
    const res = await axios.get(`${SM8_BASE}/jobstaffallocation.json`, {
      headers: SM8_HEADERS,
      params: { job_uuid: jobUuid },
      timeout: 15000,
    });
    return res.data || [];
  } catch {
    return [];
  }
}

async function fetchAllJobActivities(): Promise<SM8JobActivity[]> {
  const res = await axios.get(`${SM8_BASE}/jobactivity.json`, {
    headers: SM8_HEADERS,
    timeout: 30000,
  });
  return res.data || [];
}

/** Build map of job_uuid → sorted staff allocations from jobactivity data */
function buildActivityMap(activities: SM8JobActivity[]): Record<string, SM8StaffAllocation[]> {
  const map: Record<string, SM8StaffAllocation[]> = {};
  for (const act of activities) {
    if (act.active !== 1 || !act.activity_was_scheduled) continue;
    if (!map[act.job_uuid]) map[act.job_uuid] = [];
    map[act.job_uuid].push({
      uuid: act.uuid,
      job_uuid: act.job_uuid,
      staff_uuid: act.staff_uuid,
      start_time: act.start_date,
      end_time: act.end_date,
    });
  }
  // Sort each job's allocations by start_time
  for (const key of Object.keys(map)) {
    map[key].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  }
  return map;
}

/** Build map of (job_uuid:date) → sorted staff allocations, filtered to target dates.
 *  Used by schedule logic so jobs appear on the date they're booked on the dispatch
 *  board (activity start_date) rather than the original job.date. */
function buildDateActivityMap(
  activities: SM8JobActivity[],
  targetDates: Set<string>
): Record<string, SM8StaffAllocation[]> {
  const map: Record<string, SM8StaffAllocation[]> = {};
  for (const act of activities) {
    if (act.active !== 1 || !act.activity_was_scheduled) continue;
    const actDate = (act.start_date || '').substring(0, 10);
    if (!targetDates.has(actDate)) continue;
    const key = `${act.job_uuid}:${actDate}`;
    if (!map[key]) map[key] = [];
    map[key].push({
      uuid: act.uuid,
      job_uuid: act.job_uuid,
      staff_uuid: act.staff_uuid,
      start_time: act.start_date,
      end_time: act.end_date,
    });
  }
  for (const key of Object.keys(map)) {
    map[key].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  }
  return map;
}

/** Calculate job timing from the first allocation's start/end times.
 *  SM8 activity times are already in America/Chicago local time.
 *  All-day jobs (>= 23 hours) are normalised to 7 AM – 5 PM (10 h). */
function calcJobTiming(
  allocations: SM8StaffAllocation[],
  jobDate: string
): { scheduledStart: string; scheduledEnd: string; estimatedHours: number } {
  if (allocations.length === 0)
    return { scheduledStart: '', scheduledEnd: '', estimatedHours: 0 };

  const first = allocations[0];
  if (!first.start_time || !first.end_time)
    return { scheduledStart: first.start_time || '', scheduledEnd: first.end_time || '', estimatedHours: 0 };

  const start = new Date(first.start_time.replace(' ', 'T'));
  const end = new Date(first.end_time.replace(' ', 'T'));
  const diffMs = end.getTime() - start.getTime();
  if (diffMs <= 0 || isNaN(diffMs))
    return { scheduledStart: first.start_time, scheduledEnd: first.end_time, estimatedHours: 0 };

  const hours = diffMs / 3600000;

  if (hours >= 23) {
    // All-day job — default to 7 AM - 5 PM
    return {
      scheduledStart: jobDate + ' 07:00:00',
      scheduledEnd: jobDate + ' 17:00:00',
      estimatedHours: 10,
    };
  }

  return {
    scheduledStart: first.start_time,
    scheduledEnd: first.end_time,
    estimatedHours: Math.round(hours * 10) / 10,
  };
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

/** Fetch all companies in one call and build uuid → name map */
async function fetchAllCompanies(): Promise<Record<string, string>> {
  const res = await axios.get(`${SM8_BASE}/company.json`, {
    headers: SM8_HEADERS,
    timeout: 30000,
  });
  const map: Record<string, string> = {};
  for (const c of (res.data || []) as SM8Company[]) {
    if (c.uuid && c.name) map[c.uuid] = c.name;
  }
  return map;
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

    // Build reverse lookup: lead staff_uuid → crew_id
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

    // 4. Fetch all active jobs and build lookup by UUID
    const { todayStr, tomorrowStr } = getDatesCT();
    const allJobs = await fetchAllActiveJobs();
    const jobMap: Record<string, SM8Job> = {};
    for (const j of allJobs) {
      if (j.status === 'Work Order' || j.status === 'In Progress') {
        jobMap[j.uuid] = j;
      }
    }

    // 5. Fetch all job activities; build date-filtered and full maps
    const allActivities = await fetchAllJobActivities();
    const targetDates = new Set([todayStr, tomorrowStr]);
    const dateActMap = buildDateActivityMap(allActivities, targetDates);
    const activityMap = buildActivityMap(allActivities);

    logger.info({
      event: 'landscape_sync_jobs_filtered',
      total_jobs: allJobs.length,
      active_jobs: Object.keys(jobMap).length,
      today: todayStr,
      tomorrow: tomorrowStr,
    });

    // 5b. Fetch all companies in one batch call
    const companyMap = await fetchAllCompanies();

    const todayCrewJobs: Record<LandscapeCrewId, LandscapeJobCard[]> = { lp1: [], lp2: [], lp3: [], lp4: [] };
    const tomorrowCrewJobs: Record<LandscapeCrewId, LandscapeJobCard[]> = { lp1: [], lp2: [], lp3: [], lp4: [] };
    const seenJobUuids = new Set<string>();

    // 6a. Primary: jobs with activities booked on target dates
    for (const [key, allocations] of Object.entries(dateActMap)) {
      const sepIdx = key.lastIndexOf(':');
      const jobUuid = key.substring(0, sepIdx);
      const activityDate = key.substring(sepIdx + 1);
      const job = jobMap[jobUuid];
      if (!job) continue;
      seenJobUuids.add(jobUuid);

      try {
        let crewId: LandscapeCrewId | undefined;
        for (const alloc of allocations) {
          crewId = uuidToCrewId[alloc.staff_uuid];
          if (crewId) break;
        }
        if (!crewId) continue;

        const assignedCrewId = crewId;
        const clientName = companyMap[job.company_uuid] || job.job_description || 'Unknown Client';
        const employees = allocations.map((a) => ({
          uuid: a.staff_uuid,
          name: staffNameMap[a.staff_uuid] || 'Unknown',
          is_lead: a.staff_uuid === leadUuids[assignedCrewId],
        }));

        let comment: string | null = null;
        try {
          const commentRes = await pool.query(
            'SELECT comment_text FROM job_comments WHERE sm8_job_uuid = $1',
            [job.uuid]
          );
          comment = commentRes.rows[0]?.comment_text || null;
        } catch { /* ignore */ }

        let jobStatus: 'scheduled' | 'in_progress' | 'completed' = 'scheduled';
        if (job.status === 'In Progress') jobStatus = 'in_progress';

        const timing = calcJobTiming(allocations, activityDate);

        const card: LandscapeJobCard = {
          job_uuid: job.uuid,
          job_number: job.generated_job_id || '',
          client_name: clientName,
          address: job.job_address || '',
          description: job.job_description || '',
          scheduled_start: timing.scheduledStart,
          estimated_hours: timing.estimatedHours,
          status: jobStatus,
          employees,
          invoice: null,
          comment,
        };

        if (activityDate === todayStr) {
          todayCrewJobs[crewId].push(card);
        } else {
          tomorrowCrewJobs[crewId].push(card);
        }
      } catch (err) {
        logger.warn({
          event: 'landscape_sync_job_error',
          job_uuid: jobUuid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 6b. Fallback: jobs where job.date matches but no activity on target dates
    for (const job of Object.values(jobMap)) {
      if (seenJobUuids.has(job.uuid)) continue;
      const jd = (job.date || '').substring(0, 10);
      if (!targetDates.has(jd)) continue;

      try {
        const allocations = activityMap[job.uuid] || [];
        let crewId: LandscapeCrewId | undefined;
        for (const alloc of allocations) {
          crewId = uuidToCrewId[alloc.staff_uuid];
          if (crewId) break;
        }
        if (!crewId) continue;

        const assignedCrewId = crewId;
        const clientName = companyMap[job.company_uuid] || job.job_description || 'Unknown Client';
        const employees = allocations.map((a) => ({
          uuid: a.staff_uuid,
          name: staffNameMap[a.staff_uuid] || 'Unknown',
          is_lead: a.staff_uuid === leadUuids[assignedCrewId],
        }));

        let comment: string | null = null;
        try {
          const commentRes = await pool.query(
            'SELECT comment_text FROM job_comments WHERE sm8_job_uuid = $1',
            [job.uuid]
          );
          comment = commentRes.rows[0]?.comment_text || null;
        } catch { /* ignore */ }

        let jobStatus: 'scheduled' | 'in_progress' | 'completed' = 'scheduled';
        if (job.status === 'In Progress') jobStatus = 'in_progress';

        const timing = calcJobTiming(allocations, jd);

        const card: LandscapeJobCard = {
          job_uuid: job.uuid,
          job_number: job.generated_job_id || '',
          client_name: clientName,
          address: job.job_address || '',
          description: job.job_description || '',
          scheduled_start: timing.scheduledStart,
          estimated_hours: timing.estimatedHours,
          status: jobStatus,
          employees,
          invoice: null,
          comment,
        };

        if (jd === todayStr) {
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

    // 8. Detect newly completed jobs and send notifications
    try {
      const isFirstRun = previousJobStatuses.size === 0;

      // Also load HP crew lead UUIDs for job type detection
      const hpLeadUuids: Record<string, string> = {};
      for (const hpId of ['hp1', 'hp2'] as const) {
        const val = await getConfigValue(`${hpId}_lead_uuid`);
        if (val) hpLeadUuids[val] = hpId;
      }

      // Build combined LP + HP lookup: staff_uuid → crew label
      const staffToCrewLabel: Record<string, { type: string; label: string; leadName: string }> = {};
      for (const crewId of CREW_IDS) {
        if (leadUuids[crewId]) {
          const label = crewId.toUpperCase().replace('LP', 'LP#');
          staffToCrewLabel[leadUuids[crewId]] = { type: 'landscape_project', label, leadName: leadNames[crewId] };
        }
      }
      for (const [staffUuid, hpId] of Object.entries(hpLeadUuids)) {
        const label = hpId.toUpperCase().replace('HP', 'HP#');
        staffToCrewLabel[staffUuid] = { type: 'hardscape', label, leadName: staffNameMap[staffUuid] || hpId.toUpperCase() };
      }

      if (!isFirstRun) {
        // Find jobs that were Work Order / In Progress and are now Completed
        for (const job of allJobs) {
          const prevStatus = previousJobStatuses.get(job.uuid);
          if (!prevStatus) continue;
          if (job.status !== 'Completed') continue;
          if (prevStatus !== 'Work Order' && prevStatus !== 'In Progress') continue;

          // Determine job type by scanning ALL activities for a matching crew lead
          const allocations = activityMap[job.uuid] || [];
          if (allocations.length === 0) continue;
          let crewInfo: { type: string; label: string; leadName: string } | undefined;
          for (const alloc of allocations) {
            crewInfo = staffToCrewLabel[alloc.staff_uuid];
            if (crewInfo) break;
          }
          if (!crewInfo) continue; // No LP or HP crew lead found — skip (mowing/maintenance)

          const clientName = companyMap[job.company_uuid] || 'Unknown Client';
          const jobNumber = job.generated_job_id || job.uuid.substring(0, 8);
          const jobTypeLabel = crewInfo.type === 'landscape_project' ? 'Landscape Project' : 'Hardscape';

          // Query subscribers for this job type
          const subsRes = await pool.query(
            `SELECT telegram_id FROM completion_notifications
             WHERE active = TRUE AND $1 = ANY(job_types)`,
            [crewInfo.type]
          );

          const message = `\u2705 Job completed: #${jobNumber} ${clientName}\nType: ${jobTypeLabel}\nCrew: ${crewInfo.label} ${crewInfo.leadName}\nAddress: ${job.job_address || 'No address'}`;

          for (const row of subsRes.rows) {
            try {
              await bot.sendMessage(row.telegram_id, message);
              logger.info({ event: 'completion_notification_sent', recipient: row.telegram_id, job: jobNumber });
            } catch (err) {
              logger.warn({
                event: 'completion_notification_error',
                recipient: row.telegram_id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          logger.info({
            event: 'job_completion_detected',
            job_uuid: job.uuid,
            job_number: jobNumber,
            client: clientName,
            job_type: crewInfo.type,
            crew: crewInfo.label,
            subscribers: subsRes.rows.length,
          });
        }
      }

      // Update previous statuses for next cycle
      previousJobStatuses.clear();
      for (const job of allJobs) {
        previousJobStatuses.set(job.uuid, job.status);
      }
    } catch (err) {
      logger.warn({
        event: 'completion_notification_check_error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  const jobMap: Record<string, SM8Job> = {};
  for (const j of allJobs) {
    if (j.status === 'Work Order' || j.status === 'In Progress') jobMap[j.uuid] = j;
  }

  const allActivities = await fetchAllJobActivities();
  const dateActMap = buildDateActivityMap(allActivities, new Set([dateStr]));
  const fullActivityMap = buildActivityMap(allActivities);

  const companyMap = await fetchAllCompanies();
  const crewJobs: Record<LandscapeCrewId, LandscapeJobCard[]> = { lp1: [], lp2: [], lp3: [], lp4: [] };
  const seenJobUuids = new Set<string>();

  // Primary: jobs with activities booked on dateStr
  for (const [key, allocations] of Object.entries(dateActMap)) {
    const jobUuid = key.substring(0, key.lastIndexOf(':'));
    const job = jobMap[jobUuid];
    if (!job) continue;
    seenJobUuids.add(jobUuid);

    try {
      let crewId: LandscapeCrewId | undefined;
      for (const alloc of allocations) {
        crewId = uuidToCrewId[alloc.staff_uuid];
        if (crewId) break;
      }
      if (!crewId) continue;

      const assignedCrewId = crewId;
      const employees = allocations.map((a) => ({
        uuid: a.staff_uuid,
        name: staffNameMap[a.staff_uuid] || 'Unknown',
        is_lead: a.staff_uuid === leadUuids[assignedCrewId],
      }));

      let comment: string | null = null;
      try {
        const commentRes = await pool.query('SELECT comment_text FROM job_comments WHERE sm8_job_uuid = $1', [job.uuid]);
        comment = commentRes.rows[0]?.comment_text || null;
      } catch { /* ignore */ }

      let jobStatus: 'scheduled' | 'in_progress' | 'completed' = 'scheduled';
      if (job.status === 'In Progress') jobStatus = 'in_progress';

      const timing = calcJobTiming(allocations, dateStr);

      crewJobs[crewId].push({
        job_uuid: job.uuid,
        job_number: job.generated_job_id || '',
        client_name: companyMap[job.company_uuid] || job.job_description || 'Unknown Client',
        address: job.job_address || '',
        description: job.job_description || '',
        scheduled_start: timing.scheduledStart,
        estimated_hours: timing.estimatedHours,
        status: jobStatus,
        employees,
        invoice: null,
        comment,
      });
    } catch { /* skip job */ }
  }

  // Fallback: jobs where job.date matches but no activity on dateStr
  for (const job of Object.values(jobMap)) {
    if (seenJobUuids.has(job.uuid)) continue;
    if ((job.date || '').substring(0, 10) !== dateStr) continue;

    try {
      const allocations = fullActivityMap[job.uuid] || [];
      let crewId: LandscapeCrewId | undefined;
      for (const alloc of allocations) {
        crewId = uuidToCrewId[alloc.staff_uuid];
        if (crewId) break;
      }
      if (!crewId) continue;

      const assignedCrewId = crewId;
      const employees = allocations.map((a) => ({
        uuid: a.staff_uuid,
        name: staffNameMap[a.staff_uuid] || 'Unknown',
        is_lead: a.staff_uuid === leadUuids[assignedCrewId],
      }));

      let comment: string | null = null;
      try {
        const commentRes = await pool.query('SELECT comment_text FROM job_comments WHERE sm8_job_uuid = $1', [job.uuid]);
        comment = commentRes.rows[0]?.comment_text || null;
      } catch { /* ignore */ }

      let jobStatus: 'scheduled' | 'in_progress' | 'completed' = 'scheduled';
      if (job.status === 'In Progress') jobStatus = 'in_progress';

      const timing = calcJobTiming(allocations, dateStr);

      crewJobs[crewId].push({
        job_uuid: job.uuid,
        job_number: job.generated_job_id || '',
        client_name: companyMap[job.company_uuid] || job.job_description || 'Unknown Client',
        address: job.job_address || '',
        description: job.job_description || '',
        scheduled_start: timing.scheduledStart,
        estimated_hours: timing.estimatedHours,
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
// Calendar range fetch (used by /landscape/calendar route)
// ---------------------------------------------------------------------------

export interface CalendarJob {
  job_uuid: string;
  job_number: string;
  client_name: string;
  date: string;
  scheduled_start: string;
  scheduled_end: string;
  estimated_hours: number;
  employee_count: number;
  status: 'scheduled' | 'in_progress' | 'completed';
}

export interface CalendarCrewData {
  lead_name: string;
  color: string;
  jobs: CalendarJob[];
}

export async function fetchCalendarRange(
  fromDate: string,
  days: number
): Promise<Record<LandscapeCrewId, CalendarCrewData>> {
  // Build date range
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(fromDate + 'T12:00:00');
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const tomorrowD = new Date();
  tomorrowD.setDate(tomorrowD.getDate() + 1);
  const tomorrowDate = tomorrowD.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  // Load crew lead UUIDs
  const leadUuids: Record<LandscapeCrewId, string> = { lp1: '', lp2: '', lp3: '', lp4: '' };
  for (const crewId of CREW_IDS) {
    const val = await getConfigValue(`${crewId}_lead_uuid`);
    if (val) leadUuids[crewId] = val;
  }

  const uuidToCrewId: Record<string, LandscapeCrewId> = {};
  for (const crewId of CREW_IDS) {
    if (leadUuids[crewId]) uuidToCrewId[leadUuids[crewId]] = crewId;
  }

  // Staff names
  const allStaff = await fetchAllStaff();
  const staffNameMap: Record<string, string> = {};
  for (const s of allStaff) staffNameMap[s.uuid] = s.first;

  const leadNames: Record<LandscapeCrewId, string> = { lp1: '', lp2: '', lp3: '', lp4: '' };
  for (const crewId of CREW_IDS) leadNames[crewId] = staffNameMap[leadUuids[crewId]] || crewId.toUpperCase();

  // Initialize result
  const result: Record<LandscapeCrewId, CalendarCrewData> = {
    lp1: { lead_name: leadNames.lp1, color: CREW_COLORS.lp1, jobs: [] },
    lp2: { lead_name: leadNames.lp2, color: CREW_COLORS.lp2, jobs: [] },
    lp3: { lead_name: leadNames.lp3, color: CREW_COLORS.lp3, jobs: [] },
    lp4: { lead_name: leadNames.lp4, color: CREW_COLORS.lp4, jobs: [] },
  };

  // Use cache for today/tomorrow if available
  const cache = getScheduleCache();
  const cachedDates = new Set<string>();

  if (cache.lastSync) {
    if (dates.includes(todayDate)) {
      cachedDates.add(todayDate);
      for (const crew of cache.today) {
        for (const job of crew.jobs) {
          // Compute end from start + estimated_hours
          let scheduledEnd = '';
          if (job.scheduled_start && job.estimated_hours > 0) {
            const s = new Date(job.scheduled_start.replace(' ', 'T'));
            s.setTime(s.getTime() + job.estimated_hours * 3600000);
            scheduledEnd = s.toISOString().replace('T', ' ').substring(0, 19);
          }
          result[crew.crew_id].jobs.push({
            job_uuid: job.job_uuid,
            job_number: job.job_number,
            client_name: job.client_name,
            date: todayDate,
            scheduled_start: job.scheduled_start,
            scheduled_end: scheduledEnd,
            estimated_hours: job.estimated_hours,
            employee_count: job.employees.length,
            status: job.status,
          });
        }
      }
    }
    if (dates.includes(tomorrowDate)) {
      cachedDates.add(tomorrowDate);
      for (const crew of cache.tomorrow) {
        for (const job of crew.jobs) {
          let scheduledEnd = '';
          if (job.scheduled_start && job.estimated_hours > 0) {
            const s = new Date(job.scheduled_start.replace(' ', 'T'));
            s.setTime(s.getTime() + job.estimated_hours * 3600000);
            scheduledEnd = s.toISOString().replace('T', ' ').substring(0, 19);
          }
          result[crew.crew_id].jobs.push({
            job_uuid: job.job_uuid,
            job_number: job.job_number,
            client_name: job.client_name,
            date: tomorrowDate,
            scheduled_start: job.scheduled_start,
            scheduled_end: scheduledEnd,
            estimated_hours: job.estimated_hours,
            employee_count: job.employees.length,
            status: job.status,
          });
        }
      }
    }
  }

  // Remaining dates: fetch from SM8 in one batch
  const remainingDates = new Set(dates.filter((d) => !cachedDates.has(d)));
  if (remainingDates.size > 0) {
    const allJobs = await fetchAllActiveJobs();
    const jobMap: Record<string, SM8Job> = {};
    for (const j of allJobs) {
      if (j.status === 'Work Order' || j.status === 'In Progress') jobMap[j.uuid] = j;
    }

    const allActivities = await fetchAllJobActivities();
    const dateActMap = buildDateActivityMap(allActivities, remainingDates);
    const fullActivityMap = buildActivityMap(allActivities);
    const companyMap = await fetchAllCompanies();
    const seenJobUuids = new Set<string>();

    // Primary: jobs with activities booked on remaining dates
    for (const [key, allocations] of Object.entries(dateActMap)) {
      const sepIdx = key.lastIndexOf(':');
      const jobUuid = key.substring(0, sepIdx);
      const activityDate = key.substring(sepIdx + 1);
      const job = jobMap[jobUuid];
      if (!job) continue;
      seenJobUuids.add(jobUuid);

      try {
        let crewId: LandscapeCrewId | undefined;
        for (const alloc of allocations) {
          crewId = uuidToCrewId[alloc.staff_uuid];
          if (crewId) break;
        }
        if (!crewId) continue;

        let jobStatus: 'scheduled' | 'in_progress' | 'completed' = 'scheduled';
        if (job.status === 'In Progress') jobStatus = 'in_progress';

        const timing = calcJobTiming(allocations, activityDate);

        result[crewId].jobs.push({
          job_uuid: job.uuid,
          job_number: job.generated_job_id || '',
          client_name: companyMap[job.company_uuid] || job.job_description || 'Unknown Client',
          date: activityDate,
          scheduled_start: timing.scheduledStart,
          scheduled_end: timing.scheduledEnd,
          estimated_hours: timing.estimatedHours,
          employee_count: allocations.length,
          status: jobStatus,
        });
      } catch {
        // skip job
      }
    }

    // Fallback: jobs where job.date matches but no activity on remaining dates
    for (const job of Object.values(jobMap)) {
      if (seenJobUuids.has(job.uuid)) continue;
      const jd = (job.date || '').substring(0, 10);
      if (!remainingDates.has(jd)) continue;

      try {
        const allocations = fullActivityMap[job.uuid] || [];
        let crewId: LandscapeCrewId | undefined;
        for (const alloc of allocations) {
          crewId = uuidToCrewId[alloc.staff_uuid];
          if (crewId) break;
        }
        if (!crewId) continue;

        let jobStatus: 'scheduled' | 'in_progress' | 'completed' = 'scheduled';
        if (job.status === 'In Progress') jobStatus = 'in_progress';

        const timing = calcJobTiming(allocations, jd);

        result[crewId].jobs.push({
          job_uuid: job.uuid,
          job_number: job.generated_job_id || '',
          client_name: companyMap[job.company_uuid] || job.job_description || 'Unknown Client',
          date: jd,
          scheduled_start: timing.scheduledStart,
          scheduled_end: timing.scheduledEnd,
          estimated_hours: timing.estimatedHours,
          employee_count: allocations.length,
          status: jobStatus,
        });
      } catch {
        // skip job
      }
    }
  }

  // Sort each crew's jobs by date then start time
  for (const crewId of CREW_IDS) {
    result[crewId].jobs.sort((a, b) =>
      a.date === b.date
        ? (a.scheduled_start || '').localeCompare(b.scheduled_start || '')
        : a.date.localeCompare(b.date)
    );
  }

  return result;
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
