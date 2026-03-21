import { Router, Request, Response } from 'express';
import { getScheduleCache, fetchScheduleForDate } from '../workers/landscapeSync';
import { pool } from '../db/pool';
import logger from '../logger';
import { InvoiceBadge, LandscapeCrewSchedule } from '../types';

const router = Router();

/** Enrich crew schedules with invoice + comment data from DB */
async function enrichCrews(crews: LandscapeCrewSchedule[]): Promise<LandscapeCrewSchedule[]> {
  for (const crew of crews) {
    for (let i = 0; i < crew.jobs.length; i++) {
      const job = crew.jobs[i];

      // Invoice lookup
      try {
        const invRes = await pool.query(
          'SELECT invoice_status, invoice_number, invoice_amount, due_date, paid_date FROM invoice_cache WHERE sm8_job_uuid = $1',
          [job.job_uuid]
        );
        if (invRes.rows[0]) {
          const row = invRes.rows[0];
          const badge: InvoiceBadge = {
            status: row.invoice_status,
            invoice_number: row.invoice_number,
            invoice_amount: row.invoice_amount ? parseFloat(row.invoice_amount) : null,
            due_date: row.due_date ? String(row.due_date).split('T')[0] : null,
            paid_date: row.paid_date ? String(row.paid_date).split('T')[0] : null,
          };
          crew.jobs[i] = { ...job, invoice: badge };
        }
      } catch {
        // Keep existing invoice value (null from cache)
      }

      // Comment lookup
      try {
        const comRes = await pool.query(
          'SELECT comment_text FROM job_comments WHERE sm8_job_uuid = $1',
          [job.job_uuid]
        );
        if (comRes.rows[0]) {
          crew.jobs[i] = { ...crew.jobs[i], comment: comRes.rows[0].comment_text };
        }
      } catch {
        // Keep existing comment value (null from cache)
      }
    }
  }
  return crews;
}

router.get('/landscape/schedule', async (req: Request, res: Response) => {
  try {
    const cache = getScheduleCache();

    // Today and tomorrow dates in CT
    const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const tomorrowD = new Date();
    tomorrowD.setDate(tomorrowD.getDate() + 1);
    const tomorrowDate = tomorrowD.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    // Determine requested date (default: today)
    const requestedDate = (req.query.date as string) || todayDate;

    let crews: LandscapeCrewSchedule[];

    if (requestedDate === todayDate) {
      // Use cache for today
      if (!cache.lastSync) {
        res.json({ date: requestedDate, last_sync: null, crews: [] });
        return;
      }
      crews = cache.today.map((c) => ({ ...c, jobs: [...c.jobs] }));
    } else if (requestedDate === tomorrowDate) {
      // Use cache for tomorrow
      if (!cache.lastSync) {
        res.json({ date: requestedDate, last_sync: null, crews: [] });
        return;
      }
      crews = cache.tomorrow.map((c) => ({ ...c, jobs: [...c.jobs] }));
    } else {
      // Fetch live from SM8 for any other date
      crews = await fetchScheduleForDate(requestedDate);
    }

    // Enrich with invoice + comment data
    await enrichCrews(crews);

    res.json({
      date: requestedDate,
      last_sync: cache.lastSync,
      crews,
    });
  } catch (err) {
    logger.error({
      event: 'landscape_route_error',
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
