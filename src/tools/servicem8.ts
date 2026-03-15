import axios from 'axios';
import { config } from '../config';
import { cacheClient, getCachedClient } from '../db/queries';
import { GetJobStatusInput, UpdateJobStatusInput, JobStatus } from '../types';
import logger from '../logger';

const sm8Api = axios.create({
  baseURL: config.servicem8.baseUrl,
  auth: {
    username: 'goran@north37.co',
    password: config.servicem8.apiKey,
  },
  headers: { Accept: 'application/json' },
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
    const clientRes = await sm8Api.get(
      `/company.json?%24filter=name%20like%20'${encodeURIComponent(input.client_name)}'`
    );
    const clients = clientRes.data;

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

    const jobsRes = await sm8Api.get(`/job.json?company_uuid=${client.uuid}&%24orderby=date%20desc&%24top=5`);
    const jobs = jobsRes.data || [];

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
  await sm8Api.post(`/job/${input.sm8_job_id}.json`, {
    status: input.new_status,
  });

  if (input.notes) {
    await sm8Api.post('/jobactivity.json', {
      job_uuid: input.sm8_job_id,
      note: input.notes,
    });
  }

  return {
    success: true,
    message: `Job ${input.sm8_job_id} updated to "${input.new_status}".${input.notes ? ' Note added.' : ''}`,
  };
}
