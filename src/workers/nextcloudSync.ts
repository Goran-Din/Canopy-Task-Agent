import axios from 'axios';
import cron from 'node-cron';
import { config } from '../config';
import { pool } from '../db/pool';
import { getAccessToken, updateXeroAccountNumber } from '../tools/xero';
import { createClientFolder, updateSM8ClientNotes, generateClientId, getNextSequence } from '../tools/nextcloud';
import { syncClientDirectoryToSheet } from '../tools/googleSheets';
import { getConfigValue } from '../db/queries';
import logger from '../logger';

const SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour
const XERO_API_URL = 'https://api.xero.com/api.xro/2.0';

// ── Xero customer fetcher ───────────────────────────────────────

async function fetchXeroCustomers(): Promise<Array<{ id: string; name: string }>> {
  const token = await getAccessToken();
  const tenantId = await getConfigValue('xero_tenant_id');
  if (!tenantId) throw new Error('Xero tenant ID not configured.');

  const headers = {
    Authorization: `Bearer ${token}`,
    'Xero-Tenant-Id': tenantId,
    Accept: 'application/json',
  };

  const customers: Array<{ id: string; name: string }> = [];
  let page = 1;

  while (true) {
    const res = await axios.get(`${XERO_API_URL}/Contacts`, {
      headers,
      params: { page },
      timeout: 15000,
    });

    const contacts: Array<{ ContactID: string; Name: string; IsCustomer: boolean }> =
      res.data?.Contacts || [];

    if (contacts.length === 0) break;

    for (const c of contacts) {
      if (c.IsCustomer === true) {
        customers.push({ id: c.ContactID, name: c.Name });
      }
    }

    // Xero returns 100 per page; fewer means last page
    if (contacts.length < 100) break;
    page++;
  }

  return customers;
}

// ── SM8 client name matcher ─────────────────────────────────────

async function findSM8ClientByName(name: string): Promise<string | null> {
  try {
    const sm8Api = axios.create({
      baseURL: config.servicem8.baseUrl,
      headers: { 'X-API-Key': config.servicem8.apiKey, Accept: 'application/json' },
      timeout: 10000,
    });
    const res = await sm8Api.get('/company.json');
    const companies: Array<{ uuid: string; name: string }> = res.data || [];
    const match = companies.find(
      (c) => c.name && c.name.toLowerCase() === name.toLowerCase()
    );
    return match?.uuid || null;
  } catch {
    return null;
  }
}

// ── Main sync ───────────────────────────────────────────────────

async function syncNextcloudFolders(): Promise<void> {
  if (!config.nextcloud.url) {
    logger.warn({ event: 'nc_sync_skip', reason: 'NEXTCLOUD_URL not configured' });
    return;
  }

  try {
    // Step 1: Fetch all Xero customers
    const customers = await fetchXeroCustomers();
    logger.info({ event: 'nc_sync_start', total_xero_customers: customers.length });

    // Step 2: Get existing xero_contact_ids from DB
    const existing = await pool.query('SELECT xero_contact_id FROM nc_client_folders');
    const existingSet = new Set(
      existing.rows.map((r: { xero_contact_id: string }) => r.xero_contact_id)
    );

    // Step 3: Create folders for new customers
    const newCustomers = customers.filter((c) => !existingSet.has(c.id));

    if (newCustomers.length === 0) {
      logger.info({ event: 'nc_sync_done', new_folders: 0 });
    } else {
      logger.info({ event: 'nc_sync_creating', count: newCustomers.length });

      let created = 0;
      let errors = 0;

      for (const customer of newCustomers) {
        try {
          const result = await createClientFolder(customer.id, customer.name);
          created++;

          // Try to find matching SM8 client and update their notes
          const sm8Uuid = await findSM8ClientByName(customer.name);
          if (sm8Uuid) {
            try {
              await updateSM8ClientNotes(sm8Uuid, result.publicUrl, result.password);
              await pool.query(
                `UPDATE nc_client_folders SET sm8_client_uuid = $1, sm8_note_updated = TRUE WHERE xero_contact_id = $2`,
                [sm8Uuid, customer.id]
              );
            } catch {
              logger.warn({ event: 'nc_sync_sm8_note_fail', customer: customer.name });
            }
          }

          // Log progress every 10 folders
          if (created % 10 === 0) {
            logger.info({ event: 'nc_sync_progress', message: `NC sync: ${created}/${newCustomers.length} folders created` });
          }

          // 500ms delay to avoid overwhelming Nextcloud
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (err) {
          errors++;
          logger.error({
            event: 'nc_sync_folder_error',
            client: customer.name,
            xero_id: customer.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info({ event: 'nc_sync_done', new_folders: created, errors });
    }

    // Step 4: Sync client directory to Google Sheets
    await syncClientDirectoryToSheet().catch((e) =>
      logger.error({ event: 'sheets_sync_error', error: e instanceof Error ? e.message : String(e) })
    );

    // Step 5: Retry SM8 note updates for folders that failed previously
    const pendingNotes = await pool.query(
      `SELECT xero_contact_id, sm8_client_name, public_url, share_password
       FROM nc_client_folders
       WHERE sm8_note_updated = FALSE AND public_url IS NOT NULL AND public_url != ''`
    );

    if (pendingNotes.rows.length > 0) {
      logger.info({ event: 'nc_sync_retry_notes', count: pendingNotes.rows.length });

      for (const row of pendingNotes.rows) {
        const sm8Uuid = await findSM8ClientByName(row.sm8_client_name);
        if (sm8Uuid) {
          try {
            await updateSM8ClientNotes(sm8Uuid, row.public_url, row.share_password);
            await pool.query(
              `UPDATE nc_client_folders SET sm8_client_uuid = $1, sm8_note_updated = TRUE WHERE xero_contact_id = $2`,
              [sm8Uuid, row.xero_contact_id]
            );
          } catch {
            logger.warn({ event: 'nc_sync_retry_note_fail', customer: row.sm8_client_name });
          }
        }
      }
    }
  } catch (err) {
    logger.error({
      event: 'nc_sync_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Client ID assignment ────────────────────────────────────────

async function fetchXeroCustomersOrdered(): Promise<Array<{ id: string; name: string }>> {
  const token = await getAccessToken();
  const tenantId = await getConfigValue('xero_tenant_id');
  if (!tenantId) throw new Error('Xero tenant ID not configured.');

  const headers = {
    Authorization: `Bearer ${token}`,
    'Xero-Tenant-Id': tenantId,
    Accept: 'application/json',
  };

  const customers: Array<{ id: string; name: string }> = [];
  let page = 1;

  while (true) {
    const res = await axios.get(`${XERO_API_URL}/Contacts`, {
      headers,
      params: { page, order: 'UpdatedDateUTC ASC' },
      timeout: 15000,
    });

    const contacts: Array<{ ContactID: string; Name: string; IsCustomer: boolean }> =
      res.data?.Contacts || [];

    if (contacts.length === 0) break;

    for (const c of contacts) {
      if (c.IsCustomer === true) {
        customers.push({ id: c.ContactID, name: c.Name });
      }
    }

    if (contacts.length < 100) break;
    page++;
  }

  return customers;
}

async function assignClientIds(): Promise<void> {
  try {
    // Step 1: Fetch all Xero customers ordered by UpdatedDateUTC ASC
    const customers = await fetchXeroCustomersOrdered();
    logger.info({ event: 'client_id_assign_start', total_customers: customers.length });

    // Step 2: Build map of existing records
    const existing = await pool.query(
      'SELECT xero_contact_id, client_id, xero_id_updated FROM nc_client_folders'
    );
    const dbMap = new Map<string, { client_id: string | null; xero_id_updated: boolean }>();
    for (const row of existing.rows) {
      dbMap.set(row.xero_contact_id, {
        client_id: row.client_id,
        xero_id_updated: row.xero_id_updated,
      });
    }

    // Step 3: Assign IDs and update Xero
    let sequence = await getNextSequence();
    const year = new Date().getFullYear() % 100; // 26 for 2026
    let assigned = 0;
    let xeroUpdated = 0;
    let retried = 0;
    let errors = 0;

    for (const customer of customers) {
      const record = dbMap.get(customer.id);

      // No DB record yet — skip (folder not created yet)
      if (!record) continue;

      // Already fully done
      if (record.client_id && record.xero_id_updated) continue;

      try {
        let clientId = record.client_id;

        // Assign new client ID if needed
        if (!clientId) {
          clientId = generateClientId(year, sequence++);
          await pool.query(
            'UPDATE nc_client_folders SET client_id = $1 WHERE xero_contact_id = $2',
            [clientId, customer.id]
          );
          assigned++;
        } else {
          retried++;
        }

        // Update Xero AccountNumber
        const success = await updateXeroAccountNumber(customer.id, clientId);
        if (success) {
          await pool.query(
            'UPDATE nc_client_folders SET xero_id_updated = TRUE WHERE xero_contact_id = $1',
            [customer.id]
          );
          xeroUpdated++;
        }

        // Log progress every 25 clients
        if ((assigned + retried) % 25 === 0 && (assigned + retried) > 0) {
          logger.info({ event: 'client_id_progress', assigned, xeroUpdated, retried });
        }

        // 200ms rate limit
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (err) {
        errors++;
        logger.warn({
          event: 'client_id_assign_error',
          customer: customer.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({ event: 'client_id_assign_done', assigned, xeroUpdated, retried, errors });
  } catch (err) {
    logger.error({
      event: 'client_id_assign_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Exports ─────────────────────────────────────────────────────

/** Manual trigger — used by `docker exec` one-off calls */
export async function syncNextcloudFoldersNow(): Promise<void> {
  return syncNextcloudFolders();
}

export function startNextcloudSync(): void {
  // Run first sync after 30 seconds (let other services boot first)
  setTimeout(() => {
    syncNextcloudFolders().catch((err) =>
      logger.error({ event: 'nc_sync_initial_error', error: String(err) })
    );
  }, 30_000);

  // Run client ID assignment after 60 seconds
  setTimeout(() => {
    assignClientIds().catch((err) =>
      logger.error({ event: 'client_id_initial_error', error: String(err) })
    );
  }, 60_000);

  // Then every hour: folder sync + client ID assignment
  setInterval(() => {
    syncNextcloudFolders()
      .then(() => assignClientIds())
      .catch((err) =>
        logger.error({ event: 'nc_sync_interval_error', error: String(err) })
      );
  }, SYNC_INTERVAL);

  // Daily 6 AM CT — full Google Sheets refresh
  cron.schedule('0 6 * * *', () => {
    syncClientDirectoryToSheet().catch((err) =>
      logger.error({ event: 'sheets_daily_sync_error', error: String(err) })
    );
  }, { timezone: 'America/Chicago' });

  logger.info({ event: 'nc_sync_scheduled', interval_ms: SYNC_INTERVAL });
}
