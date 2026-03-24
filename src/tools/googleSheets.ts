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
