import cron from 'node-cron';
import axios from 'axios';
import { pool } from '../db/pool';
import { bot } from '../telegram/bot';
import { getAccessToken } from '../tools/xero';
import { getConfigValue } from '../db/queries';
import { syncDepositTrackerToSheet } from '../tools/googleSheets';
import logger from '../logger';

const XERO_API_URL = 'https://api.xero.com/api.xro/2.0';

export async function checkDepositPayments(): Promise<void> {
  try {
    const rows = await pool.query(
      `SELECT id, project_type, client_name, sm8_job_number, deposit_xero_inv_id,
              deposit_amount, balance_due
       FROM deposit_tracker
       WHERE deposit_paid_date IS NULL AND deposit_xero_inv_id IS NOT NULL`
    );

    if (rows.rows.length === 0) return;

    const token = await getAccessToken();
    const tenantId = await getConfigValue('xero_tenant_id');
    if (!tenantId) return;

    for (const row of rows.rows) {
      try {
        const res = await axios.get(`${XERO_API_URL}/Invoices/${row.deposit_xero_inv_id}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Xero-Tenant-Id': tenantId,
            Accept: 'application/json',
          },
          timeout: 10000,
        });

        const invoice = res.data?.Invoices?.[0];
        if (!invoice || invoice.Status !== 'PAID') continue;

        // Update tracker
        const newBalance = Number(row.balance_due) - Number(row.deposit_amount);
        await pool.query(
          `UPDATE deposit_tracker
           SET deposit_paid_date = NOW(), status = 'In Progress',
               balance_due = $1, updated_at = NOW()
           WHERE id = $2`,
          [newBalance, row.id]
        );

        // Notify team
        const notification = `\u{1F4B5} Deposit received!
Client: ${row.client_name}
Job: #${row.sm8_job_number}
Amount: $${Number(row.deposit_amount).toFixed(2)}
Project is now funded \u2014 ready to schedule!`;

        const notifyIds = row.project_type === 'hardscape'
          ? [8049966920, 8559729036, 1996235953]  // Erick, Marcin, Goran
          : [8049966920, 1996235953];              // Erick, Goran

        for (const id of notifyIds) {
          try {
            await bot.sendMessage(id, notification, { parse_mode: 'HTML' });
          } catch { /* best effort */ }
        }

        // Sync tracker sheet
        try {
          await syncDepositTrackerToSheet(row.project_type);
        } catch { /* best effort */ }

        logger.info({
          event: 'deposit_payment_detected',
          job: row.sm8_job_number,
          client: row.client_name,
          amount: row.deposit_amount,
        });
      } catch (err) {
        logger.warn({
          event: 'deposit_payment_check_error',
          invoiceId: row.deposit_xero_inv_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error({
      event: 'deposit_payment_sync_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startDepositPaymentSync(): void {
  logger.info({ event: 'deposit_payment_sync_init' });

  // Run every hour at :30
  cron.schedule('30 * * * *', () => {
    checkDepositPayments();
  }, { timezone: 'America/Chicago' });

  logger.info({ event: 'deposit_payment_sync_scheduled', interval: 'hourly at :30' });
}
