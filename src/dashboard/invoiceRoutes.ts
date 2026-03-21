import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import logger from '../logger';

const router = Router();

router.get('/invoice/:jobUuid', async (req: Request, res: Response) => {
  try {
    const { jobUuid } = req.params;
    const result = await pool.query(
      'SELECT * FROM invoice_cache WHERE sm8_job_uuid = $1',
      [jobUuid]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    logger.error({
      event: 'invoice_route_error',
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
