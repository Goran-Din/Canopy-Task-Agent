import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { adminAuthMiddleware } from '../dashboard/adminAuth';
import logger from '../logger';

const router = Router();

// All admin/knowledge routes require auth
router.use('/admin/knowledge', adminAuthMiddleware);

// ---------------------------------------------------------------------------
// GET /admin/knowledge — list all documents
// ---------------------------------------------------------------------------
router.get('/admin/knowledge', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM knowledge_base ORDER BY updated_at DESC'
    );
    res.json({ documents: result.rows });
  } catch (err) {
    logger.error({ event: 'kb_list_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/knowledge/search?q=term — full-text search
// ---------------------------------------------------------------------------
router.get('/admin/knowledge/search', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim();
    if (!q) {
      res.status(400).json({ error: 'q parameter is required' });
      return;
    }
    const result = await pool.query(
      `SELECT *, ts_rank(to_tsvector('english', title || ' ' || content), plainto_tsquery('english', $1)) AS rank
       FROM knowledge_base
       WHERE to_tsvector('english', title || ' ' || content) @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT 20`,
      [q]
    );
    res.json({ documents: result.rows });
  } catch (err) {
    logger.error({ event: 'kb_search_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/knowledge/:id — single document
// ---------------------------------------------------------------------------
router.get('/admin/knowledge/:id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM knowledge_base WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    res.json({ document: result.rows[0] });
  } catch (err) {
    logger.error({ event: 'kb_get_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/knowledge — create document
// ---------------------------------------------------------------------------
router.post('/admin/knowledge', async (req: Request, res: Response) => {
  try {
    const { title, content, category, tags } = req.body;
    if (!title || !content) {
      res.status(400).json({ error: 'title and content are required' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO knowledge_base (title, content, category, tags)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [title, content, category || 'general', tags || []]
    );
    res.status(201).json({ document: result.rows[0] });
  } catch (err) {
    logger.error({ event: 'kb_create_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /admin/knowledge/:id — update document
// ---------------------------------------------------------------------------
router.patch('/admin/knowledge/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, content, category, tags } = req.body;

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (title !== undefined) { setClauses.push(`title = $${paramIdx}`); values.push(title); paramIdx++; }
    if (content !== undefined) { setClauses.push(`content = $${paramIdx}`); values.push(content); paramIdx++; }
    if (category !== undefined) { setClauses.push(`category = $${paramIdx}`); values.push(category); paramIdx++; }
    if (tags !== undefined) { setClauses.push(`tags = $${paramIdx}`); values.push(tags); paramIdx++; }

    if (values.length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE knowledge_base SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    res.json({ document: result.rows[0] });
  } catch (err) {
    logger.error({ event: 'kb_update_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /admin/knowledge/:id — delete document
// ---------------------------------------------------------------------------
router.delete('/admin/knowledge/:id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query('DELETE FROM knowledge_base WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ event: 'kb_delete_error', error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
