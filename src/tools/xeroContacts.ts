import axios from 'axios';
import { getAccessToken } from './xero';
import { getConfigValue } from '../db/queries';
import logger from '../logger';

const XERO_API_URL = 'https://api.xero.com/api.xro/2.0';

interface XeroContact {
  ContactID: string;
  Name: string;
  EmailAddress?: string;
  Phones?: Array<{ PhoneType: string; PhoneNumber?: string }>;
  ContactStatus?: string;
}

interface CreateXeroContactInput {
  name: string;
  phone?: string;
  email?: string;
  confirm_create?: boolean;
}

interface CreateXeroContactResult {
  status: 'exists' | 'similar_found' | 'created' | 'error';
  contact?: { name: string; email?: string; phone?: string; contactId: string };
  matches?: Array<{ name: string; email?: string; phone?: string; contactId: string }>;
  message?: string;
}

function extractPhone(contact: XeroContact): string | undefined {
  const defaultPhone = contact.Phones?.find((p) => p.PhoneType === 'DEFAULT');
  return defaultPhone?.PhoneNumber || undefined;
}

function formatContact(c: XeroContact) {
  return {
    name: c.Name,
    email: c.EmailAddress || undefined,
    phone: extractPhone(c),
    contactId: c.ContactID,
  };
}

// ---------------------------------------------------------------------------
// searchXeroContacts — find contacts by name
// ---------------------------------------------------------------------------

export async function searchXeroContacts(name: string): Promise<XeroContact[]> {
  const tenantId = await getConfigValue('xero_tenant_id');
  if (!tenantId) throw new Error('Xero tenant ID not configured.');

  const token = await getAccessToken();
  const searchTerm = name.toLowerCase().replace(/"/g, '');

  const response = await axios.get(`${XERO_API_URL}/Contacts`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-Tenant-Id': tenantId,
      Accept: 'application/json',
    },
    params: {
      where: `Name.ToLower().Contains("${searchTerm}")`,
    },
    timeout: 10000,
  });

  return response.data?.Contacts || [];
}

// ---------------------------------------------------------------------------
// createXeroContact — create a new contact in Xero
// ---------------------------------------------------------------------------

async function createXeroContact(
  name: string,
  phone?: string,
  email?: string
): Promise<XeroContact> {
  const tenantId = await getConfigValue('xero_tenant_id');
  if (!tenantId) throw new Error('Xero tenant ID not configured.');

  const token = await getAccessToken();

  const contact: Record<string, unknown> = { Name: name };
  if (email) contact.EmailAddress = email;
  if (phone) {
    contact.Phones = [{ PhoneType: 'DEFAULT', PhoneNumber: phone }];
  }

  const response = await axios.post(
    `${XERO_API_URL}/Contacts`,
    { Contacts: [contact] },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Xero-Tenant-Id': tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 10000,
    }
  );

  const created = response.data?.Contacts?.[0];
  if (!created?.ContactID) throw new Error('Xero did not return a ContactID.');
  return created;
}

// ---------------------------------------------------------------------------
// handleCreateXeroContact — main exported handler
// ---------------------------------------------------------------------------

export async function handleCreateXeroContact(
  input: CreateXeroContactInput
): Promise<CreateXeroContactResult> {
  // Validate: need at least phone or email
  if (!input.phone && !input.email) {
    return {
      status: 'error',
      message: 'Please provide at least a phone number or email address.',
    };
  }

  try {
    const matches = await searchXeroContacts(input.name);

    // Check for exact match (case-insensitive)
    const exactMatch = matches.find(
      (c) => c.Name.toLowerCase() === input.name.toLowerCase()
    );
    if (exactMatch) {
      logger.info({ event: 'xero_contact_exists', name: input.name });
      return {
        status: 'exists',
        contact: formatContact(exactMatch),
        message: `Client "${exactMatch.Name}" already exists in Xero.`,
      };
    }

    // Check for similar matches
    const inputLower = input.name.toLowerCase();
    const similarMatches = matches.filter((c) => {
      const nameLower = c.Name.toLowerCase();
      return nameLower.includes(inputLower) || inputLower.includes(nameLower);
    });

    if (similarMatches.length > 0 && !input.confirm_create) {
      logger.info({ event: 'xero_contact_similar', name: input.name, matchCount: similarMatches.length });
      return {
        status: 'similar_found',
        matches: similarMatches.map(formatContact),
        message: `Similar contact(s) found in Xero. Please confirm you want to create a new contact for "${input.name}".`,
      };
    }

    // No match or user confirmed — create the contact
    const created = await createXeroContact(input.name, input.phone, input.email);
    logger.info({ event: 'xero_contact_created', name: input.name, contactId: created.ContactID });
    return {
      status: 'created',
      contact: formatContact(created),
      message: `Contact "${input.name}" created in Xero.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ event: 'xero_contact_error', name: input.name, error: message });
    return {
      status: 'error',
      message: `Failed to create Xero contact: ${message}`,
    };
  }
}
