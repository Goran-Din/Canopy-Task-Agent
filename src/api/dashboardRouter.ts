import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import logger from '../logger';
import { ProspectStage } from '../types';
import { runHardscapeSync, isHardscapeSyncRunning } from '../workers/hardscapeSync';
import { runInvoiceSyncNow, isInvoiceSyncRunning } from '../workers/invoiceSync';
import { getConfigValue } from '../db/queries';

const router = Router();

// Business timezone. All "today" calculations use US Central so dates don't
// drift against the server's UTC clock near midnight.
const BUSINESS_TZ = 'America/Chicago';

// Today's date as 'YYYY-MM-DD' in the business timezone ('en-CA' → ISO order).
function todayInBusinessTz(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Phase 4a billing aggregation. For each prospect, sum its prospect_invoices and
// list them, computing the DISPLAY status on read (never stored): Paid when the
// raw Xero status is paid; Overdue when unpaid and past due_date in Central
// (the `todayParam` placeholder, a 'YYYY-MM-DD' bound to todayInBusinessTz());
// otherwise Invoiced. total_paid counts only paid invoices' amounts.
// `p` must be the hardscape_prospects alias in the host query.
function invoiceAggJoin(todayParam: string): string {
  return `
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(pi.amount), 0) AS total_invoiced,
          COALESCE(SUM(CASE WHEN LOWER(pi.status) = 'paid' THEN pi.amount ELSE 0 END), 0) AS total_paid,
          COALESCE(json_agg(json_build_object(
            'invoice_number', pi.invoice_number,
            'amount', pi.amount,
            'status', CASE
                        WHEN LOWER(pi.status) = 'paid' THEN 'Paid'
                        WHEN pi.due_date IS NOT NULL AND pi.due_date < ${todayParam}::date THEN 'Overdue'
                        ELSE 'Invoiced'
                      END,
            'raw_status', pi.status,
            'due_date', to_char(pi.due_date, 'YYYY-MM-DD'),
            'paid_date', to_char(pi.paid_date, 'YYYY-MM-DD'),
            'note', pi.note,
            'source', pi.source,
            'xero_invoice_id', pi.xero_invoice_id
          ) ORDER BY pi.due_date NULLS LAST, pi.invoice_number), '[]'::json) AS invoices
        FROM prospect_invoices pi
        WHERE pi.prospect_id = p.id
      ) inv ON true`;
}

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
        inv.total_invoiced, inv.total_paid, inv.invoices,
        jc.comment_text AS job_comment,
        (SELECT COUNT(*)::int FROM prospect_comments pc WHERE pc.prospect_id = p.id) AS comment_count,
        (SELECT pc.content FROM prospect_comments pc WHERE pc.prospect_id = p.id
           ORDER BY pc.activity_date DESC, pc.id DESC LIMIT 1) AS latest_comment,
        COALESCE((
          SELECT json_agg(json_build_object(
                   'id', r.id, 'due_date', to_char(r.due_date, 'YYYY-MM-DD'), 'note', r.note
                 ) ORDER BY r.due_date ASC, r.id ASC)
          FROM prospect_reminders r
          WHERE r.prospect_id = p.id AND r.status = 'open'
        ), '[]'::json) AS reminders
      FROM hardscape_prospects p
      LEFT JOIN users u ON u.telegram_id = p.assigned_to
      LEFT JOIN invoice_cache ic ON ic.sm8_job_uuid = p.sm8_job_uuid
      LEFT JOIN job_comments jc ON jc.sm8_job_uuid = p.sm8_job_uuid
      ${invoiceAggJoin('$1')}
      WHERE p.stage NOT IN ('completed', 'lost_opportunity') AND NOT p.hidden
      ORDER BY p.stage ASC, p.updated_at DESC
    `, [todayInBusinessTz()]);

    res.json({ prospects: result.rows });
  } catch (err) {
    logger.error({ event: 'dashboard_get_prospects_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /dashboard/projects — ALL hardscape projects (active + completed + lost)
// One row per project (per job). Powers the CRM List view. Reuses the same
// invoice_cache and job_comments joins the existing badges/notes already use.
// ---------------------------------------------------------------------------

router.get('/dashboard/projects', async (req: Request, res: Response) => {
  try {
    // By default hidden projects are excluded; ?includeHidden=true returns all.
    const includeHidden = req.query.includeHidden === 'true';
    const result = await pool.query(`
      SELECT
        p.id, p.sm8_job_number, p.sm8_job_uuid, p.sm8_client_name,
        p.stage, p.crew_assignment, p.scope_summary, p.quoted_total, p.sm8_status,
        p.job_address, p.design_number,
        p.is_duplicate, p.duplicate_of_prospect_id,
        p.hidden, p.hidden_reason, p.hidden_at,
        p.gdrive_url, p.gdrive_label, p.client_folder_url,
        p.follow_up_date, p.possible_start_date, p.actual_start_date,
        p.scope_is_manual, p.quoted_total_is_manual, p.project_total,
        to_char((COALESCE(p.sm8_completion_date, p.completed_at) AT TIME ZONE 'America/Chicago'),
                'YYYY-MM-DD') AS completed_on,
        to_char((p.sm8_created_date AT TIME ZONE 'America/Chicago'), 'YYYY-MM-DD') AS quote_created_on,
        p.notes, p.scheduled_start, p.created_at, p.updated_at,
        u.name AS assigned_to_name,
        ic.invoice_status, ic.invoice_number, ic.invoice_amount,
        ic.due_date AS invoice_due_date, ic.paid_date AS invoice_paid_date,
        inv.total_invoiced, inv.total_paid, inv.invoices,
        jc.comment_text AS job_comment,
        (SELECT COUNT(*)::int FROM prospect_comments pc WHERE pc.prospect_id = p.id) AS comment_count,
        (SELECT pc.content FROM prospect_comments pc WHERE pc.prospect_id = p.id
           ORDER BY pc.activity_date DESC, pc.id DESC LIMIT 1) AS latest_comment
      FROM hardscape_prospects p
      LEFT JOIN users u ON u.telegram_id = p.assigned_to
      LEFT JOIN invoice_cache ic ON ic.sm8_job_uuid = p.sm8_job_uuid
      LEFT JOIN job_comments jc ON jc.sm8_job_uuid = p.sm8_job_uuid
      ${invoiceAggJoin('$1')}
      ${includeHidden ? '' : 'WHERE NOT p.hidden'}
      ORDER BY p.updated_at DESC
    `, [todayInBusinessTz()]);

    res.json({ projects: result.rows });
  } catch (err) {
    logger.error({ event: 'dashboard_get_projects_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /dashboard/sync — on-demand one-way SM8 → dashboard pull.
// Runs the SAME function the 2-hour cron runs (runHardscapeSync), behind the
// single-instance lock. Read-only against ServiceM8 — no SM8 write endpoints.
// ---------------------------------------------------------------------------

router.post('/dashboard/sync', async (_req: Request, res: Response) => {
  try {
    const result = await runHardscapeSync();

    if ('alreadyRunning' in result) {
      // Another sync (manual or cron) is already in flight — don't start a second.
      res.status(409).json({ alreadyRunning: true, message: 'A sync is already running.' });
      return;
    }

    res.json({ ok: true, summary: result });
  } catch (err) {
    logger.error({ event: 'dashboard_sync_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Sync failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /dashboard/sync-status — last-sync info + whether a sync is running now.
// ---------------------------------------------------------------------------

router.get('/dashboard/sync-status', async (_req: Request, res: Response) => {
  try {
    const raw = await getConfigValue('hardscape_last_sync');
    let lastSync: unknown = null;
    if (raw) {
      try { lastSync = JSON.parse(raw); } catch { lastSync = null; }
    }
    res.json({ running: isHardscapeSyncRunning(), last_sync: lastSync });
  } catch (err) {
    logger.error({ event: 'dashboard_sync_status_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /dashboard/sync-xero — on-demand Xero invoice sync (the Completed tab's
// "Sync from Xero" button). Read-only against Xero: pages ALL invoices and
// refreshes invoice_cache + prospect_invoices — the SAME work the hourly cron
// does. Returns the structured result so the UI can handle the day-limit case
// gracefully. A ~60s manual cooldown + single-instance lock prevent spamming.
// ---------------------------------------------------------------------------

router.post('/dashboard/sync-xero', async (_req: Request, res: Response) => {
  try {
    const result = await runInvoiceSyncNow({ manual: true });

    // Already running → 409 (mirror the ServiceM8 sync's contract).
    if (result.status === 'already_running') {
      res.status(409).json(result);
      return;
    }
    // ok / day_limited / cooldown / error all carry a structured body the UI
    // reads; 200 so the client doesn't treat day_limited/cooldown as failures.
    res.json(result);
  } catch (err) {
    logger.error({ event: 'dashboard_sync_xero_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ status: 'error', error: 'Xero sync failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /dashboard/sync-xero-status — last Xero invoice-sync result + whether a
// sync is running now (drives the Completed tab's "Last synced" label).
// ---------------------------------------------------------------------------

router.get('/dashboard/sync-xero-status', async (_req: Request, res: Response) => {
  try {
    const raw = await getConfigValue('xero_invoice_last_sync');
    let lastSync: unknown = null;
    if (raw) {
      try { lastSync = JSON.parse(raw); } catch { lastSync = null; }
    }
    res.json({ running: isInvoiceSyncRunning(), last_sync: lastSync });
  } catch (err) {
    logger.error({ event: 'dashboard_sync_xero_status_error', error: err instanceof Error ? err.message : String(err) });
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
        to_char((COALESCE(p.sm8_completion_date, p.completed_at) AT TIME ZONE 'America/Chicago'),
                'YYYY-MM-DD') AS completed_on,
        to_char((p.sm8_created_date AT TIME ZONE 'America/Chicago'), 'YYYY-MM-DD') AS quote_created_on,
        ic.invoice_status, ic.invoice_number, ic.invoice_amount, ic.due_date AS invoice_due_date, ic.paid_date AS invoice_paid_date,
        inv.total_invoiced, inv.total_paid, inv.invoices,
        jc.comment_text AS job_comment
      FROM hardscape_prospects p
      LEFT JOIN users u ON u.telegram_id = p.assigned_to
      LEFT JOIN invoice_cache ic ON ic.sm8_job_uuid = p.sm8_job_uuid
      LEFT JOIN job_comments jc ON jc.sm8_job_uuid = p.sm8_job_uuid
      ${invoiceAggJoin('$2')}
      WHERE p.id = $1
    `, [id, todayInBusinessTz()]);

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
        stage || 'request_site_visit',
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

    // Allowed fields for update. All edits stay in Postgres — this handler
    // NEVER writes back to ServiceM8 (the SM8 → dashboard flow is one-way).
    const allowedFields = [
      'sm8_client_name', 'sm8_client_uuid', 'sm8_job_uuid', 'sm8_job_number',
      'stage', 'notes', 'assigned_to', 'estimated_crew_days', 'crew_assignment',
      'scheduled_start', 'client_folder_url', 'design_number',
      // Spreadsheet-editable fields
      'scope_summary', 'quoted_total', 'gdrive_url', 'gdrive_label',
      'follow_up_date', 'possible_start_date', 'actual_start_date',
    ];

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let paramIdx = 1;

    // Treat empty strings as NULL for the nullable editable fields so the sync's
    // is_manual gating and the date columns behave correctly when a cell is cleared.
    const nullableEditable = new Set([
      'scope_summary', 'quoted_total', 'gdrive_url', 'gdrive_label',
      'follow_up_date', 'possible_start_date', 'actual_start_date',
    ]);

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        const raw = body[field];
        const value = nullableEditable.has(field) && (raw === '' || raw === null)
          ? null
          : raw;
        setClauses.push(`${field} = $${paramIdx}`);
        values.push(value);
        paramIdx++;
      }
    }

    // Manual-edit flags: once the user sets scope/value it is "manual" and the
    // SM8 pull must never overwrite it; clearing the cell hands control back to SM8.
    if (body.scope_summary !== undefined) {
      const cleared = body.scope_summary === '' || body.scope_summary === null;
      setClauses.push(`scope_is_manual = ${cleared ? 'FALSE' : 'TRUE'}`);
    }
    if (body.quoted_total !== undefined) {
      const cleared = body.quoted_total === '' || body.quoted_total === null;
      setClauses.push(`quoted_total_is_manual = ${cleared ? 'FALSE' : 'TRUE'}`);
    }

    // If stage changed, also update stage_updated_at
    if (body.stage !== undefined) {
      setClauses.push(`stage_updated_at = NOW()`);
      // Stamp our own completion date on the transition to 'completed', but only
      // if not already stamped (COALESCE keeps an existing value). Never set on
      // other stage changes; never overwritten once set.
      if (body.stage === 'completed') {
        setClauses.push(`completed_at = COALESCE(completed_at, NOW())`);
      }
    }

    // Hide / unhide — reversible flag (handled here, not via allowedFields, so
    // we can enforce the reason requirement and manage hidden_at).
    if (body.hidden !== undefined) {
      if (body.hidden === true) {
        const reason = typeof body.hidden_reason === 'string' ? body.hidden_reason.trim() : '';
        if (!reason) {
          res.status(400).json({ error: 'hidden_reason is required when hiding a project' });
          return;
        }
        setClauses.push(`hidden = TRUE`);
        setClauses.push(`hidden_at = NOW()`);
        setClauses.push(`hidden_reason = $${paramIdx}`);
        values.push(reason);
        paramIdx++;
      } else {
        // Unhide — clear the reason and timestamp.
        setClauses.push(`hidden = FALSE`);
        setClauses.push(`hidden_reason = NULL`);
        setClauses.push(`hidden_at = NULL`);
      }
    }

    // setClauses always carries the default `updated_at = NOW()`; anything more
    // means a real change (note: unhide adds literal clauses but no values).
    if (setClauses.length === 1) {
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
// Follow-up reminders
// ---------------------------------------------------------------------------

// GET /dashboard/prospects/:id/reminders — open reminders, soonest due first.
router.get('/dashboard/prospects/:id/reminders', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT id, prospect_id, to_char(due_date, 'YYYY-MM-DD') AS due_date, note, status
       FROM prospect_reminders
       WHERE prospect_id = $1 AND status = 'open'
       ORDER BY due_date ASC, id ASC`,
      [id]
    );
    res.json({ reminders: result.rows });
  } catch (err) {
    logger.error({ event: 'reminders_list_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /dashboard/prospects/:id/reminders { due_date, note } — create an open reminder.
router.post('/dashboard/prospects/:id/reminders', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { due_date, note } = req.body;

    if (!due_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(due_date))) {
      res.status(400).json({ error: 'due_date (YYYY-MM-DD) is required' });
      return;
    }
    if (!note || !String(note).trim()) {
      res.status(400).json({ error: 'note is required' });
      return;
    }

    const exists = await pool.query('SELECT 1 FROM hardscape_prospects WHERE id = $1', [id]);
    if (exists.rows.length === 0) {
      res.status(404).json({ error: 'Prospect not found' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO prospect_reminders (prospect_id, due_date, note)
       VALUES ($1, $2, $3)
       RETURNING id, prospect_id, to_char(due_date, 'YYYY-MM-DD') AS due_date, note, status`,
      [id, due_date, String(note).trim()]
    );

    // Keep history in the single comment thread.
    await pool.query(
      `INSERT INTO prospect_comments (prospect_id, source, author, content, activity_date)
       VALUES ($1, 'agent', 'Dashboard', $2, NOW())`,
      [id, `Reminder set for ${due_date}: ${String(note).trim()}`]
    );

    res.status(201).json({ reminder: result.rows[0] });
  } catch (err) {
    logger.error({ event: 'reminder_create_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /dashboard/reminders/:id/done — dismiss a reminder (status='done'). No delete.
router.post('/dashboard/reminders/:id/done', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE prospect_reminders
       SET status = 'done', updated_at = NOW()
       WHERE id = $1
       RETURNING id, prospect_id, to_char(due_date, 'YYYY-MM-DD') AS due_date, note, status`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Reminder not found' });
      return;
    }
    const r = result.rows[0];

    await pool.query(
      `INSERT INTO prospect_comments (prospect_id, source, author, content, activity_date)
       VALUES ($1, 'agent', 'Dashboard', $2, NOW())`,
      [r.prospect_id, `Reminder done: ${r.note}`]
    );

    res.json({ reminder: r });
  } catch (err) {
    logger.error({ event: 'reminder_done_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /dashboard/archive — completed/closed prospects with filters
// ---------------------------------------------------------------------------

router.get('/dashboard/archive', async (req: Request, res: Response) => {
  try {
    const { outcome, crew, date_from, date_to, search } = req.query;
    // Hidden rows are excluded by default; ?includeHidden=true reveals them so
    // hidden lost/duplicate jobs remain auditable in Archive.
    const includeHidden = req.query.includeHidden === 'true';

    // Archive = unsuccessful OR flagged duplicate. Completed jobs now live in the
    // dedicated Completed tab, so they are intentionally excluded here.
    const conditions: string[] = [`(p.stage = 'lost_opportunity' OR p.is_duplicate = true)`];
    if (!includeHidden) conditions.push(`NOT p.hidden`);
    const values: unknown[] = [];
    let paramIdx = 1;

    if (outcome === 'lost_opportunity') {
      conditions.push(`p.stage = 'lost_opportunity'`);
    } else if (outcome === 'duplicate') {
      conditions.push(`p.is_duplicate = true`);
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
    const { crew, from_date, to_date, status } = req.query;

    // Default view excludes completed jobs (active calendar). Pass status=completed
    // to fetch the completed list instead.
    const conditions: string[] =
      status === 'completed' ? [`cs.status = 'completed'`] : [`cs.status NOT IN ('completed')`];
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
      SELECT cs.*,
             to_char(cs.start_date, 'YYYY-MM-DD') AS start_date,
             hp.sm8_client_name, hp.sm8_job_number, hp.stage,
             hp.notes, hp.assigned_to,
             hp.needs_sealing, hp.needs_landscape,
             hp.job_address, hp.design_number,
             hp.client_folder_url, hp.gdrive_url, hp.gdrive_label,
             (SELECT COUNT(*)::int FROM prospect_comments pc WHERE pc.prospect_id = hp.id) AS comment_count,
             (SELECT pc.content FROM prospect_comments pc WHERE pc.prospect_id = hp.id
                ORDER BY pc.activity_date DESC, pc.id DESC LIMIT 1) AS latest_comment,
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
    const today = todayInBusinessTz();
    const computed = row.next_available
      ? new Date(row.next_available).toISOString().split('T')[0]
      : today;
    // Never return a past date — floor at today (US Central).
    const nextAvailable = computed < today ? today : computed;

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
           stage = 'scheduled_for_work', stage_updated_at = NOW(), updated_at = NOW()
       WHERE id = $4`,
      [crew, start_date, estimated_days, prospect_id]
    );

    // 3. Add comment
    const crewLabel = CREW_DISPLAY[crew] || crew;
    const dateFormatted = new Date(start_date + 'T12:00:00').toLocaleDateString('en-US', {
      timeZone: BUSINESS_TZ, month: 'short', day: 'numeric', year: 'numeric',
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

    const today = todayInBusinessTz();
    const computedNext = nextResult.rows[0].next_available
      ? new Date(nextResult.rows[0].next_available).toISOString().split('T')[0]
      : today;
    const nextAvailable = computedNext < today ? today : computedNext;

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
           stage = 'quote_accepted', stage_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [entry.prospect_id]
    );

    await pool.query(
      `INSERT INTO prospect_comments (prospect_id, source, author, content, activity_date)
       VALUES ($1, 'agent', 'Dashboard', 'Removed from crew schedule — returned to Quote accepted stage', NOW())`,
      [entry.prospect_id]
    );

    res.json({ deleted: true });
  } catch (err) {
    logger.error({ event: 'crew_schedule_delete_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /dashboard/crew-schedule/:id/complete — mark a job completed
// ---------------------------------------------------------------------------

router.post('/dashboard/crew-schedule/:id/complete', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const current = await pool.query('SELECT * FROM crew_schedule WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Schedule entry not found' });
      return;
    }

    // 1. Mark the schedule entry completed (fill actual_days if not set).
    const updateResult = await pool.query(
      `UPDATE crew_schedule
       SET status = 'completed',
           actual_days = COALESCE(actual_days, estimated_days),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    const entry = updateResult.rows[0];

    // 2. Move the linked prospect to the completed stage (stamp our completion
    //    date only if not already set — never overwrite an existing stamp).
    await pool.query(
      `UPDATE hardscape_prospects
       SET stage = 'completed', stage_updated_at = NOW(),
           completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
       WHERE id = $1`,
      [entry.prospect_id]
    );

    // 3. Record a comment on the prospect.
    const dateFormatted = new Date().toLocaleDateString('en-US', {
      timeZone: BUSINESS_TZ, month: 'short', day: 'numeric', year: 'numeric',
    });
    await pool.query(
      `INSERT INTO prospect_comments (prospect_id, source, author, content, activity_date)
       VALUES ($1, 'agent', 'Dashboard', $2, NOW())`,
      [entry.prospect_id, `Job marked completed on ${dateFormatted}`]
    );

    res.json({ schedule_entry: entry });
  } catch (err) {
    logger.error({ event: 'crew_schedule_complete_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /dashboard/crew-schedule/:id/status — set job progress status
//   scheduled    → crew_schedule.status='scheduled' AND prospect → scheduled_for_work
//   in_progress  → crew_schedule.status='in_progress' AND prospect → work_in_progress
//   paused       → crew_schedule.status='paused' (hold, requires reason); prospect
//                  stage is left unchanged. A pause is NOT a delay — it never
//                  shifts other jobs.
// (Completed is handled by the /complete endpoint above → prospect = completed.)
// ---------------------------------------------------------------------------

const JOB_STATUS_VALUES = ['scheduled', 'in_progress', 'paused'] as const;

router.post('/dashboard/crew-schedule/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!JOB_STATUS_VALUES.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${JOB_STATUS_VALUES.join(', ')}` });
      return;
    }
    if (status === 'paused' && (!reason || !String(reason).trim())) {
      res.status(400).json({ error: 'reason is required when pausing' });
      return;
    }

    const current = await pool.query('SELECT * FROM crew_schedule WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Schedule entry not found' });
      return;
    }
    const entry = current.rows[0];

    const updated = await pool.query(
      `UPDATE crew_schedule SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );

    // Keep the prospect's pipeline stage in sync with the job status.
    //   in_progress → work_in_progress
    //   scheduled   → scheduled_for_work (e.g. resumed/un-started)
    //   paused      → leave unchanged (hold; stays work_in_progress)
    if (status === 'in_progress') {
      await pool.query(
        `UPDATE hardscape_prospects
         SET stage = 'work_in_progress', stage_updated_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [entry.prospect_id]
      );
    } else if (status === 'scheduled') {
      await pool.query(
        `UPDATE hardscape_prospects
         SET stage = 'scheduled_for_work', stage_updated_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [entry.prospect_id]
      );
    }

    // Append a line to the prospect's single comment thread.
    const note =
      status === 'in_progress' ? 'Work started'
      : status === 'paused'    ? `Paused: ${String(reason).trim()}`
      : 'Set back to Scheduled';
    await pool.query(
      `INSERT INTO prospect_comments (prospect_id, source, author, content, activity_date)
       VALUES ($1, 'agent', 'Dashboard', $2, NOW())`,
      [entry.prospect_id, note]
    );

    res.json({ schedule_entry: updated.rows[0] });
  } catch (err) {
    logger.error({ event: 'crew_schedule_status_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /dashboard/prospects/:id/flags — toggle a follow-up flag
//   body: { flag: 'needs_sealing' | 'needs_landscape', value: boolean }
// Writes the boolean on the prospect and appends a thread line.
// ---------------------------------------------------------------------------

const PROSPECT_FLAGS: Record<string, string> = {
  needs_sealing: 'Needs Sealing',
  needs_landscape: 'Needs Landscape',
};

router.post('/dashboard/prospects/:id/flags', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { flag, value } = req.body;

    if (!Object.prototype.hasOwnProperty.call(PROSPECT_FLAGS, flag)) {
      res.status(400).json({ error: `flag must be one of: ${Object.keys(PROSPECT_FLAGS).join(', ')}` });
      return;
    }
    const boolValue = value === true || value === 'true';

    // Column name is from the fixed whitelist above — safe to interpolate.
    const updated = await pool.query(
      `UPDATE hardscape_prospects SET ${flag} = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, needs_sealing, needs_landscape`,
      [boolValue, id]
    );
    if (updated.rows.length === 0) {
      res.status(404).json({ error: 'Prospect not found' });
      return;
    }

    const label = PROSPECT_FLAGS[flag];
    await pool.query(
      `INSERT INTO prospect_comments (prospect_id, source, author, content, activity_date)
       VALUES ($1, 'agent', 'Dashboard', $2, NOW())`,
      [id, `${boolValue ? 'Flagged' : 'Unflagged'}: ${label}`]
    );

    res.json({ prospect: updated.rows[0] });
  } catch (err) {
    logger.error({ event: 'prospect_flag_error', error: err instanceof Error ? err.message : String(err) });
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
