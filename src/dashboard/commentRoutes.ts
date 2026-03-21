import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import logger from '../logger';

const router = Router();

router.get('/comment/:jobUuid', async (req: Request, res: Response) => {
  try {
    const { jobUuid } = req.params;
    const result = await pool.query(
      'SELECT * FROM job_comments WHERE sm8_job_uuid = $1',
      [jobUuid]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    logger.error({
      event: 'comment_route_get_error',
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/comment/:jobUuid', async (req: Request, res: Response) => {
  try {
    const { jobUuid } = req.params;
    const { comment_text, division } = req.body || {};

    if (!comment_text || !division) {
      res.status(400).json({ error: 'comment_text and division are required' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO job_comments (sm8_job_uuid, division, comment_text, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (sm8_job_uuid) DO UPDATE SET
         comment_text = EXCLUDED.comment_text,
         division = EXCLUDED.division,
         updated_at = NOW()
       RETURNING *`,
      [jobUuid, division, comment_text]
    );

    res.json(result.rows[0]);
  } catch (err) {
    logger.error({
      event: 'comment_route_post_error',
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
