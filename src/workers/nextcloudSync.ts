import axios from 'axios';
import { config } from '../config';
import { pool } from '../db/pool';
import { createClientFolder } from '../tools/nextcloud';
import logger from '../logger';

const sm8Api = axios.create({
  baseURL: config.servicem8.baseUrl,
  headers: {
    'X-API-Key': config.servicem8.apiKey,
    Accept: 'application/json',
  },
  timeout: 15000,
});

const SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour

async function syncNextcloudFolders(): Promise<void> {
  if (!config.nextcloud.url) {
    logger.warn({ event: 'nc_sync_skip', reason: 'NEXTCLOUD_URL not configured' });
    return;
  }

  try {
    // 1. Fetch all active SM8 clients
    const res = await sm8Api.get('/company.json', { params: { active: 1 } });
    const clients: { uuid: string; name: string }[] = (res.data || []).filter(
      (c: { uuid?: string; name?: string }) => c.uuid && c.name
    );

    logger.info({ event: 'nc_sync_start', total_clients: clients.length });

    // 2. Get already-synced UUIDs
    const existing = await pool.query('SELECT sm8_client_uuid FROM nc_client_folders');
    const existingSet = new Set(existing.rows.map((r: { sm8_client_uuid: string }) => r.sm8_client_uuid));

    // 3. Find new clients
    const newClients = clients.filter((c) => !existingSet.has(c.uuid));

    if (newClients.length === 0) {
      logger.info({ event: 'nc_sync_done', new_folders: 0 });
      return;
    }

    logger.info({ event: 'nc_sync_creating', count: newClients.length });

    let created = 0;
    let errors = 0;

    for (const client of newClients) {
      try {
        await createClientFolder(client.uuid, client.name);
        created++;
        // Small delay to avoid overwhelming Nextcloud
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (err) {
        errors++;
        logger.error({
          event: 'nc_sync_folder_error',
          client: client.name,
          uuid: client.uuid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({ event: 'nc_sync_done', new_folders: created, errors });
  } catch (err) {
    logger.error({
      event: 'nc_sync_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
