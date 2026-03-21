import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import logger from '../logger';
import { ProspectStage } from '../types';

const router = Router();

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

// ---------------------------------------------------------------------------
// GET /dashboard/prospects — all active prospects
// ---------------------------------------------------------------------------

router.get('/dashboard/prospects', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        u.name AS assigned_to_name,
        ic.invoice_status, ic.invoice_number, ic.invoice_amount, ic.due_date AS invoice_due_date, ic.paid_date AS invoice_paid_date,
        jc.comment_text AS job_comment,
        (SELECT COUNT(*)::int FROM prospect_comments pc WHERE pc.prospect_id = p.id) AS comment_count
      FROM hardscape_prospects p
      LEFT JOIN users u ON u.telegram_id = p.assigned_to
      LEFT JOIN invoice_cache ic ON ic.sm8_job_uuid = p.sm8_job_uuid
      LEFT JOIN job_comments jc ON jc.sm8_job_uuid = p.sm8_job_uuid
      WHERE p.stage NOT IN ('completed', 'closed_lost')
      ORDER BY p.stage ASC, p.updated_at DESC
    `);

    res.json({ prospects: result.rows });
  } catch (err) {
    logger.error({ event: 'dashboard_get_prospects_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /dashboard/prospects/:id — single prospect with full comment thread
// ---------------------------------------------------------------------------

router.get('/dashboard/prospects/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const prospectResult = await pool.query(`
      SELECT
        p.*,
        u.name AS assigned_to_name,
        ic.invoice_status, ic.invoice_number, ic.invoice_amount, ic.due_date AS invoice_due_date, ic.paid_date AS invoice_paid_date,
        jc.comment_text AS job_comment
      FROM hardscape_prospects p
      LEFT JOIN users u ON u.telegram_id = p.assigned_to
      LEFT JOIN invoice_cache ic ON ic.sm8_job_uuid = p.sm8_job_uuid
      LEFT JOIN job_comments jc ON jc.sm8_job_uuid = p.sm8_job_uuid
      WHERE p.id = $1
    `, [id]);

    if (prospectResult.rows.length === 0) {
      res.status(404).json({ error: 'Prospect not found' });
      return;
    }

    const commentsResult = await pool.query(
      `SELECT * FROM prospect_comments WHERE prospect_id = $1 ORDER BY activity_date ASC`,
      [id]
    );

    res.json({
      prospect: prospectResult.rows[0],
      comments: commentsResult.rows,
    });
  } catch (err) {
    logger.error({ event: 'dashboard_get_prospect_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /dashboard/prospects — create new prospect
// ---------------------------------------------------------------------------

router.post('/dashboard/prospects', async (req: Request, res: Response) => {
  try {
    const {
      sm8_client_name, sm8_client_uuid, sm8_job_uuid, sm8_job_number,
      stage, notes, assigned_to, client_folder_url,
    } = req.body;

    if (!sm8_client_name) {
      res.status(400).json({ error: 'sm8_client_name is required' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO hardscape_prospects
         (sm8_client_name, sm8_client_uuid, sm8_job_uuid, sm8_job_number,
          stage, notes, assigned_to, client_folder_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        sm8_client_name,
        sm8_client_uuid || 'unknown',
        sm8_job_uuid || null,
        sm8_job_number || null,
        stage || 'initial_contact',
        notes || null,
        assigned_to || null,
        client_folder_url || null,
      ]
    );

    res.status(201).json({ prospect: result.rows[0] });
  } catch (err) {
    logger.error({ event: 'dashboard_create_prospect_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /dashboard/prospects/:id — update prospect fields
// ---------------------------------------------------------------------------

router.patch('/dashboard/prospects/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body;

    // Allowed fields for update
    const allowedFields = [
      'sm8_client_name', 'sm8_client_uuid', 'sm8_job_uuid', 'sm8_job_number',
      'stage', 'notes', 'assigned_to', 'estimated_crew_days', 'crew_assignment',
      'scheduled_start', 'client_folder_url',
    ];

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        setClauses.push(`${field} = $${paramIdx}`);
        values.push(body[field]);
        paramIdx++;
      }
    }

    // If stage changed, also update stage_updated_at
    if (body.stage !== undefined) {
      setClauses.push(`stage_updated_at = NOW()`);
    }

    if (values.length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE hardscape_prospects SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Prospect not found' });
      return;
    }

    // If stage changed, add a comment
    if (body.stage !== undefined) {
      const stageLabel = STAGE_LABELS[body.stage as ProspectStage] || body.stage;
      await pool.query(
        `INSERT INTO prospect_comments (prospect_id, source, author, content, activity_date)
         VALUES ($1, 'agent', 'Dashboard', $2, NOW())`,
        [id, `Stage updated to ${stageLabel} via dashboard`]
      );
    }

    res.json({ prospect: result.rows[0] });
  } catch (err) {
    logger.error({ event: 'dashboard_update_prospect_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /dashboard/prospects/:id/comments — add a comment
// ---------------------------------------------------------------------------

router.post('/dashboard/prospects/:id/comments', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { content, author } = req.body;

    if (!content) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    // Verify prospect exists
    const exists = await pool.query('SELECT 1 FROM hardscape_prospects WHERE id = $1', [id]);
    if (exists.rows.length === 0) {
      res.status(404).json({ error: 'Prospect not found' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO prospect_comments (prospect_id, source, author, content, editable, activity_date)
       VALUES ($1, 'manual', $2, $3, true, NOW())
       RETURNING *`,
      [id, author || 'Team', content]
    );

    res.status(201).json({ comment: result.rows[0] });
  } catch (err) {
    logger.error({ event: 'dashboard_add_comment_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /dashboard/archive — completed/closed prospects with filters
// ---------------------------------------------------------------------------

router.get('/dashboard/archive', async (req: Request, res: Response) => {
  try {
    const { outcome, crew, date_from, date_to, search } = req.query;

    const conditions: string[] = [`p.stage IN ('completed', 'closed_lost')`];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (outcome) {
      conditions.push(`p.stage = $${paramIdx}`);
      values.push(outcome);
      paramIdx++;
    }

    if (crew) {
      conditions.push(`p.crew_assignment = $${paramIdx}`);
      values.push(crew);
      paramIdx++;
    }

    if (date_from) {
      conditions.push(`p.updated_at >= $${paramIdx}`);
      values.push(date_from);
      paramIdx++;
    }

    if (date_to) {
      conditions.push(`p.updated_at < ($${paramIdx}::date + interval '1 day')`);
      values.push(date_to);
      paramIdx++;
    }

    if (search) {
      conditions.push(`p.sm8_client_name ILIKE $${paramIdx}`);
      values.push(`%${search}%`);
      paramIdx++;
    }

    const result = await pool.query(`
      SELECT
        p.*,
        u.name AS assigned_to_name,
        ic.invoice_status, ic.invoice_number, ic.invoice_amount, ic.due_date AS invoice_due_date, ic.paid_date AS invoice_paid_date
      FROM hardscape_prospects p
      LEFT JOIN users u ON u.telegram_id = p.assigned_to
      LEFT JOIN invoice_cache ic ON ic.sm8_job_uuid = p.sm8_job_uuid
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.updated_at DESC
    `, values);

    res.json({ prospects: result.rows });
  } catch (err) {
    logger.error({ event: 'dashboard_archive_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// CREW SCHEDULE ENDPOINTS
// ---------------------------------------------------------------------------

const CREW_DISPLAY: Record<string, string> = {
  hp1: 'HP#1 (Rigo Tello)',
  hp2: 'HP#2 (Daniel Tello)',
};

// ---------------------------------------------------------------------------
// GET /dashboard/crew-schedule — list schedule entries with prospect details
// ---------------------------------------------------------------------------

router.get('/dashboard/crew-schedule', async (req: Request, res: Response) => {
  try {
    const { crew, from_date, to_date } = req.query;

    const conditions: string[] = [`cs.status NOT IN ('completed')`];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (crew && crew !== 'both') {
      conditions.push(`cs.crew = $${paramIdx}`);
      values.push(crew);
      paramIdx++;
    }

    if (from_date) {
      conditions.push(`cs.start_date >= $${paramIdx}`);
      values.push(from_date);
      paramIdx++;
    }

    if (to_date) {
      conditions.push(`cs.start_date <= $${paramIdx}`);
      values.push(to_date);
      paramIdx++;
    }

    const result = await pool.query(`
      SELECT cs.*, hp.sm8_client_name, hp.sm8_job_number, hp.stage,
             hp.notes, hp.assigned_to,
             ic.invoice_status, ic.invoice_number, ic.invoice_amount
      FROM crew_schedule cs
      JOIN hardscape_prospects hp ON cs.prospect_id = hp.id
      LEFT JOIN invoice_cache ic ON hp.sm8_job_uuid = ic.sm8_job_uuid
      WHERE ${conditions.join(' AND ')}
      ORDER BY cs.crew ASC, cs.start_date ASC
    `, values);

    res.json({ schedule: result.rows });
  } catch (err) {
    logger.error({ event: 'crew_schedule_list_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /dashboard/crew-schedule/next-available — next available date for a crew
// ---------------------------------------------------------------------------

router.get('/dashboard/crew-schedule/next-available', async (req: Request, res: Response) => {
  try {
    const { crew } = req.query;

    if (!crew || (crew !== 'hp1' && crew !== 'hp2')) {
      res.status(400).json({ error: 'crew is required (hp1 or hp2)' });
      return;
    }

    const result = await pool.query(`
      SELECT MAX(start_date + estimated_days * INTERVAL '1 day') as next_available,
             COUNT(*)::int as jobs_scheduled
      FROM crew_schedule
      WHERE crew = $1 AND status IN ('scheduled', 'in_progress')
    `, [crew]);

    const row = result.rows[0];
    const nextAvailable = row.next_available
      ? new Date(row.next_available).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    res.json({
      crew,
      next_available_date: nextAvailable,
      jobs_scheduled: row.jobs_scheduled || 0,
    });
  } catch (err) {
    logger.error({ event: 'crew_schedule_next_available_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /dashboard/crew-schedule — create a schedule entry + update prospect
// ---------------------------------------------------------------------------

router.post('/dashboard/crew-schedule', async (req: Request, res: Response) => {
  try {
    const { prospect_id, crew, start_date, estimated_days, crew_size, crew_members } = req.body;

    if (!prospect_id || !crew || !start_date || !estimated_days) {
      res.status(400).json({ error: 'prospect_id, crew, start_date, and estimated_days are required' });
      return;
    }

    // 1. Insert schedule entry
    const scheduleResult = await pool.query(
      `INSERT INTO crew_schedule (prospect_id, crew, start_date, estimated_days, status, crew_size, crew_members)
       VALUES ($1, $2, $3, $4, 'scheduled', $5, $6)
       RETURNING *`,
      [prospect_id, crew, start_date, estimated_days, crew_size || 2, crew_members || null]
    );

    // 2. Update prospect
    await pool.query(
      `UPDATE hardscape_prospects
       SET crew_assignment = $1, scheduled_start = $2, estimated_crew_days = $3,
           stage = 'scheduled', stage_updated_at = NOW(), updated_at = NOW()
       WHERE id = $4`,
      [crew, start_date, estimated_days, prospect_id]
    );

    // 3. Add comment
    const crewLabel = CREW_DISPLAY[crew] || crew;
    const dateFormatted = new Date(start_date + 'T12:00:00').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    await pool.query(
      `INSERT INTO prospect_comments (prospect_id, source, author, content, activity_date)
       VALUES ($1, 'agent', 'Dashboard', $2, NOW())`,
      [prospect_id, `Assigned to ${crewLabel} starting ${dateFormatted} for ${estimated_days} day${estimated_days > 1 ? 's' : ''}`]
    );

    // 4. Get next available date for this crew
    const nextResult = await pool.query(`
      SELECT MAX(start_date + estimated_days * INTERVAL '1 day') as next_available
      FROM crew_schedule
      WHERE crew = $1 AND status IN ('scheduled', 'in_progress')
    `, [crew]);

    const nextAvailable = nextResult.rows[0].next_available
      ? new Date(nextResult.rows[0].next_available).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    res.status(201).json({
      schedule_entry: scheduleResult.rows[0],
      next_available_date: nextAvailable,
    });
  } catch (err) {
    logger.error({ event: 'crew_schedule_create_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /dashboard/crew-schedule/:id — update a schedule entry
// ---------------------------------------------------------------------------

router.patch('/dashboard/crew-schedule/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { start_date, estimated_days, crew_size, crew_members, crew } = req.body;

    // Get current entry
    const current = await pool.query('SELECT * FROM crew_schedule WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Schedule entry not found' });
      return;
    }
    const entry = current.rows[0];

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let paramIdx = 1;
    const changes: string[] = [];

    if (start_date !== undefined) {
      setClauses.push(`start_date = $${paramIdx}`);
      values.push(start_date);
      paramIdx++;
      changes.push(`start date → ${start_date}`);
    }
    if (estimated_days !== undefined) {
      setClauses.push(`estimated_days = $${paramIdx}`);
      values.push(estimated_days);
      paramIdx++;
      changes.push(`estimated days → ${estimated_days}`);
    }
    if (crew_size !== undefined) {
      setClauses.push(`crew_size = $${paramIdx}`);
      values.push(crew_size);
      paramIdx++;
      changes.push(`crew size → ${crew_size}`);
    }
    if (crew_members !== undefined) {
      setClauses.push(`crew_members = $${paramIdx}`);
      values.push(crew_members || null);
      paramIdx++;
      if (crew_members) changes.push(`crew members → ${crew_members}`);
    }
    if (crew !== undefined) {
      setClauses.push(`crew = $${paramIdx}`);
      values.push(crew);
      paramIdx++;
      const crewLabel = CREW_DISPLAY[crew] || crew;
      changes.push(`crew → ${crewLabel}`);
    }

    if (values.length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE crew_schedule SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );

    // Sync prospect if crew or start_date changed
    if (crew !== undefined) {
      await pool.query(
        'UPDATE hardscape_prospects SET crew_assignment = $1, updated_at = NOW() WHERE id = $2',
        [crew, entry.prospect_id]
      );
    }
    if (start_date !== undefined) {
      await pool.query(
        'UPDATE hardscape_prospects SET scheduled_start = $1, updated_at = NOW() WHERE id = $2',
        [start_date, entry.prospect_id]
      );
    }
    if (estimated_days !== undefined) {
      await pool.query(
        'UPDATE hardscape_prospects SET estimated_crew_days = $1, updated_at = NOW() WHERE id = $2',
        [estimated_days, entry.prospect_id]
      );
    }

    // Add comment
    if (changes.length > 0) {
      await pool.query(
        `INSERT INTO prospect_comments (prospect_id, source, author, content, activity_date)
         VALUES ($1, 'agent', 'Dashboard', $2, NOW())`,
        [entry.prospect_id, `Schedule updated: ${changes.join(', ')}`]
      );
    }

    res.json({ schedule_entry: result.rows[0] });
  } catch (err) {
    logger.error({ event: 'crew_schedule_update_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /dashboard/crew-schedule/:id — remove from schedule
// ---------------------------------------------------------------------------

router.delete('/dashboard/crew-schedule/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const current = await pool.query('SELECT * FROM crew_schedule WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Schedule entry not found' });
      return;
    }
    const entry = current.rows[0];

    await pool.query('DELETE FROM crew_schedule WHERE id = $1', [id]);

    await pool.query(
      `UPDATE hardscape_prospects
       SET crew_assignment = NULL, scheduled_start = NULL,
           stage = 'deposit_invoice', stage_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [entry.prospect_id]
    );

    await pool.query(
      `INSERT INTO prospect_comments (prospect_id, source, author, content, activity_date)
       VALUES ($1, 'agent', 'Dashboard', 'Removed from crew schedule — returned to Deposit Invoice stage', NOW())`,
      [entry.prospect_id]
    );

    res.json({ deleted: true });
  } catch (err) {
    logger.error({ event: 'crew_schedule_delete_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /dashboard/crew-schedule/:id/delay — preview delay (no update)
// ---------------------------------------------------------------------------

router.patch('/dashboard/crew-schedule/:id/delay', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { days, reason } = req.body;

    if (!days || days < 1) {
      res.status(400).json({ error: 'days is required and must be >= 1' });
      return;
    }

    // 1. Get the entry
    const entryResult = await pool.query('SELECT * FROM crew_schedule WHERE id = $1', [id]);
    if (entryResult.rows.length === 0) {
      res.status(404).json({ error: 'Schedule entry not found' });
      return;
    }
    const entry = entryResult.rows[0];

    // 2. Find all affected entries
    const affectedResult = await pool.query(`
      SELECT cs.*, hp.sm8_client_name
      FROM crew_schedule cs
      JOIN hardscape_prospects hp ON cs.prospect_id = hp.id
      WHERE cs.crew = $1 AND cs.start_date >= $2
        AND cs.status IN ('scheduled', 'in_progress')
      ORDER BY cs.start_date ASC
    `, [entry.crew, entry.start_date]);

    // 3. Build preview
    const affected = affectedResult.rows.map((row: Record<string, unknown>) => {
      const oldStart = new Date(row.start_date as string);
      const newStart = new Date(oldStart);
      newStart.setDate(newStart.getDate() + days);
      const estDays = row.estimated_days as number;
      const oldEnd = new Date(oldStart);
      oldEnd.setDate(oldEnd.getDate() + estDays);
      const newEnd = new Date(newStart);
      newEnd.setDate(newEnd.getDate() + estDays);

      return {
        id: row.id,
        sm8_client_name: row.sm8_client_name,
        old_start_date: oldStart.toISOString().split('T')[0],
        new_start_date: newStart.toISOString().split('T')[0],
        old_end_date: oldEnd.toISOString().split('T')[0],
        new_end_date: newEnd.toISOString().split('T')[0],
      };
    });

    res.json({
      crew: entry.crew,
      days,
      reason: reason || null,
      affected,
    });
  } catch (err) {
    logger.error({ event: 'crew_schedule_delay_preview_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /dashboard/crew-schedule/:id/delay/confirm — execute delay
// ---------------------------------------------------------------------------

router.post('/dashboard/crew-schedule/:id/delay/confirm', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { days, reason } = req.body;

    if (!days || days < 1) {
      res.status(400).json({ error: 'days is required and must be >= 1' });
      return;
    }

    // 1. Get the entry
    const entryResult = await pool.query('SELECT * FROM crew_schedule WHERE id = $1', [id]);
    if (entryResult.rows.length === 0) {
      res.status(404).json({ error: 'Schedule entry not found' });
      return;
    }
    const entry = entryResult.rows[0];

    // 2. Bulk update
    const updateResult = await pool.query(`
      UPDATE crew_schedule
      SET start_date = start_date + $1 * INTERVAL '1 day',
          delay_reason = $2,
          status = CASE WHEN status = 'scheduled' THEN 'scheduled' ELSE status END,
          updated_at = NOW()
      WHERE crew = $3 AND start_date >= $4
        AND status IN ('scheduled', 'in_progress')
      RETURNING id, prospect_id, start_date
    `, [days, reason || null, entry.crew, entry.start_date]);

    // 3. Add comment to each affected prospect
    const reasonSuffix = reason ? ` Reason: ${reason}` : '';
    for (const row of updateResult.rows) {
      const newDate = new Date(row.start_date).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      await pool.query(
        `INSERT INTO prospect_comments (prospect_id, source, author, content, activity_date)
         VALUES ($1, 'agent', 'Dashboard', $2, NOW())`,
        [row.prospect_id, `Delay of ${days} day${days > 1 ? 's' : ''} applied.${reasonSuffix} New start: ${newDate}`]
      );

      // Also update the prospect's scheduled_start
      await pool.query(
        `UPDATE hardscape_prospects SET scheduled_start = $1, updated_at = NOW() WHERE id = $2`,
        [row.start_date, row.prospect_id]
      );
    }

    res.json({
      shifted_count: updateResult.rowCount,
      crew: entry.crew,
      days,
      reason: reason || null,
    });
  } catch (err) {
    logger.error({ event: 'crew_schedule_delay_confirm_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
