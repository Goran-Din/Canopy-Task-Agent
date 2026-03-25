import { google } from 'googleapis';
import * as fs from 'fs';
import { pool } from '../db/pool';
import { getAccessToken } from './xero';
import { getConfigValue, setConfigValue } from '../db/queries';
import axios from 'axios';
import logger from '../logger';

const SHEET_TITLE = 'Sunset Services — Client Directory';
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1SIMR8y7cdi-kdtlVuHiwkm-9FFbAJXGh';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || '/app/config/google-service-account.json';
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];
const XERO_API_URL = 'https://api.xero.com/api.xro/2.0';

function getAuth() {
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
  });
}

// ── Sheet management ────────────────────────────────────────────

export async function createOrGetSheet(): Promise<string> {
  const existing = await getConfigValue('google_sheets_client_dir_id');
  if (existing) return existing;

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  // Create spreadsheet in the Client Directory folder
  const file = await drive.files.create({
    requestBody: {
      name: SHEET_TITLE,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [FOLDER_ID],
    },
    supportsAllDrives: true,
    fields: 'id',
  });
  const spreadsheetId = file.data.id!;

  // Format header row
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: 0,
              title: 'Clients',
              gridProperties: { frozenRowCount: 1 },
            },
            fields: 'title,gridProperties.frozenRowCount',
          },
        },
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                backgroundColor: { red: 0.13, green: 0.33, blue: 0.24 },
              },
            },
            fields: 'userEnteredFormat',
          },
        },
      ],
    },
  });

  // Write headers
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Clients!A1:I1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        'Client ID', 'Full Name', 'Email', 'Phone',
        'Address', 'City', 'State', 'Zip',
        'Nextcloud Folder Link',
      ]],
    },
  });

  // Save to config_store
  await setConfigValue('google_sheets_client_dir_id', spreadsheetId);

  logger.info({ event: 'google_sheet_created', spreadsheetId });
  return spreadsheetId;
}

// ── Deposit Tracker Sheets ──────────────────────────────────────

const TRACKER_HEADERS = [
  'Client', 'Job #', 'Total Project', 'Deposit Inv #', 'Deposit Amt', 'Deposit Paid',
  'Payment 2 Inv #', 'Payment 2 Amt', 'Payment 2 Paid',
  'Final Inv #', 'Final Amt', 'Final Paid', 'Balance Due', 'Status',
];

export async function createOrGetDepositTrackerSheets(): Promise<{ hardscapeId: string; landscapeId: string }> {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  async function ensureSheet(configKey: string, sheetTitle: string): Promise<string> {
    const existing = await getConfigValue(configKey);
    if (existing) return existing;

    const file = await drive.files.create({
      requestBody: {
        name: sheetTitle,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        parents: [FOLDER_ID],
      },
      supportsAllDrives: true,
      fields: 'id',
    });
    const spreadsheetId = file.data.id!;

    // Format header: bold, dark green bg, white text, frozen row
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: 0,
                title: 'Tracker',
                gridProperties: { frozenRowCount: 1 },
              },
              fields: 'title,gridProperties.frozenRowCount',
            },
          },
          {
            repeatCell: {
              range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                  backgroundColor: { red: 0.13, green: 0.33, blue: 0.24 },
                },
              },
              fields: 'userEnteredFormat',
            },
          },
        ],
      },
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Tracker!A1:N1',
      valueInputOption: 'RAW',
      requestBody: { values: [TRACKER_HEADERS] },
    });

    await setConfigValue(configKey, spreadsheetId);
    logger.info({ event: 'deposit_tracker_sheet_created', configKey, spreadsheetId });
    return spreadsheetId;
  }

  const hardscapeId = await ensureSheet(
    'google_sheets_hardscape_tracker_id',
    'Hardscape Project Deposit Tracker'
  );
  const landscapeId = await ensureSheet(
    'google_sheets_landscape_tracker_id',
    'Landscape Project Deposit Tracker'
  );

  return { hardscapeId, landscapeId };
}

export async function syncDepositTrackerToSheet(projectType: 'hardscape' | 'landscape'): Promise<void> {
  const configKey = projectType === 'hardscape'
    ? 'google_sheets_hardscape_tracker_id'
    : 'google_sheets_landscape_tracker_id';

  let spreadsheetId = await getConfigValue(configKey);
  if (!spreadsheetId) {
    const ids = await createOrGetDepositTrackerSheets();
    spreadsheetId = projectType === 'hardscape' ? ids.hardscapeId : ids.landscapeId;
  }

  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const result = await pool.query(
    `SELECT * FROM deposit_tracker WHERE project_type = $1 ORDER BY created_at ASC`,
    [projectType]
  );

  const rows = result.rows.map((r) => [
    r.client_name || '',
    r.sm8_job_number || '',
    r.total_project_amount ? Number(r.total_project_amount).toFixed(2) : '',
    r.deposit_inv_number || '',
    r.deposit_amount ? Number(r.deposit_amount).toFixed(2) : '',
    r.deposit_paid_date ? String(r.deposit_paid_date).split('T')[0] : 'Pending',
    r.payment2_inv_number || '',
    r.payment2_amount ? Number(r.payment2_amount).toFixed(2) : '',
    r.payment2_paid_date ? String(r.payment2_paid_date).split('T')[0] : '',
    r.final_inv_number || '',
    r.final_amount ? Number(r.final_amount).toFixed(2) : '',
    r.final_paid_date ? String(r.final_paid_date).split('T')[0] : '',
    r.balance_due ? Number(r.balance_due).toFixed(2) : '',
    r.status || '',
  ]);

  // Clear existing data rows and rewrite
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Tracker!A2:N10000',
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Tracker!A2',
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }

  logger.info({ event: 'deposit_tracker_synced', projectType, rows: rows.length });
}

export async function updateDepositTrackerRow(
  jobNumber: string,
  updates: Record<string, unknown>
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }

  setClauses.push(`updated_at = NOW()`);
  values.push(jobNumber);

  await pool.query(
    `UPDATE deposit_tracker SET ${setClauses.join(', ')} WHERE sm8_job_number = $${idx}`,
    values
  );

  // Determine project type and sync
  const typeRes = await pool.query(
    'SELECT project_type FROM deposit_tracker WHERE sm8_job_number = $1 LIMIT 1',
    [jobNumber]
  );
  if (typeRes.rows[0]) {
    await syncDepositTrackerToSheet(typeRes.rows[0].project_type);
  }
}

// ── Sync client data to sheet ───────────────────────────────────

interface XeroContact {
  ContactID: string;
  Name: string;
  IsCustomer: boolean;
  EmailAddress?: string;
  Phones?: Array<{ PhoneType: string; PhoneNumber?: string; PhoneAreaCode?: string }>;
  Addresses?: Array<{
    AddressType: string;
    AddressLine1?: string;
    City?: string;
    Region?: string;
    PostalCode?: string;
  }>;
}

export async function syncClientDirectoryToSheet(): Promise<void> {
  // Step 1: Get or create sheet
  const spreadsheetId = await createOrGetSheet();
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  // Step 2: Fetch all Xero customers (paginated)
  const token = await getAccessToken();
  const tenantId = await getConfigValue('xero_tenant_id');
  if (!tenantId) throw new Error('Xero tenant ID not configured.');

  const allContacts: XeroContact[] = [];
  let page = 1;

  while (true) {
    const r = await axios.get(`${XERO_API_URL}/Contacts`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Xero-Tenant-Id': tenantId,
        Accept: 'application/json',
      },
      params: { page, includeArchived: false },
      timeout: 15000,
    });

    const contacts: XeroContact[] = r.data?.Contacts || [];
    if (contacts.length === 0) break;

    for (const c of contacts) {
      if (c.IsCustomer === true) {
        allContacts.push(c);
      }
    }

    if (contacts.length < 100) break;
    page++;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // Step 3: Get Nextcloud folder links from database
  const folderRows = await pool.query(
    'SELECT xero_contact_id, client_id, public_url FROM nc_client_folders ORDER BY client_id'
  );
  const folderMap = new Map<string, { client_id: string | null; public_url: string }>();
  for (const row of folderRows.rows) {
    folderMap.set(row.xero_contact_id, { client_id: row.client_id, public_url: row.public_url });
  }

  // Step 4: Build rows sorted by client_id
  const rows = allContacts
    .map((c) => {
      const folder = folderMap.get(c.ContactID);
      const phone = c.Phones?.find((p) => p.PhoneType === 'DEFAULT');
      const phoneStr = phone?.PhoneNumber
        ? (phone.PhoneAreaCode ? `(${phone.PhoneAreaCode}) ${phone.PhoneNumber}` : phone.PhoneNumber)
        : '';
      const addr =
        c.Addresses?.find((a) => a.AddressType === 'POBOX') ||
        c.Addresses?.find((a) => a.AddressType === 'STREET') ||
        {};
      return {
        clientId: folder?.client_id || '',
        row: [
          folder?.client_id || '',
          c.Name || '',
          c.EmailAddress || '',
          phoneStr,
          'AddressLine1' in addr ? addr.AddressLine1 || '' : '',
          'City' in addr ? addr.City || '' : '',
          'Region' in addr ? addr.Region || '' : '',
          'PostalCode' in addr ? addr.PostalCode || '' : '',
          folder?.public_url || '',
        ],
      };
    })
    .sort((a, b) => {
      if (!a.clientId) return 1;
      if (!b.clientId) return -1;
      return a.clientId.localeCompare(b.clientId);
    })
    .map((x) => x.row);

  // Step 5: Clear and rewrite all data
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Clients!A2:I10000',
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Clients!A2',
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }

  // Auto-resize columns
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          autoResizeDimensions: {
            dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 9 },
          },
        },
      ],
    },
  });

  logger.info({ event: 'google_sheet_synced', spreadsheetId, count: rows.length });
}
