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

/**
 * Upsert a prospect from a detected ServiceM8 hardscape job, keyed on
 * sm8_job_uuid. For an EXISTING row this refreshes ONLY the SM8-sourced data
 * fields (client name, scope, quoted total, SM8 status, site address) — it
 * NEVER touches stage, crew_assignment, assigned_to, notes, or design_number,
 * which are manually controlled.
 * For a NEW row it inserts with the supplied stage (mapped from SM8 status).
 * Returns whether a row was inserted or an existing one was updated.
 */
export async function upsertDetectedProspect(
  job: {
    sm8_client_uuid: string;
    sm8_client_name: string;
    sm8_job_uuid: string;
    sm8_job_number: string;
    sm8_status: string;
    scope_summary: string;
    quoted_total: number;
    job_address: string;
  },
  newStage: ProspectStage
): Promise<'inserted' | 'updated'> {
  const existing = await pool.query(
    'SELECT id FROM hardscape_prospects WHERE sm8_job_uuid = $1',
    [job.sm8_job_uuid]
  );

  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE hardscape_prospects
       SET sm8_client_name = $1, scope_summary = $2, quoted_total = $3,
           sm8_status = $4, job_address = $5, sm8_last_synced = NOW(), updated_at = NOW()
       WHERE sm8_job_uuid = $6`,
      [job.sm8_client_name, job.scope_summary, job.quoted_total, job.sm8_status, job.job_address, job.sm8_job_uuid]
    );
    return 'updated';
  }

  const inserted = await pool.query(
    `INSERT INTO hardscape_prospects
       (sm8_client_uuid, sm8_client_name, sm8_job_uuid, sm8_job_number, stage,
        scope_summary, quoted_total, sm8_status, job_address, sm8_last_synced)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (sm8_job_uuid) WHERE sm8_job_uuid IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      job.sm8_client_uuid,
      job.sm8_client_name,
      job.sm8_job_uuid,
      job.sm8_job_number,
      newStage,
      job.scope_summary,
      job.quoted_total,
      job.sm8_status,
      job.job_address,
    ]
  );

  return inserted.rows.length > 0 ? 'inserted' : 'updated';
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
         stage = 'scheduled_for_work', stage_updated_at = NOW(), updated_at = NOW()
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
    WHERE stage NOT IN ('completed', 'lost_opportunity')
    ORDER BY stage, updated_at DESC
  `);
  const grouped: Record<string, any[]> = {};
  for (const row of result.rows) {
    if (!grouped[row.stage]) grouped[row.stage] = [];
    grouped[row.stage].push(row);
  }
  return grouped;
}
