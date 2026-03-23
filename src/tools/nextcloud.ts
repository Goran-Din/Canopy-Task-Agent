import axios from 'axios';
import { config } from '../config';
import { pool } from '../db/pool';
import logger from '../logger';

const NC = config.nextcloud;

const webdavBase = `${NC.url}/remote.php/dav/files/${NC.webdavUser}`;
const ocsShareBase = `${NC.url}/ocs/v2.php/apps/files_sharing/api/v1/shares`;

const ncAuth = { username: NC.adminUser, password: NC.adminPass };

// ── Helpers ─────────────────────────────────────────────────────

/** Strip characters that are unsafe in folder names */
export function sanitizeFolderName(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Generate a client-friendly password: FirstName + 7 random alphanumeric chars + '!' */
export function generateClientPassword(clientName: string): string {
  const firstName = clientName.split(/\s+/)[0] || 'Client';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  // Ensure at least one uppercase, one lowercase, one digit
  let suffix = upper[Math.floor(Math.random() * upper.length)];
  suffix += lower[Math.floor(Math.random() * lower.length)];
  suffix += digits[Math.floor(Math.random() * digits.length)];
  for (let i = 0; i < 4; i++) {
    suffix += all[Math.floor(Math.random() * all.length)];
  }
  // Shuffle the suffix
  suffix = suffix.split('').sort(() => Math.random() - 0.5).join('');
  return firstName + suffix + '!';
}

// ── WebDAV operations ───────────────────────────────────────────

/** Check if a folder exists in Nextcloud via PROPFIND */
export async function folderExists(folderPath: string): Promise<boolean> {
  try {
    await axios({
      method: 'PROPFIND',
      url: `${webdavBase}${folderPath}`,
      auth: ncAuth,
      headers: { Depth: '0' },
      timeout: 10000,
    });
    return true;
  } catch (err: unknown) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status === 404) return false;
    throw err;
  }
}

/** Create a client folder, set group share + public link, save to DB, update SM8 notes */
export async function createClientFolder(
  sm8ClientUuid: string,
  sm8ClientName: string
): Promise<{ folderPath: string; publicUrl: string; password: string }> {
  const safeName = sanitizeFolderName(sm8ClientName);
  const folderPath = `${NC.clientsRoot}/${safeName}`;

  // 1. Ensure /Clients root exists
  const rootExists = await folderExists(NC.clientsRoot);
  if (!rootExists) {
    await axios({
      method: 'MKCOL',
      url: `${webdavBase}${NC.clientsRoot}`,
      auth: ncAuth,
      timeout: 10000,
    });
    logger.info({ event: 'nc_root_created', path: NC.clientsRoot });
  }

  // 2. Create client folder
  const exists = await folderExists(folderPath);
  if (!exists) {
    await axios({
      method: 'MKCOL',
      url: `${webdavBase}${folderPath}`,
      auth: ncAuth,
      timeout: 10000,
    });
    logger.info({ event: 'nc_folder_created', path: folderPath, client: sm8ClientName });
  }

  // 3. Share with Back Office group (shareType=1)
  try {
    await axios.post(
      ocsShareBase,
      new URLSearchParams({
        path: folderPath,
        shareType: '1',
        shareWith: NC.teamGroup,
        permissions: '31', // all permissions
      }).toString(),
      {
        auth: ncAuth,
        headers: {
          'OCS-APIREQUEST': 'true',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      }
    );
  } catch (err: unknown) {
    // 403 = already shared — that's fine
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status !== 403) {
      logger.warn({ event: 'nc_group_share_error', path: folderPath, error: String(err) });
    }
  }

  // 4. Create public link with password (shareType=3)
  const password = generateClientPassword(sm8ClientName);
  let publicUrl = '';
  try {
    const shareRes = await axios.post(
      ocsShareBase,
      new URLSearchParams({
        path: folderPath,
        shareType: '3',
        permissions: '1', // read-only
        password,
      }).toString(),
      {
        auth: ncAuth,
        headers: {
          'OCS-APIREQUEST': 'true',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      }
    );
    const shareData = shareRes.data?.ocs?.data;
    publicUrl = shareData?.url || '';
  } catch (err: unknown) {
    const detail = axios.isAxiosError(err) ? JSON.stringify(err.response?.data || '') : String(err);
    logger.warn({ event: 'nc_public_link_error', path: folderPath, error: String(err), detail });
  }

  // 5. Save to database
  await pool.query(
    `INSERT INTO nc_client_folders (sm8_client_uuid, sm8_client_name, folder_path, public_url, share_password)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sm8_client_uuid) DO UPDATE
       SET sm8_client_name = $2, folder_path = $3, public_url = $4, share_password = $5, updated_at = NOW()`,
    [sm8ClientUuid, sm8ClientName, folderPath, publicUrl, password]
  );

  // 6. Update SM8 client notes with folder link
  await updateSM8ClientNotes(sm8ClientUuid, publicUrl, password);

  logger.info({
    event: 'nc_client_folder_ready',
    client: sm8ClientName,
    path: folderPath,
    publicUrl,
  });

  return { folderPath, publicUrl, password };
}

/** Append Nextcloud link to the SM8 company notes field */
async function updateSM8ClientNotes(
  companyUuid: string,
  publicUrl: string,
  password: string
): Promise<void> {
  if (!publicUrl) return;
  try {
    const sm8Api = axios.create({
      baseURL: config.servicem8.baseUrl,
      headers: {
        'X-API-Key': config.servicem8.apiKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    // Fetch current notes
    const res = await sm8Api.get(`/company.json`, { params: { uuid: companyUuid } });
    const company = res.data?.[0];
    if (!company) return;

    const currentNotes: string = company.notes || '';
    const ncTag = '[Nextcloud]';

    // Don't duplicate if already present
    if (currentNotes.includes(ncTag)) return;

    const newNotes = currentNotes
      ? `${currentNotes}\n\n${ncTag}\nFolder: ${publicUrl}\nPassword: ${password}`
      : `${ncTag}\nFolder: ${publicUrl}\nPassword: ${password}`;

    await sm8Api.post(`/company/${companyUuid}.json`, { notes: newNotes });

    logger.info({ event: 'sm8_notes_updated', company_uuid: companyUuid });
  } catch (err) {
    logger.warn({
      event: 'sm8_notes_update_error',
      company_uuid: companyUuid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Query functions (used by Telegram bot tool) ─────────────────

/** Look up a client folder by SM8 UUID */
export async function getClientFolder(
  sm8ClientUuid: string
): Promise<{ folder_path: string; public_url: string; share_password: string } | null> {
  const result = await pool.query(
    'SELECT folder_path, public_url, share_password FROM nc_client_folders WHERE sm8_client_uuid = $1',
    [sm8ClientUuid]
  );
  return result.rows[0] || null;
}

/** Look up a client folder by name (partial match) */
export async function getClientFolderByName(
  clientName: string
): Promise<{ sm8_client_uuid: string; sm8_client_name: string; folder_path: string; public_url: string; share_password: string } | null> {
  const result = await pool.query(
    `SELECT sm8_client_uuid, sm8_client_name, folder_path, public_url, share_password
     FROM nc_client_folders
     WHERE LOWER(sm8_client_name) LIKE LOWER($1)
     ORDER BY updated_at DESC
     LIMIT 1`,
    [`%${clientName}%`]
  );
  return result.rows[0] || null;
}
