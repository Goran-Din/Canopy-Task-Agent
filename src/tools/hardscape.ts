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
  initial_contact: 'Initial Contact',
  site_visit: 'Site Visit',
  quote_sent: 'Quote Sent',
  revision_requested: 'Revision Requested',
  visual_rendering: 'Visual Rendering',
  final_quote: 'Final Quote',
  deposit_invoice: 'Deposit Invoice',
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Completed',
  closed_lost: 'Closed / Lost',
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

    const stage = input.stage || 'initial_contact';
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

function addDaysToDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
