import axios from 'axios';
import { config } from '../config';
import { pool } from '../db/pool';
import { getAccessToken } from '../tools/xero';
import { createClientFolder, updateSM8ClientNotes } from '../tools/nextcloud';
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

    // Step 4: Retry SM8 note updates for folders that failed previously
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

  // Then every hour
  setInterval(() => {
    syncNextcloudFolders().catch((err) =>
      logger.error({ event: 'nc_sync_interval_error', error: String(err) })
    );
  }, SYNC_INTERVAL);

  logger.info({ event: 'nc_sync_scheduled', interval_ms: SYNC_INTERVAL });
}
