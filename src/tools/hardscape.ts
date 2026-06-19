import axios from 'axios';
import { config } from '../config';
import { pool } from '../db/pool';
import {
  CreateProspectInput,
  UpdateProspectStageInput,
  AssignCrewInput,
  DelayCrewJobsInput,
  ProspectStage,
  HardscapeCrewId,
} from '../types';
import {
  findProspectByClientName,
  createProspect as dbCreateProspect,
  updateProspectStage as dbUpdateProspectStage,
  updateProspectCrew,
  addProspectComment,
  getNextAvailableDate,
  createCrewScheduleEntry,
  delayCrewSchedule,
  getPipelineSummary,
} from '../db/hardscapeQueries';
import logger from '../logger';

const sm8Api = axios.create({
  baseURL: config.servicem8.baseUrl,
  headers: {
    'X-API-Key': config.servicem8.apiKey,
    'Accept': 'application/json',
  },
  timeout: 10000,
});

const STAGE_LABELS: Record<ProspectStage, string> = {
  request_site_visit: 'Request site visit',
  pending_quote: 'Pending quote',
  quote_sent: 'Quote sent',
  quote_accepted: 'Quote accepted',
  pending_permits: 'Pending permits',
  scheduled_for_work: 'Scheduled for work',
  work_in_progress: 'Work in progress',
  completed: 'Completed',
  lost_opportunity: 'Lost opportunity',
};

const CREW_DISPLAY: Record<HardscapeCrewId, string> = {
  hp1: 'HP#1 (Rigo Tello)',
  hp2: 'HP#2 (Daniel Tello)',
};

async function getUserName(telegramId: number): Promise<string> {
  const result = await pool.query(
    'SELECT name FROM users WHERE telegram_id = $1',
    [telegramId]
  );
  return result.rows[0]?.name || 'Unknown';
}

export async function createProspect(
  input: CreateProspectInput,
  requestedBy: number
): Promise<string> {
  try {
    let sm8Uuid = 'unknown';
    let clientName = input.client_name;

    // Search SM8 for matching client
    try {
      const res = await sm8Api.get('/company.json', { params: { active: 1 } });
      const clients = res.data || [];
      const searchTerm = input.client_name.toLowerCase();
      const match = clients.find((c: { name?: string }) =>
        c.name && c.name.toLowerCase().includes(searchTerm)
      );
      if (match) {
        sm8Uuid = match.uuid;
        clientName = match.name;
      }
    } catch {
      // SM8 lookup failed — proceed with unknown UUID
    }

    const stage = input.stage || 'request_site_visit';
    const prospect = await dbCreateProspect({
      sm8_client_uuid: sm8Uuid,
      sm8_client_name: clientName,
      sm8_job_uuid: input.sm8_job_uuid,
      stage,
      notes: input.notes,
      client_folder_url: input.client_folder_url,
    });

    const userName = await getUserName(requestedBy);
    await addProspectComment({
      prospect_id: prospect.id,
      source: 'agent',
      author: 'Agent',
      content: `Prospect created by ${userName}`,
    });

    logger.info({ event: 'prospect_created', id: prospect.id, client: clientName, stage });
    return `✅ Prospect created: ${clientName} — Stage: ${STAGE_LABELS[stage]}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ event: 'create_prospect_error', error: msg });
    return `❌ Failed to create prospect: ${msg}`;
  }
}

export async function updateProspectStage(
  input: UpdateProspectStageInput,
  requestedBy: number
): Promise<string> {
  try {
    const prospect = await findProspectByClientName(input.client_name);
    if (!prospect) {
      return `❌ No prospect found for "${input.client_name}". Check the name and try again.`;
    }

    await dbUpdateProspectStage(prospect.id, input.new_stage, new Date());

    const userName = await getUserName(requestedBy);
    const stageLabel = STAGE_LABELS[input.new_stage];
    const commentContent = `Stage updated to ${stageLabel} by ${userName}${input.comment ? '. ' + input.comment : ''}`;
    await addProspectComment({
      prospect_id: prospect.id,
      source: 'agent',
      author: 'Agent',
      content: commentContent,
    });

    logger.info({ event: 'prospect_stage_updated', id: prospect.id, client: prospect.sm8_client_name, stage: input.new_stage });
    return `✅ ${prospect.sm8_client_name} → ${stageLabel}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ event: 'update_prospect_stage_error', error: msg });
    return `❌ Failed to update stage: ${msg}`;
  }
}

export async function assignCrew(
  input: AssignCrewInput,
  requestedBy: number
): Promise<string> {
  try {
    const prospect = await findProspectByClientName(input.client_name);
    if (!prospect) {
      return `❌ No prospect found for "${input.client_name}". Check the name and try again.`;
    }

    let warning = '';
    const nextAvailable = await getNextAvailableDate(input.crew);
    if (nextAvailable && input.start_date < nextAvailable) {
      const crewNum = input.crew === 'hp1' ? '1' : '2';
      warning = `⚠️ Note: HP#${crewNum} is scheduled until ${nextAvailable}. Assigning from ${input.start_date} as requested.\n`;
    }

    await updateProspectCrew(prospect.id, input.crew, input.start_date, input.estimated_days);

    await createCrewScheduleEntry({
      prospect_id: prospect.id,
      crew: input.crew,
      start_date: input.start_date,
      estimated_days: input.estimated_days,
    });

    const crewDisplay = CREW_DISPLAY[input.crew];
    const endDate = addDaysToDate(input.start_date, input.estimated_days - 1);
    const commentContent = `Assigned to ${crewDisplay} starting ${input.start_date} for ${input.estimated_days} day(s)`;
    await addProspectComment({
      prospect_id: prospect.id,
      source: 'agent',
      author: 'Agent',
      content: commentContent,
    });

    logger.info({ event: 'crew_assigned', id: prospect.id, client: prospect.sm8_client_name, crew: input.crew, start: input.start_date });
    return `${warning}✅ ${prospect.sm8_client_name} assigned to ${crewDisplay}\nStart: ${input.start_date} · End: ${endDate} (${input.estimated_days} day${input.estimated_days > 1 ? 's' : ''})`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ event: 'assign_crew_error', error: msg });
    return `❌ Failed to assign crew: ${msg}`;
  }
}

export async function delayCrewJobs(
  input: DelayCrewJobsInput,
  requestedBy: number
): Promise<string> {
  try {
    const fromDate = input.from_date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const crewNum = input.crew === 'hp1' ? '1' : '2';

    const { count, prospectIds } = await delayCrewSchedule(input.crew, fromDate, input.days);
    if (count === 0) {
      return `No scheduled jobs found for HP#${crewNum} from ${fromDate} onwards.`;
    }

    // Add a comment to each affected prospect
    const reasonText = input.reason ? `. Reason: ${input.reason}` : '';
    for (const prospectId of [...new Set(prospectIds)]) {
      await addProspectComment({
        prospect_id: prospectId,
        source: 'agent',
        author: 'Agent',
        content: `Job delayed ${input.days} day(s)${reasonText}`,
      });
    }

    logger.info({ event: 'crew_delayed', crew: input.crew, days: input.days, from: fromDate, count });
    return `✅ HP#${crewNum} — ${count} job(s) shifted forward by ${input.days} day(s) from ${fromDate}.${input.reason ? '\nReason: ' + input.reason : ''}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ event: 'delay_crew_error', error: msg });
    return `❌ Failed to delay jobs: ${msg}`;
  }
}

export async function getPipelineSummaryText(): Promise<string> {
  const grouped = await getPipelineSummary();
  const PIPELINE_LABELS: Record<string, string> = {
    request_site_visit: 'Request site visit',
    pending_quote: 'Pending quote',
    quote_sent: 'Quote sent',
    quote_accepted: 'Quote accepted',
    pending_permits: 'Pending permits',
    scheduled_for_work: 'Scheduled for work',
    work_in_progress: 'Work in progress',
  };
  const STAGE_ORDER = Object.keys(PIPELINE_LABELS);
  const lines: string[] = ['🏗️ Hardscape Pipeline\n'];
  let total = 0;
  for (const stage of STAGE_ORDER) {
    const prospects = grouped[stage];
    if (!prospects || prospects.length === 0) continue;
    lines.push(`*${PIPELINE_LABELS[stage]}* (${prospects.length})`);
    for (const p of prospects) {
      const crew = p.crew_assignment ? ` — ${p.crew_assignment === 'hp1' ? 'HP#1' : 'HP#2'}` : '';
      lines.push(`  • ${p.sm8_client_name}${crew}`);
      total++;
    }
  }
  if (total === 0) return '🏗️ Hardscape Pipeline\n\nNo active prospects.';
  lines.push(`\nTotal: ${total} active prospect${total !== 1 ? 's' : ''}`);
  return lines.join('\n');
}

function addDaysToDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

const JOB_STATUS_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  paused: 'Paused',
  completed: 'Completed',
};

/**
 * Read-only status lookup for the Telegram agent. Matches a prospect by name and
 * returns its stage, crew, current schedule status, follow-up flags, and the
 * prospect_comments thread (most recent first). If more than one prospect
 * matches, returns the list so the agent can ask which one.
 */
export async function getProspectStatus(clientName: string): Promise<string> {
  try {
    const matches = await pool.query(
      `SELECT * FROM hardscape_prospects
       WHERE LOWER(sm8_client_name) LIKE LOWER($1)
       ORDER BY updated_at DESC`,
      [`%${clientName}%`]
    );

    if (matches.rows.length === 0) {
      return `❌ No hardscape prospect found matching "${clientName}".`;
    }
    if (matches.rows.length > 1) {
      const list = matches.rows
        .map((r) => `• ${r.sm8_client_name}${r.sm8_job_number ? ` (Job #${r.sm8_job_number})` : ''} — ${STAGE_LABELS[r.stage as ProspectStage] || r.stage}`)
        .join('\n');
      return `Multiple prospects match "${clientName}". Which one?\n${list}`;
    }

    const p = matches.rows[0];

    // Latest schedule entry (most recent start) for the live job status.
    const sched = await pool.query(
      `SELECT crew, status, to_char(start_date, 'YYYY-MM-DD') AS start_date, estimated_days
       FROM crew_schedule WHERE prospect_id = $1
       ORDER BY start_date DESC LIMIT 1`,
      [p.id]
    );
    const s = sched.rows[0];

    // Open follow-up reminders, soonest due first.
    const reminders = await pool.query(
      `SELECT to_char(due_date, 'YYYY-MM-DD') AS due_date, note
       FROM prospect_reminders WHERE prospect_id = $1 AND status = 'open'
       ORDER BY due_date ASC, id ASC`,
      [p.id]
    );

    // Comment thread, most recent first.
    const comments = await pool.query(
      `SELECT author, source, content, to_char(activity_date AT TIME ZONE 'America/Chicago', 'Mon DD, YYYY') AS day
       FROM prospect_comments WHERE prospect_id = $1
       ORDER BY activity_date DESC LIMIT 20`,
      [p.id]
    );

    const lines: string[] = [];
    lines.push(`🏗️ ${p.sm8_client_name}${p.sm8_job_number ? ` (Job #${p.sm8_job_number})` : ''}`);
    lines.push(`Stage: ${STAGE_LABELS[p.stage as ProspectStage] || p.stage}`);
    lines.push(`Crew: ${p.crew_assignment ? CREW_DISPLAY[p.crew_assignment as HardscapeCrewId] : 'Unassigned'}`);
    if (s) {
      lines.push(`Schedule status: ${JOB_STATUS_LABELS[s.status] || s.status}${s.start_date ? ` (start ${s.start_date}, ${s.estimated_days} day${s.estimated_days !== 1 ? 's' : ''})` : ''}`);
    } else {
      lines.push('Schedule status: Not scheduled');
    }
    const flags: string[] = [];
    if (p.needs_sealing) flags.push('Needs Sealing');
    if (p.needs_landscape) flags.push('Needs Landscape');
    lines.push(`Follow-up flags: ${flags.length ? flags.join(', ') : 'None'}`);

    lines.push('\nOpen reminders (soonest first):');
    if (reminders.rows.length === 0) {
      lines.push('  (none)');
    } else {
      for (const r of reminders.rows) {
        lines.push(`  • [due ${r.due_date}] ${r.note}`);
      }
    }

    lines.push('\nNotes (most recent first):');
    if (comments.rows.length === 0) {
      lines.push('  (no notes yet)');
    } else {
      for (const c of comments.rows) {
        lines.push(`  • [${c.day}] ${c.content}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ event: 'get_prospect_status_error', error: msg });
    return `❌ Failed to read prospect status: ${msg}`;
  }
}

/**
 * Read-only list of open follow-up reminders due within `daysAhead` days
 * (default 7), across all prospects, soonest due first. Lets the agent answer
 * "what needs follow-up this week?". Dates are evaluated in America/Chicago.
 */
export async function listDueReminders(daysAhead = 7): Promise<string> {
  try {
    const days = Number.isFinite(daysAhead) && daysAhead > 0 ? Math.floor(daysAhead) : 7;
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    const result = await pool.query(
      `SELECT to_char(r.due_date, 'YYYY-MM-DD') AS due_date, r.note,
              hp.sm8_client_name, hp.sm8_job_number
       FROM prospect_reminders r
       JOIN hardscape_prospects hp ON hp.id = r.prospect_id
       WHERE r.status = 'open' AND r.due_date <= ($1::date + ($2 || ' days')::interval)
       ORDER BY r.due_date ASC, r.id ASC`,
      [today, days]
    );

    if (result.rows.length === 0) {
      return `No open follow-ups due in the next ${days} day${days !== 1 ? 's' : ''}.`;
    }

    const lines = result.rows.map((r) => {
      const job = r.sm8_job_number ? ` (Job #${r.sm8_job_number})` : '';
      const overdue = r.due_date < today ? ' — OVERDUE' : '';
      return `• ${r.sm8_client_name}${job} — ${r.note} (due ${r.due_date})${overdue}`;
    });
    return `🔔 Follow-ups due within ${days} day${days !== 1 ? 's' : ''}:\n${lines.join('\n')}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ event: 'list_due_reminders_error', error: msg });
    return `❌ Failed to list due reminders: ${msg}`;
  }
}
