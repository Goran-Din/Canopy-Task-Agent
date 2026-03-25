import axios from 'axios';
import { config } from '../config';
import { cacheClient, getCachedClient } from '../db/queries';
import { GetJobStatusInput, UpdateJobStatusInput, CreateJobInput, JobStatus } from '../types';
import logger from '../logger';

const sm8Api = axios.create({
  baseURL: config.servicem8.baseUrl,
  headers: {
    'X-API-Key': config.servicem8.apiKey,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

export async function getJobStatus(input: GetJobStatusInput): Promise<{
  jobs: JobStatus[];
  ambiguous: boolean;
  message: string;
}> {
  try {
    if (input.sm8_job_id) {
      const jobRes = await sm8Api.get(`/job.json?uuid=${input.sm8_job_id}`);
      const jobs = jobRes.data;
      if (!jobs || jobs.length === 0) {
        return { jobs: [], ambiguous: false, message: 'No job found with that ID.' };
      }
      const job = jobs[0];
      const clientRes = await sm8Api.get(`/company.json?uuid=${job.company_uuid}`);
      const client = clientRes.data[0];
      const result: JobStatus = {
        client_uuid: job.company_uuid,
        client_name: client?.name || 'Unknown',
        job_uuid: job.uuid,
        job_number: job.generated_job_id || job.uuid,
        status: job.status,
        description: job.job_description || '',
        created_date: job.date || '',
      };
      await cacheClient({
        client_name: result.client_name,
        sm8_uuid: result.client_uuid,
        last_job_uuid: result.job_uuid,
        last_job_status: result.status,
      });
      logger.info({ event: 'get_job_status', job_uuid: result.job_uuid, client: result.client_name });
      return { jobs: [result], ambiguous: false, message: 'Job found.' };
    }

    const cached = await getCachedClient(input.client_name);
    const allClientsRes = await sm8Api.get('/company.json', {
      params: { active: 1 }
    });
    const allClients = allClientsRes.data || [];
    const searchTerm = input.client_name.toLowerCase();
    const clients = allClients.filter((c: { name?: string }) =>
      c.name && c.name.toLowerCase().includes(searchTerm)
    );

    if (!clients || clients.length === 0) {
      return { jobs: [], ambiguous: false, message: `I could not find "${input.client_name}" in ServiceM8. Try a shorter name or check the spelling.` };
    }

    if (clients.length > 1 && !cached) {
      const list = clients.slice(0, 5).map((c: { name: string }, i: number) => `${i + 1}. ${c.name}`).join('\n');
      return {
        jobs: [],
        ambiguous: true,
        message: `Found ${clients.length} matches for "${input.client_name}":\n${list}\nWhich one did you mean?`,
      };
    }

    const client = cached
      ? clients.find((c: { uuid: string }) => c.uuid === cached.sm8_uuid) || clients[0]
      : clients[0];

    const jobsRes = await sm8Api.get('/job.json', {
      params: { company_uuid: client.uuid }
    });
    const jobs = (jobsRes.data || [])
      .sort((a: { date?: string }, b: { date?: string }) =>
        (b.date || '').localeCompare(a.date || '')
      )
      .slice(0, 5);

    const results: JobStatus[] = jobs.map((job: {
      company_uuid: string;
      uuid: string;
      generated_job_id?: string;
      status: string;
      job_description?: string;
      date?: string;
    }) => ({
      client_uuid: client.uuid,
      client_name: client.name,
      job_uuid: job.uuid,
      job_number: job.generated_job_id || job.uuid,
      status: job.status,
      description: job.job_description || '',
      created_date: job.date || '',
    }));

    if (results.length > 0) {
      await cacheClient({
        client_name: client.name,
        sm8_uuid: client.uuid,
        last_job_uuid: results[0].job_uuid,
        last_job_status: results[0].status,
      });
    }

    logger.info({ event: 'get_job_status', client: client.name, jobs_found: results.length });
    return {
      jobs: results,
      ambiguous: false,
      message: `Found ${results.length} job(s) for ${client.name}.`,
    };

  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ event: 'get_job_status_error', error: error.message });
    if (error.message.includes('timeout') || error.message.includes('ECONNREFUSED')) {
      return { jobs: [], ambiguous: false, message: 'ServiceM8 is not responding right now. Please try again in a moment.' };
    }
    return { jobs: [], ambiguous: false, message: `ServiceM8 error: ${error.message}` };
  }
}

export async function updateJobStatus(input: UpdateJobStatusInput): Promise<{ success: boolean; message: string }> {
  try {
    let jobUuid = input.sm8_job_id;

    // If the job ID looks like a job number (short, numeric) rather than a UUID, look it up
    if (!jobUuid.includes('-')) {
      const allJobsRes = await sm8Api.get('/job.json');
      const allJobs = allJobsRes.data || [];
      const job = allJobs.find((j: { generated_job_id?: string; uuid: string }) =>
        j.generated_job_id === jobUuid || j.generated_job_id === String(jobUuid)
      );
      if (!job) {
        return { success: false, message: `Could not find job #${jobUuid} in ServiceM8.` };
      }
      jobUuid = job.uuid;
      logger.info({ event: 'job_uuid_resolved', job_number: input.sm8_job_id, uuid: jobUuid });
    }

    logger.info({ event: 'update_job_status_call', job_uuid: jobUuid, new_status: input.new_status });

    await sm8Api.post(`/job/${jobUuid}.json`, {
      status: input.new_status,
    });

    // Fetch a staff UUID to attach the activity note
    let staffUuid: string | undefined;
    try {
      const staffRes = await sm8Api.get('/staff.json');
      const staffList = staffRes.data || [];
      if (staffList.length > 0) {
        staffUuid = staffList[0].uuid;
      }
    } catch {
      logger.warn({ event: 'staff_lookup_failed' });
    }

    const autoNote = `Status updated to "${input.new_status}" by Canopy Task Agent${input.notes ? ': ' + input.notes : '.'}`;
    await sm8Api.post('/jobactivity.json', {
      job_uuid: jobUuid,
      staff_uuid: staffUuid,
      note: autoNote,
      activity_was_scheduled: 0,
    });

    logger.info({ event: 'job_status_updated', job_uuid: jobUuid, new_status: input.new_status });

    return {
      success: true,
      message: `Job #${input.sm8_job_id} updated to "${input.new_status}".${input.notes ? ' Note added.' : ''}`,
    };

  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ event: 'update_job_status_error', error: error.message });
    return { success: false, message: `Could not update job status: ${error.message}` };
  }
}

export async function getJobAddress(jobNumber: string): Promise<string> {
  try {
    const allJobsRes = await sm8Api.get('/job.json');
    const allJobs = allJobsRes.data || [];
    const job = allJobs.find((j: { generated_job_id?: string }) =>
      j.generated_job_id === jobNumber || j.generated_job_id === String(jobNumber)
    );

    if (!job) {
      return `Job #${jobNumber} not found in ServiceM8.`;
    }

    // Fetch client name
    let clientName = 'Unknown Client';
    if (job.company_uuid) {
      try {
        const clientRes = await sm8Api.get(`/company.json`, { params: { uuid: job.company_uuid } });
        const client = clientRes.data?.[0];
        if (client?.name) clientName = client.name;
      } catch {
        // use default
      }
    }

    const desc = job.job_description
      ? (job.job_description.length > 60 ? job.job_description.substring(0, 60) + '…' : job.job_description)
      : 'No description';

    return `📍 Job #${jobNumber} — ${clientName}\nAddress: ${job.job_address || 'No address on file'}\nStatus: ${job.status || 'Unknown'}\nDescription: ${desc}`;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ event: 'get_job_address_error', error: error.message });
    return `Could not look up job #${jobNumber}: ${error.message}`;
  }
}

// ---------------------------------------------------------------------------
// Job quote details for deposit invoicing
// ---------------------------------------------------------------------------

const HARDSCAPE_KEYWORDS = ['patio', 'wall', 'hardscape', 'paver', 'concrete', 'drainage', 'walkway', 'driveway', 'retaining', 'stone', 'brick'];

export async function getJobQuoteDetails(jobNumberOrUuid: string): Promise<{
  uuid: string;
  jobNumber: string;
  clientName: string;
  companyUuid: string;
  description: string;
  totalAmount: number;
  lineItems: Array<{ description: string; unitAmount: number; quantity: number }>;
  projectType: 'hardscape' | 'landscape';
} | null> {
  try {
    const allJobsRes = await sm8Api.get('/job.json');
    const allJobs = allJobsRes.data || [];

    const job = allJobs.find((j: { generated_job_id?: string; uuid: string }) =>
      j.generated_job_id === jobNumberOrUuid ||
      j.generated_job_id === String(jobNumberOrUuid) ||
      j.uuid === jobNumberOrUuid
    );
    if (!job) return null;

    // Fetch client name fresh from SM8 API (not cached)
    let clientName = 'Unknown Client';
    if (job.company_uuid) {
      try {
        const clientRes = await sm8Api.get(`/company/${job.company_uuid}.json`);
        const client = clientRes.data;
        if (client?.name) clientName = client.name;
      } catch { /* use default */ }
    }

    // Fetch line items from jobmaterial endpoint
    let lineItems: Array<{ description: string; unitAmount: number; quantity: number }> = [];
    try {
      const matRes = await sm8Api.get('/jobmaterial.json', { params: { job_uuid: job.uuid } });
      const materials = matRes.data || [];
      lineItems = materials
        .filter((m: { active: number }) => m.active === 1)
        .map((m: { material_name?: string; unit_cost?: number; qty?: number }) => ({
          description: m.material_name || 'Line item',
          unitAmount: parseFloat(String(m.unit_cost || 0)),
          quantity: parseFloat(String(m.qty || 1)),
        }));
    } catch {
      logger.warn({ event: 'jobmaterial_fetch_failed', job_uuid: job.uuid });
    }

    const totalAmount = lineItems.reduce((sum, li) => sum + li.unitAmount * li.quantity, 0);

    // Determine project type from description
    const descLower = (job.job_description || '').toLowerCase();
    const isHardscape = HARDSCAPE_KEYWORDS.some((kw) => descLower.includes(kw));

    logger.info({ event: 'job_quote_details', job_number: job.generated_job_id, total: totalAmount, type: isHardscape ? 'hardscape' : 'landscape' });

    return {
      uuid: job.uuid,
      jobNumber: job.generated_job_id || job.uuid,
      clientName,
      companyUuid: job.company_uuid || '',
      description: job.job_description || '',
      totalAmount,
      lineItems,
      projectType: isHardscape ? 'hardscape' : 'landscape',
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ event: 'get_job_quote_details_error', error: error.message });
    return null;
  }
}

export async function getXeroContactForSM8Job(
  companyUuid: string,
  sm8ClientName?: string
): Promise<{ contactId: string; name: string; clientId: string | null } | null> {
  try {
    const { pool } = await import('../db/pool');
    const { getAccessToken } = await import('./xero');
    const { getConfigValue } = await import('../db/queries');

    // Step 0: Look up nc_client_folders by sm8_client_uuid (most reliable)
    // Fetch the fresh company name from SM8 API, then find by UUID in our DB
    let freshClientName = sm8ClientName;
    if (!freshClientName && companyUuid) {
      try {
        const clientRes = await sm8Api.get(`/company/${companyUuid}.json`);
        freshClientName = clientRes.data?.name;
      } catch { /* continue */ }
    }

    const uuidRes = await pool.query(
      `SELECT xero_contact_id, client_id, sm8_client_name
       FROM nc_client_folders
       WHERE sm8_client_uuid = $1
       LIMIT 1`,
      [companyUuid]
    );

    if (uuidRes.rows.length > 0 && uuidRes.rows[0].xero_contact_id) {
      const row = uuidRes.rows[0];
      const contactName = row.sm8_client_name || freshClientName || 'Unknown';
      logger.info({ event: 'xero_contact_found', method: 'db_uuid_lookup', name: contactName, clientId: row.client_id, xeroContactId: row.xero_contact_id });
      return { contactId: row.xero_contact_id, name: contactName, clientId: row.client_id || null };
    }

    // Step 1: Search nc_client_folders by name (ILIKE) using fresh SM8 company name
    const clientName = freshClientName;
    if (!clientName) return null;

    const nameRes = await pool.query(
      `SELECT xero_contact_id, client_id, sm8_client_name
       FROM nc_client_folders
       WHERE sm8_client_name ILIKE $1
       LIMIT 1`,
      [`%${clientName}%`]
    );

    if (nameRes.rows.length > 0 && nameRes.rows[0].xero_contact_id) {
      const row = nameRes.rows[0];
      const contactName = row.sm8_client_name || clientName;
      logger.info({ event: 'xero_contact_found', method: 'db_name_lookup', name: contactName, clientId: row.client_id, xeroContactId: row.xero_contact_id });
      return { contactId: row.xero_contact_id, name: contactName, clientId: row.client_id || null };
    }

    // Step 2: Search Xero by AccountNumber if we have a client_id from DB
    const dbRow = uuidRes.rows[0] || nameRes.rows[0];
    const token = await getAccessToken();
    const tenantId = await getConfigValue('xero_tenant_id');
    if (!tenantId) return null;

    if (dbRow?.client_id) {
      const clientId = dbRow.client_id;
      try {
        const xeroRes = await axios.get('https://api.xero.com/api.xro/2.0/Contacts', {
          headers: {
            Authorization: `Bearer ${token}`,
            'Xero-Tenant-Id': tenantId,
            Accept: 'application/json',
          },
          params: { where: `AccountNumber=="${clientId}"` },
          timeout: 10000,
        });
        const contacts = xeroRes.data?.Contacts || [];
        if (contacts.length > 0) {
          logger.info({ event: 'xero_contact_found', method: 'account_number', name: contacts[0].Name, clientId });
          return { contactId: contacts[0].ContactID, name: contacts[0].Name, clientId };
        }
      } catch {
        logger.warn({ event: 'xero_contact_acct_search_failed', clientId });
      }
    }

    // Step 3: Fallback — search Xero by name
    try {
      const safeName = clientName.replace(/"/g, '').replace(/'/g, '');
      const xeroRes = await axios.get('https://api.xero.com/api.xro/2.0/Contacts', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Xero-Tenant-Id': tenantId,
          Accept: 'application/json',
        },
        params: { where: `Name.Contains("${safeName}")` },
        timeout: 10000,
      });
      const contacts = xeroRes.data?.Contacts || [];
      if (contacts.length > 0) {
        logger.info({ event: 'xero_contact_found', method: 'name_search', name: contacts[0].Name });
        return { contactId: contacts[0].ContactID, name: contacts[0].Name, clientId: null };
      }
    } catch {
      logger.warn({ event: 'xero_contact_name_search_failed', clientName });
    }

    return null;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ event: 'get_xero_contact_error', error: error.message });
    return null;
  }
}

export async function createJob(input: CreateJobInput): Promise<{ success: boolean; job_uuid: string; job_number: string; message: string }> {
  try {
    // Find client by name
    const allClientsRes = await sm8Api.get('/company.json', { params: { active: 1 } });
    const allClients = allClientsRes.data || [];
    const searchTerm = input.client_name.toLowerCase();
    const matches = allClients.filter((c: { name?: string }) =>
      c.name && c.name.toLowerCase().includes(searchTerm)
    );

    if (matches.length === 0) {
      return { success: false, job_uuid: '', job_number: '', message: `No client found matching "${input.client_name}". Check the spelling or try a shorter name.` };
    }

    if (matches.length > 1) {
      const list = matches.slice(0, 5).map((c: { name: string }, i: number) => `${i + 1}. ${c.name}`).join('\n');
      return { success: false, job_uuid: '', job_number: '', message: `Found ${matches.length} clients matching "${input.client_name}":\n${list}\nWhich one did you mean?` };
    }

    const client = matches[0];
    const jobDate = input.job_date || new Date().toISOString().split('T')[0];

    const description = [
      input.job_description,
      input.pricing_notes ? `Pricing notes: ${input.pricing_notes}` : 'Pricing: to be added manually in ServiceM8',
      `Job type: ${input.job_type || 'other'}`,
      `Created by Canopy Task Agent`,
    ].join('\n');

    const response = await sm8Api.post('/job.json', {
      company_uuid: client.uuid,
      status: 'Quote',
      job_description: description,
      date: jobDate,
    });

    if (response.data.errorCode === 0) {
      // Fetch the newly created job to get its number
      const jobsRes = await sm8Api.get('/job.json', { params: { company_uuid: client.uuid } });
      const jobs = (jobsRes.data || []).sort((a: { date?: string }, b: { date?: string }) =>
        (b.date || '').localeCompare(a.date || '')
      );
      const newJob = jobs[0];
      const jobNumber = newJob?.generated_job_id || 'unknown';
      const jobUuid = newJob?.uuid || '';

      logger.info({ event: 'job_created', client: client.name, job_number: jobNumber, job_uuid: jobUuid });

      return {
        success: true,
        job_uuid: jobUuid,
        job_number: jobNumber,
        message: `Quote created for ${client.name} — Job #${jobNumber}. Date: ${jobDate}. Description: ${input.job_description}.`,
      };
    }

    return { success: false, job_uuid: '', job_number: '', message: `ServiceM8 returned an error creating the job.` };

  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ event: 'create_job_error', error: error.message });
    return { success: false, job_uuid: '', job_number: '', message: `Could not create job: ${error.message}` };
  }
}
