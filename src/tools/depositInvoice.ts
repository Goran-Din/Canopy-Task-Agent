import { pool } from '../db/pool';
import { bot } from '../telegram/bot';
import { getJobQuoteDetails, getXeroContactForSM8Job } from './servicem8';
import { createDepositInvoice } from './xero';
import { syncDepositTrackerToSheet } from './googleSheets';
import logger from '../logger';

// ---------------------------------------------------------------------------
// In-memory pending deposit confirmations
// ---------------------------------------------------------------------------

interface PendingDeposit {
  job: {
    uuid: string;
    jobNumber: string;
    clientName: string;
    companyUuid: string;
    description: string;
    totalAmount: number;
    lineItems: Array<{ description: string; unitAmount: number; quantity: number }>;
    projectType: 'hardscape' | 'landscape';
  };
  contact: { contactId: string; name: string; clientId: string | null };
  firstPaymentPercent: number;
  depositAmount: number;
}

const pending_deposits = new Map<number, PendingDeposit>();

/** Check if a user has a pending deposit awaiting confirmation */
export function hasPendingDeposit(telegramId: number): boolean {
  return pending_deposits.has(telegramId);
}

// ---------------------------------------------------------------------------
// Payment terms extraction
// ---------------------------------------------------------------------------

function extractFirstPaymentPercent(description: string): number | null {
  // Match patterns like "30%", "30/30/40", "50% deposit", "deposit 30%"
  const percentMatch = description.match(/(\d{1,3})\s*%/);
  if (percentMatch) {
    const pct = parseInt(percentMatch[1], 10);
    if (pct > 0 && pct <= 100) return pct;
  }
  // Match split patterns like "30/30/40"
  const splitMatch = description.match(/(\d{1,3})\/\d{1,3}/);
  if (splitMatch) {
    const pct = parseInt(splitMatch[1], 10);
    if (pct > 0 && pct <= 100) return pct;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 1: Request deposit invoice — shows preview for confirmation
// ---------------------------------------------------------------------------

export async function handleDepositInvoiceRequest(
  telegramId: number,
  jobNumberOrName: string
): Promise<string> {
  try {
    const job = await getJobQuoteDetails(jobNumberOrName);
    if (!job) {
      return 'Job not found in ServiceM8. Please check the job number and try again.';
    }

    let contact = await getXeroContactForSM8Job(job.companyUuid, job.clientName);
    if (!contact) {
      // Fallback: check nc_client_folders directly for xero_contact_id
      const dbFallback = await pool.query(
        `SELECT xero_contact_id, client_id, sm8_client_name
         FROM nc_client_folders
         WHERE sm8_client_uuid = $1 OR sm8_client_name ILIKE $2
         LIMIT 1`,
        [job.companyUuid, `%${job.clientName}%`]
      );
      if (dbFallback.rows.length > 0 && dbFallback.rows[0].xero_contact_id) {
        const row = dbFallback.rows[0];
        contact = { contactId: row.xero_contact_id, name: row.sm8_client_name || job.clientName, clientId: row.client_id || null };
        logger.info({ event: 'deposit_contact_db_fallback', name: contact.name, clientId: contact.clientId });
      } else {
        return `Client not found in Xero for job #${job.jobNumber} (${job.clientName}). Please add them to Xero first.`;
      }
    }

    const firstPaymentPercent = extractFirstPaymentPercent(job.description) || 30;
    const depositAmount = (job.totalAmount * firstPaymentPercent) / 100;

    pending_deposits.set(telegramId, { job, contact, firstPaymentPercent, depositAmount });

    const descPreview = job.description.length > 300
      ? job.description.substring(0, 300) + '...'
      : job.description;

    const contactInfo = contact.clientId
      ? `${contact.name} (${contact.clientId})`
      : contact.name;

    return `\u{1F4CB} Job #${job.jobNumber} \u2014 ${job.clientName}
Xero contact: ${contactInfo}
Project type: ${job.projectType === 'hardscape' ? '\u{1F3D7}\uFE0F Hardscape' : '\u{1F33F} Landscape'}
Total quote value: $${job.totalAmount.toFixed(2)}

Payment terms found:
${descPreview}

This is the first deposit \u2014 amount: $${depositAmount.toFixed(2)} (${firstPaymentPercent}%)

Reply YES to create the draft invoice, or specify a different percentage (e.g. "40%")`;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ event: 'deposit_invoice_request_error', error: error.message });
    return `Error looking up job: ${error.message}`;
  }
}

// ---------------------------------------------------------------------------
// Step 2: Confirm and create the deposit invoice
// ---------------------------------------------------------------------------

export async function confirmDepositInvoice(
  telegramId: number,
  overridePercent?: number
): Promise<string> {
  const pending = pending_deposits.get(telegramId);
  if (!pending) {
    return 'No pending deposit invoice. Please start with the job number.';
  }

  try {
    const percent = overridePercent || pending.firstPaymentPercent;
    const amount = (pending.job.totalAmount * percent) / 100;

    // Create Xero draft invoice
    const invoice = await createDepositInvoice({
      xeroContactId: pending.contact.contactId,
      contactName: pending.contact.name,
      jobNumber: pending.job.jobNumber,
      sm8JobUuid: pending.job.uuid,
      lineItems: pending.job.lineItems.map((li) => ({
        description: li.description,
        unitAmount: li.unitAmount,
      })),
      depositAmount: amount,
      depositPercent: percent,
      totalProjectAmount: pending.job.totalAmount,
      paymentTerms: pending.job.description,
      projectType: pending.job.projectType,
    });

    // Save to deposit_tracker table
    const balanceDue = pending.job.totalAmount - amount;
    await pool.query(
      `INSERT INTO deposit_tracker
        (project_type, client_name, sm8_job_uuid, sm8_job_number,
         total_project_amount, payment_terms, deposit_xero_inv_id, deposit_inv_number,
         deposit_amount, balance_due, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        pending.job.projectType,
        pending.contact.name,
        pending.job.uuid,
        pending.job.jobNumber,
        pending.job.totalAmount,
        pending.job.description,
        invoice.invoiceId,
        invoice.invoiceNumber,
        amount,
        balanceDue,
        'Awaiting Deposit',
      ]
    );

    // Sync to Google Sheet (best effort)
    try {
      await syncDepositTrackerToSheet(pending.job.projectType);
    } catch (sheetErr) {
      logger.warn({ event: 'deposit_sheet_sync_failed', error: sheetErr instanceof Error ? sheetErr.message : String(sheetErr) });
    }

    // Send notifications
    const notification = `\u{1F4B0} Deposit invoice created
Client: ${pending.contact.name}
Job: #${pending.job.jobNumber}
Invoice: ${invoice.invoiceNumber}
Amount due: $${amount.toFixed(2)} (${percent}%)
Status: Awaiting Approval in Xero`;

    const notifyIds = pending.job.projectType === 'hardscape'
      ? [8049966920, 8559729036, 1996235953]  // Erick, Marcin, Goran
      : [8049966920, 1996235953];              // Erick, Goran

    for (const id of notifyIds) {
      try {
        await bot.sendMessage(id, notification, { parse_mode: 'HTML' });
      } catch { /* best effort */ }
    }

    logger.info({
      event: 'deposit_invoice_created',
      job: pending.job.jobNumber,
      invoice: invoice.invoiceNumber,
      amount,
      percent,
      projectType: pending.job.projectType,
    });

    pending_deposits.delete(telegramId);

    return `\u2705 Draft invoice ${invoice.invoiceNumber} created for $${amount.toFixed(2)}
It is now in Xero awaiting approval.
Hristina or Gordana can review and send it to ${pending.contact.name}.
Recorded in the ${pending.job.projectType} deposit tracker.`;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ event: 'deposit_invoice_confirm_error', error: error.message });
    return `Error creating invoice: ${error.message}`;
  }
}
