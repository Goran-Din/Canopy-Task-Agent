import cron from 'node-cron';
import { pool } from '../db/pool';
import { bot } from '../telegram/bot';
import logger from '../logger';

// Daily 10:00 AM America/Chicago follow-up nudge. Sends one grouped Telegram
// message to Goran and Marcin listing reminders due today or overdue that
// haven't been sent yet, then marks them notified so they don't re-send.

// Recipient chat ids (not secrets — the bot token comes from config).
const RECIPIENTS: Array<{ name: string; chatId: string }> = [
  { name: 'Goran', chatId: '1996235953' },
  { name: 'Marcin', chatId: '8559729036' },
];

/** Today's date as YYYY-MM-DD in America/Chicago. */
function todayCT(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

interface DueReminder {
  id: number;
  due_date: string;
  note: string;
  sm8_client_name: string;
  sm8_job_number: string | null;
}

/**
 * Run the nudge. With { dryRun: true } it composes the message and returns it
 * WITHOUT sending to Telegram or marking reminders notified — used for safe
 * verification. Returns the composed message (or null when nothing is due),
 * the target recipients, and the reminder ids involved.
 */
export async function runReminderNudge(
  opts: { dryRun?: boolean } = {}
): Promise<{ message: string | null; recipients: string[]; reminderIds: number[] }> {
  const recipientIds = RECIPIENTS.map((r) => r.chatId);
  try {
    const today = todayCT();
    const due = await pool.query(
      `SELECT r.id, to_char(r.due_date, 'YYYY-MM-DD') AS due_date, r.note,
              hp.sm8_client_name, hp.sm8_job_number
       FROM prospect_reminders r
       JOIN hardscape_prospects hp ON hp.id = r.prospect_id
       WHERE r.status = 'open' AND r.notified = false AND r.due_date <= $1::date
       ORDER BY r.due_date ASC, r.id ASC`,
      [today]
    );
    const rows = due.rows as DueReminder[];

    if (rows.length === 0) {
      logger.info({ event: 'reminder_nudge_none_due', today });
      return { message: null, recipients: recipientIds, reminderIds: [] };
    }

    const lines = rows.map((r) => {
      const job = r.sm8_job_number ? ` (Job #${r.sm8_job_number})` : '';
      return `• ${r.sm8_client_name}${job} — ${r.note} (due ${r.due_date})`;
    });
    const message = `🔔 Follow-ups due:\n${lines.join('\n')}`;
    const reminderIds = rows.map((r) => r.id);

    if (opts.dryRun) {
      logger.info({ event: 'reminder_nudge_dry_run', count: rows.length, recipients: recipientIds, message });
      return { message, recipients: recipientIds, reminderIds };
    }

    for (const { chatId } of RECIPIENTS) {
      try {
        await bot.sendMessage(chatId, message);
      } catch (err) {
        logger.error({
          event: 'reminder_nudge_send_error',
          recipient: chatId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue to the next recipient.
      }
    }

    await pool.query(
      `UPDATE prospect_reminders SET notified = true, notified_at = NOW() WHERE id = ANY($1::int[])`,
      [reminderIds]
    );

    logger.info({ event: 'reminder_nudge_sent', count: rows.length, recipients: recipientIds.length });
    return { message, recipients: recipientIds, reminderIds };
  } catch (err) {
    logger.error({ event: 'reminder_nudge_error', error: err instanceof Error ? err.message : String(err) });
    return { message: null, recipients: recipientIds, reminderIds: [] };
  }
}

export function startReminderNudge(): void {
  logger.info({ event: 'reminder_nudge_init' });
  // 10:00 AM CT daily
  cron.schedule('0 10 * * *', () => {
    runReminderNudge();
  }, { timezone: 'America/Chicago' });
  logger.info({ event: 'reminder_nudge_scheduled', time: '10:00 AM CT' });
}
