const axios = require('axios');
const key = process.env.SM8_API_KEY;
const LP1_UUID = 'f56000cf-9b34-4999-9155-23ccdf9336ab';
const TARGET_DATE = '2026-03-24';

async function main() {
  const [actRes, jobRes] = await Promise.all([
    axios.get('https://api.servicem8.com/api_1.0/jobactivity.json',
      { headers: { 'X-API-Key': key, 'Accept': 'application/json' } }),
    axios.get('https://api.servicem8.com/api_1.0/job.json',
      { headers: { 'X-API-Key': key, 'Accept': 'application/json' } }),
  ]);

  const activities = actRes.data;
  const jobs = jobRes.data;

  // Replicate the PRIMARY path: dateActMap (activities on target date)
  const dateActMap = {};
  for (const act of activities) {
    if (act.active !== 1 || !act.activity_was_scheduled) continue;
    const actDate = (act.start_date || '').substring(0, 10);
    if (actDate !== TARGET_DATE) continue;
    const key2 = `${act.job_uuid}:${actDate}`;
    if (!dateActMap[key2]) dateActMap[key2] = [];
    dateActMap[key2].push(act);
  }

  // Replicate the FULL activityMap (all active, scheduled activities, any date)
  const activityMap = {};
  for (const act of activities) {
    if (act.active !== 1 || !act.activity_was_scheduled) continue;
    if (!activityMap[act.job_uuid]) activityMap[act.job_uuid] = [];
    activityMap[act.job_uuid].push(act);
  }

  // Jobs eligible for display (Work Order or In Progress)
  const jobMap = {};
  for (const j of jobs) {
    if (j.status === 'Work Order' || j.status === 'In Progress') {
      jobMap[j.uuid] = j;
    }
  }

  // PRIMARY PATH: jobs from dateActMap assigned to LP1
  const seenJobUuids = new Set();
  const primaryJobs = [];
  for (const [key2, allocs] of Object.entries(dateActMap)) {
    const sepIdx = key2.lastIndexOf(':');
    const jobUuid = key2.substring(0, sepIdx);
    const job = jobMap[jobUuid];
    if (!job) continue;
    seenJobUuids.add(jobUuid);
    const isLp1 = allocs.some(a => a.staff_uuid === LP1_UUID);
    if (isLp1) primaryJobs.push({ num: job.generated_job_id, status: job.status, jobDate: job.date?.substring(0,10), jobUuid });
  }

  // FALLBACK PATH: jobs where job.date matches but NOT in dateActMap
  const fallbackJobs = [];
  for (const job of Object.values(jobMap)) {
    if (seenJobUuids.has(job.uuid)) continue;
    const jd = (job.date || '').substring(0, 10);
    if (jd !== TARGET_DATE) continue;
    
    const allocs = activityMap[job.uuid] || [];
    const isLp1 = allocs.some(a => a.staff_uuid === LP1_UUID);
    if (isLp1) {
      // Show what dates the activities are actually on
      const actDates = allocs.map(a => (a.start_date || '').substring(0, 10));
      fallbackJobs.push({
        num: job.generated_job_id,
        status: job.status,
        jobDate: jd,
        jobUuid: job.uuid,
        activityDates: [...new Set(actDates)],
      });
    }
  }

  console.log('=== PRIMARY PATH (activity on ' + TARGET_DATE + ') ===');
  console.log('Jobs for LP1:', primaryJobs.length);
  primaryJobs.forEach(j => console.log('  #' + j.num, j.status, 'job.date=' + j.jobDate));

  console.log('\n=== FALLBACK PATH (job.date=' + TARGET_DATE + ', no activity today) ===');
  console.log('Extra jobs for LP1:', fallbackJobs.length);
  fallbackJobs.forEach(j => {
    console.log('  #' + j.num, j.status, 'job.date=' + j.jobDate, 'activity dates:', j.activityDates.join(', '));
  });

  console.log('\nTOTAL jobs LP1 sees today:', primaryJobs.length + fallbackJobs.length);
}
main().catch(e => console.error('FAILED:', e.message));
