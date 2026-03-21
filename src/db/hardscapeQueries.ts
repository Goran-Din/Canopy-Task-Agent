import { pool } from './pool';
import { HardscapeProspect, ProspectComment, CrewScheduleEntry, HardscapeCrewId, ProspectStage } from '../types';

export async function findProspectByClientName(clientName: string): Promise<HardscapeProspect | null> {
  const result = await pool.query(
    `SELECT * FROM hardscape_prospects
     WHERE LOWER(sm8_client_name) LIKE LOWER($1)
     ORDER BY updated_at DESC LIMIT 1`,
    [`%${clientName}%`]
  );
  return result.rows[0] || null;
}

export async function createProspect(data: {
  sm8_client_uuid: string;
  sm8_client_name: string;
  sm8_job_uuid?: string;
  sm8_job_number?: string;
  stage: ProspectStage;
  notes?: string;
  client_folder_url?: string;
}): Promise<HardscapeProspect> {
  const result = await pool.query(
    `INSERT INTO hardscape_prospects
       (sm8_client_uuid, sm8_client_name, sm8_job_uuid, sm8_job_number, stage, notes, client_folder_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.sm8_client_uuid,
      data.sm8_client_name,
      data.sm8_job_uuid || null,
      data.sm8_job_number || null,
      data.stage,
      data.notes || null,
      data.client_folder_url || null,
    ]
  );
  return result.rows[0];
}

export async function updateProspectStage(
  id: number,
  stage: ProspectStage,
  stageUpdatedAt: Date
): Promise<void> {
  await pool.query(
    `UPDATE hardscape_prospects
     SET stage = $1, stage_updated_at = $2, updated_at = NOW()
     WHERE id = $3`,
    [stage, stageUpdatedAt, id]
  );
}

export async function updateProspectCrew(
  id: number,
  crew: HardscapeCrewId,
  scheduledStart: string,
  estimatedDays: number
): Promise<void> {
  await pool.query(
    `UPDATE hardscape_prospects
     SET crew_assignment = $1, scheduled_start = $2, estimated_crew_days = $3,
         stage = 'scheduled', stage_updated_at = NOW(), updated_at = NOW()
     WHERE id = $4`,
    [crew, scheduledStart, estimatedDays, id]
  );
}

export async function addProspectComment(data: {
  prospect_id: number;
  source: 'manual' | 'sm8_sync' | 'agent';
  author?: string;
  content: string;
  sm8_activity_uuid?: string;
  editable?: boolean;
  activity_date?: Date;
}): Promise<ProspectComment> {
  const result = await pool.query(
    `INSERT INTO prospect_comments
       (prospect_id, source, author, content, sm8_activity_uuid, editable, activity_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.prospect_id,
      data.source,
      data.author || null,
      data.content,
      data.sm8_activity_uuid || null,
      data.editable ?? false,
      data.activity_date || new Date(),
    ]
  );
  return result.rows[0];
}

export async function getNextAvailableDate(crew: HardscapeCrewId): Promise<string | null> {
  const result = await pool.query(
    `SELECT MAX(start_date + (estimated_days || ' days')::interval) AS next_available
     FROM crew_schedule
     WHERE crew = $1 AND status IN ('scheduled', 'in_progress')`,
    [crew]
  );
  const row = result.rows[0];
  if (!row?.next_available) return null;
  return new Date(row.next_available).toISOString().split('T')[0];
}

export async function createCrewScheduleEntry(data: {
  prospect_id: number;
  crew: HardscapeCrewId;
  start_date: string;
  estimated_days: number;
  status?: string;
}): Promise<CrewScheduleEntry> {
  const result = await pool.query(
    `INSERT INTO crew_schedule (prospect_id, crew, start_date, estimated_days, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      data.prospect_id,
      data.crew,
      data.start_date,
      data.estimated_days,
      data.status || 'scheduled',
    ]
  );
  return result.rows[0];
}

export async function delayCrewSchedule(
  crew: HardscapeCrewId,
  fromDate: string,
  days: number
): Promise<{ count: number; prospectIds: number[] }> {
  const result = await pool.query(
    `UPDATE crew_schedule
     SET start_date = start_date + ($3 || ' days')::interval, updated_at = NOW()
     WHERE crew = $1 AND start_date >= $2 AND status IN ('scheduled', 'in_progress')
     RETURNING prospect_id`,
    [crew, fromDate, days]
  );
  const prospectIds = result.rows.map((r: { prospect_id: number }) => r.prospect_id);
  return { count: result.rowCount ?? 0, prospectIds };
}

export async function getPipelineSummary(): Promise<Record<string, any[]>> {
  const result = await pool.query(`
    SELECT id, sm8_client_name, stage, crew_assignment,
           scheduled_start, assigned_to, updated_at
    FROM hardscape_prospects
    WHERE stage NOT IN ('completed', 'closed_lost')
    ORDER BY stage, updated_at DESC
  `);
  const grouped: Record<string, any[]> = {};
  for (const row of result.rows) {
    if (!grouped[row.stage]) grouped[row.stage] = [];
    grouped[row.stage].push(row);
  }
  return grouped;
}
