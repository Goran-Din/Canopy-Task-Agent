import axios from 'axios';
import { config } from '../config';
import { getAccessToken } from './xero';
import { getConfigValue } from '../db/queries';
import { searchXeroContacts } from './xeroContacts';
import { notifyUser } from './telegram_notify';
import logger from '../logger';

const XERO_API_URL = 'https://api.xero.com/api.xro/2.0';

const sm8Api = axios.create({
  baseURL: config.servicem8.baseUrl,
  headers: {
    'X-API-Key': config.servicem8.apiKey,
    Accept: 'application/json',
  },
  timeout: 10000,
});

interface SM8JobMaterial {
  uuid: string;
  job_uuid: string;
  name: string;
  description: string;
  quantity: number;
  unit_cost: number;
}

interface CreateXeroInvoiceInput {
  job_uuid: string;
  notes?: string;
}

interface CreateXeroInvoiceResult {
  status: 'created' | 'error';
  invoiceNumber?: string;
  total?: number;
  clientName?: string;
  message: string;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function handleCreateXeroInvoice(
  input: CreateXeroInvoiceInput
): Promise<CreateXeroInvoiceResult> {
  try {
    // Step 1 — Resolve job UUID (accept job number or UUID)
    let jobUuid = input.job_uuid;

    if (!isUuid(jobUuid)) {
      // Looks like a job number — search SM8 for it
      const searchRes = await sm8Api.get('/job.json');
      const allJobs: Array<{ uuid: string; generated_job_id?: string }> = searchRes.data || [];
      const match = allJobs.find((j) => j.generated_job_id === jobUuid);
      if (!match) {
        return { status: 'error', message: `No ServiceM8 job found with number #${jobUuid}.` };
      }
      jobUuid = match.uuid;
      logger.info({ event: 'xero_invoice_resolved_job', inputNumber: input.job_uuid, resolvedUuid: jobUuid });
    }

    const jobRes = await sm8Api.get('/job.json', {
      params: { uuid: jobUuid },
    });
    const job = jobRes.data?.[0];
    if (!job) {
      return { status: 'error', message: `No ServiceM8 job found for UUID ${jobUuid}.` };
    }

    // Get client name from SM8 company
    let clientName = 'Unknown Client';
    try {
      const compRes = await sm8Api.get(`/company/${job.company_uuid}.json`);
      clientName = compRes.data?.name || clientName;
    } catch {
      // Use default
    }

    const jobDescription = job.job_description || 'No description';
    const jobNumber = job.generated_job_id || job.uuid.slice(0, 8);

    // Step 2 — Get SM8 job materials (line items)
    let materials: SM8JobMaterial[] = [];

    // Try filtered request first
    try {
      const materialsRes = await sm8Api.get('/jobmaterial.json', {
        params: { '%24filter': `job_uuid eq '${jobUuid}'` },
      });
      materials = (materialsRes.data || []).filter((m: SM8JobMaterial) => m.job_uuid === jobUuid);
      logger.info({ event: 'xero_invoice_materials_filtered', jobUuid, count: materials.length });
    } catch (filterErr) {
      logger.warn({
        event: 'xero_invoice_materials_filter_failed',
        jobUuid,
        error: filterErr instanceof Error ? filterErr.message : String(filterErr),
      });

      // Fallback: fetch all and filter in code
      try {
        const allRes = await sm8Api.get('/jobmaterial.json');
        const allMaterials: SM8JobMaterial[] = allRes.data || [];
        materials = allMaterials.filter((m) => m.job_uuid === jobUuid);
        logger.info({ event: 'xero_invoice_materials_fallback', jobUuid, totalFetched: allMaterials.length, matched: materials.length });
      } catch (fallbackErr) {
        logger.error({
          event: 'xero_invoice_materials_fallback_failed',
          jobUuid,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          responseData: (fallbackErr as { response?: { data?: unknown } })?.response?.data,
        });
        return {
          status: 'error',
          message: `Could not fetch job materials from ServiceM8. The API may be temporarily unavailable.`,
        };
      }
    }

    if (materials.length === 0) {
      return {
        status: 'error',
        message: `No line items found on SM8 job #${jobNumber}. The quote may be empty — please add items in ServiceM8 first.`,
      };
    }

    // Step 3 — Find Xero contact
    const xeroContacts = await searchXeroContacts(clientName);
    const exactMatch = xeroContacts.find(
      (c) => c.Name.toLowerCase() === clientName.toLowerCase()
    );

    if (!exactMatch) {
      return {
        status: 'error',
        message: `No Xero contact found for "${clientName}". Please create the contact first using create_xero_contact, then try again.`,
      };
    }

    // Step 4 — Build Xero invoice
    const lineItems = materials.map((m) => ({
      Description: m.description || m.name,
      Quantity: m.quantity,
      UnitAmount: m.unit_cost,
      AccountCode: '200',
    }));

    const total = materials.reduce((sum, m) => sum + m.quantity * m.unit_cost, 0);

    const tenantId = await getConfigValue('xero_tenant_id');
    if (!tenantId) throw new Error('Xero tenant ID not configured.');
    const token = await getAccessToken();

    const invoiceBody = {
      Invoices: [{
        Type: 'ACCREC',
        Status: 'SUBMITTED',
        Contact: { ContactID: exactMatch.ContactID },
        LineAmountTypes: 'Exclusive',
        Reference: `SM8 Job #${jobNumber}`,
        ...(input.notes ? { Narration: input.notes } : {}),
        LineItems: lineItems,
      }],
    };

    const invoiceRes = await axios.post(`${XERO_API_URL}/Invoices`, invoiceBody, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Xero-Tenant-Id': tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 15000,
    });

    const created = invoiceRes.data?.Invoices?.[0];
    if (!created?.InvoiceID) {
      throw new Error('Xero did not return an invoice ID.');
    }

    const invoiceNumber = created.InvoiceNumber || 'DRAFT';
    const formattedTotal = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    logger.info({
      event: 'xero_invoice_created',
      invoiceNumber,
      clientName,
      jobNumber,
      total,
    });

    // Step 5 — Notify billing team
    const notifyMsg = `📋 New invoice submitted for approval in Xero — Client: ${clientName} · Job: ${jobDescription.slice(0, 80)} · Total: $${formattedTotal}. Please review in Xero Awaiting Approval tab.`;

    await Promise.all([
      notifyUser({ recipient: 'hristina', message: notifyMsg, notification_type: 'invoice_ready' }),
      notifyUser({ recipient: 'gordana', message: notifyMsg, notification_type: 'invoice_ready' }),
    ]).catch((err) => {
      logger.error({ event: 'xero_invoice_notify_error', error: err instanceof Error ? err.message : String(err) });
    });

    return {
      status: 'created',
      invoiceNumber,
      total,
      clientName,
      message: `Invoice ${invoiceNumber} created in Xero for ${clientName} — $${formattedTotal}. Hristina and Gordana have been notified.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ event: 'xero_invoice_error', jobUuid: input.job_uuid, error: message });
    return {
      status: 'error',
      message: `Failed to create invoice: ${message}`,
    };
  }
}
