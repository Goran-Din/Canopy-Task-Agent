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

export default router;
