import axios from 'axios';
import cron from 'node-cron';
import { config } from '../config';
import { pool } from '../db/pool';
import { getConfigValue, setConfigValue } from '../db/queries';
import logger from '../logger';

// ---------------------------------------------------------------------------
// Client Directory sync (Phase A)
//   One-way, READ-ONLY pull of clients from ServiceM8 + Xero. Matches them across
//   systems using ONLY usable identifiers (a unique, non-denylisted email/phone)
//   then exact name, computes duplicate / missing / accepted-quote signals, and
//   upserts the result into client_directory. It NEVER writes to SM8 or Xero.
//
//   The matching rule is the one validated in discovery: an email/phone is usable
//   only if it appears on exactly ONE Xero contact AND is not a shared/internal
//   identifier (denylist). This prevents the false matches that a shared billing
//   email (e.g. office@sunsetservices.us on 130+ contacts) would otherwise cause.
// ---------------------------------------------------------------------------

const SM8_BASE = config.servicem8.baseUrl;
const SM8_HEADERS = { 'X-API-Key': config.servicem8.apiKey, Accept: 'application/json' };
const XERO_API_URL = 'https://api.xero.com/api.xro/2.0';

const MARCIN_UUID = '0b8200fb-d98a-44e5-8c30-23c6fef14acb';
const ACCEPTED_STATUSES = new Set(['Work Order', 'Completed']);

// Shared/internal identifiers that must never be used as a match key. (The dynamic
// rule — any id appearing on >1 Xero contact — also excludes these, but pinning the
// known internal ones makes the intent explicit and robust to data drift.)
const DENY_EMAILS = new Set([
  'office@aimrg.com',
  'sunsetlandscaping123@gmail.com',
  'erick@sunsetlawnservice.com',    // internal staff address (appears on many records)
]);
// Internal office address family: office@ + a "sunset s…" domain on .us. Matched by
// PATTERN (not exact) so the legit address AND its typo variants
// (office@sunsetservices.us, office@sunsetservice.us, office@sunsetsurvices.us, …)
// are all excluded at ANY cluster size. Applied to the normalized (lowercased/trimmed) email.
const INTERNAL_OFFICE_RE = /^office@sunsets\w*\.us$/;
// True for any email that must never be a usable match key or form a duplicate cluster.
const isDenyEmail = (e: string) => DENY_EMAILS.has(e) || INTERNAL_OFFICE_RE.test(e);
const DENY_PHONES = new Set(['6306181253']);

// Duplicate-cluster band: an identifier shared by 2..DUP_BAND_MAX records is a real
// duplicate signal; larger clusters are shared business/internal ids (PMI, Napleton,
// CIRA, internal staff) — pollution, not duplicates. Chosen from the share-count
// distribution where business/internal ids begin at size 5. Names also require a
// minimum length to drop test-data junk like "sd"/"ddd".
const DUP_BAND_MAX = 4;
const DUP_NAME_MIN_LEN = 5;
const inDupBand = (size: number) => size >= 2 && size <= DUP_BAND_MAX;

// ---- normalizers ----
const normEmail = (e?: string) => (e || '').toLowerCase().trim();
const normPhone = (p?: string) => { const d = (p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const normName = (n?: string) => (n || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export interface ClientDirectorySummary {
  sm8Companies: number;
  xeroContacts: number;
  rows: number;
  matched: number;
  missingFromXero: number;
  missingFromSm8: number;
  withAcceptedQuote: number;
  dupInSm8: number;
  dupInXero: number;
  dupStrong: number;
  dupPossible: number;
  ranAt: string;
}

let syncRunning = false;
export function isClientDirectorySyncRunning(): boolean { return syncRunning; }

// ---- typed shapes (only the fields we use) ----
interface SM8Company { uuid: string; name?: string; }
interface SM8Contact { company_uuid?: string; email?: string; phone?: string; mobile?: string; active?: number; }
interface SM8Job { company_uuid?: string; status?: string; category_uuid?: string; created_by_staff_uuid?: string; }
interface XeroPhone { PhoneCountryCode?: string; PhoneAreaCode?: string; PhoneNumber?: string; }
interface XeroContact { ContactID: string; Name?: string; EmailAddress?: string; Phones?: XeroPhone[]; ContactStatus?: string; }

async function sm8GetAll(path: string): Promise<any[]> {
  const res = await axios.get(`${SM8_BASE}${path}`, { headers: SM8_HEADERS, timeout: 30000 });
  return res.data || [];
}

async function fetchAllXeroContacts(): Promise<XeroContact[]> {
  const token = await getConfigValue('xero_tenant_id');
  if (!token) throw new Error('Xero tenant ID not configured.');
  const { getAccessToken } = await import('../tools/xero');
  const access = await getAccessToken();
  const headers = { Authorization: `Bearer ${access}`, 'Xero-Tenant-Id': token, Accept: 'application/json' };
  const all: XeroContact[] = [];
  let page = 1;
  while (page <= 60) {
    const r = await axios.get(`${XERO_API_URL}/Contacts`, { headers, params: { page }, timeout: 30000 });
    const batch: XeroContact[] = r.data.Contacts || [];
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

const xeroPhones = (c: XeroContact): string[] =>
  (c.Phones || [])
    .map((p) => normPhone(`${p.PhoneCountryCode || ''}${p.PhoneAreaCode || ''}${p.PhoneNumber || ''}`))
    .filter(Boolean);

export async function runClientDirectorySync(): Promise<ClientDirectorySummary | { alreadyRunning: true }> {
  if (syncRunning) {
    logger.info({ event: 'client_directory_sync_skipped_locked' });
    return { alreadyRunning: true };
  }
  syncRunning = true;
  try {
    return await syncClientDirectory();
  } finally {
    syncRunning = false;
  }
}

async function syncClientDirectory(): Promise<ClientDirectorySummary> {
  logger.info({ event: 'client_directory_sync_start' });

  // ---- 1. Pull everything (READ-ONLY) ----
  const [companies, contactsRaw, jobs, categories, staff, xeroContacts] = await Promise.all([
    sm8GetAll('/company.json') as Promise<SM8Company[]>,
    sm8GetAll('/companycontact.json') as Promise<SM8Contact[]>,
    sm8GetAll('/job.json') as Promise<SM8Job[]>,
    sm8GetAll('/category.json'),
    sm8GetAll('/staff.json'),
    fetchAllXeroContacts(),
  ]);

  const catName = new Map<string, string>(categories.map((c: any) => [c.uuid, c.name]));
  const staffName = new Map<string, string>(staff.map((s: any) => [s.uuid, `${s.first || ''} ${s.last || ''}`.trim()]));

  // ---- 2. Xero indexes + usability ----
  const xeroById = new Map<string, XeroContact>();
  const xeroByEmail = new Map<string, Set<string>>();   // email -> contactIds
  const xeroByPhone = new Map<string, Set<string>>();   // phone -> contactIds
  const xeroByName = new Map<string, string[]>();        // normName -> contactIds
  for (const c of xeroContacts) {
    if (c.ContactStatus === 'ARCHIVED') continue;
    xeroById.set(c.ContactID, c);
    const e = normEmail(c.EmailAddress);
    if (e) { (xeroByEmail.get(e) || xeroByEmail.set(e, new Set()).get(e)!).add(c.ContactID); }
    for (const p of xeroPhones(c)) { (xeroByPhone.get(p) || xeroByPhone.set(p, new Set()).get(p)!).add(c.ContactID); }
    const n = normName(c.Name);
    if (n) { const arr = xeroByName.get(n) || xeroByName.set(n, []).get(n)!; if (!arr.includes(c.ContactID)) arr.push(c.ContactID); }
  }
  const emailUsable = (e: string) => !!e && !isDenyEmail(e) && xeroByEmail.get(e)?.size === 1;
  const phoneUsable = (p: string) => !!p && !DENY_PHONES.has(p) && xeroByPhone.get(p)?.size === 1;

  // ---- 3. SM8 groupings + dup indexes ----
  const ccByCompany = new Map<string, { emails: Set<string>; phones: Set<string> }>();
  const sm8EmailToCos = new Map<string, Set<string>>();
  const sm8PhoneToCos = new Map<string, Set<string>>();
  for (const ct of contactsRaw) {
    if (ct.active === 0 || !ct.company_uuid) continue;
    const g = ccByCompany.get(ct.company_uuid) || ccByCompany.set(ct.company_uuid, { emails: new Set(), phones: new Set() }).get(ct.company_uuid)!;
    const e = normEmail(ct.email);
    if (e && !isDenyEmail(e)) { g.emails.add(e); (sm8EmailToCos.get(e) || sm8EmailToCos.set(e, new Set()).get(e)!).add(ct.company_uuid); }
    for (const p of [normPhone(ct.phone), normPhone(ct.mobile)]) {
      if (p && !DENY_PHONES.has(p)) { g.phones.add(p); (sm8PhoneToCos.get(p) || sm8PhoneToCos.set(p, new Set()).get(p)!).add(ct.company_uuid); }
    }
  }
  const jobsByCompany = new Map<string, SM8Job[]>();
  const sm8NameToCos = new Map<string, Set<string>>();
  for (const co of companies) {
    const n = normName(co.name);
    if (n) (sm8NameToCos.get(n) || sm8NameToCos.set(n, new Set()).get(n)!).add(co.uuid);
  }
  for (const j of jobs) {
    if (!j.company_uuid) continue;
    (jobsByCompany.get(j.company_uuid) || jobsByCompany.set(j.company_uuid, []).get(j.company_uuid)!).push(j);
  }

  // ---- Duplicate-cluster detection (banded, denylist-excluded) ----
  // strong = shares a usable email/phone with 1..(N-1) other records (same client
  // recorded twice); possible = shares an exact name only (could be coincidence).
  interface DupInfo { confidence: 'strong' | 'possible'; key: string; reason: string; }

  // Cross-side pollution guard: an identifier shared by >N records on EITHER system
  // is a shared business/internal id (e.g. a property-management AP email), never a
  // duplicate-client signal — exclude it on both sides regardless of its count on the
  // side being evaluated.
  const emailPolluted = (e: string) => (xeroByEmail.get(e)?.size || 0) > DUP_BAND_MAX || (sm8EmailToCos.get(e)?.size || 0) > DUP_BAND_MAX;
  const phonePolluted = (p: string) => (xeroByPhone.get(p)?.size || 0) > DUP_BAND_MAX || (sm8PhoneToCos.get(p)?.size || 0) > DUP_BAND_MAX;

  const xeroDupInfo = (c: XeroContact): DupInfo | null => {
    const e = normEmail(c.EmailAddress);
    if (e && !isDenyEmail(e) && inDupBand(xeroByEmail.get(e)?.size || 0) && !emailPolluted(e)) {
      const s = xeroByEmail.get(e)!.size;
      return { confidence: 'strong', key: `xemail:${e}`, reason: `Xero: shares email ${e} with ${s - 1} other contact(s)` };
    }
    for (const p of xeroPhones(c)) {
      if (!DENY_PHONES.has(p) && inDupBand(xeroByPhone.get(p)?.size || 0) && !phonePolluted(p)) {
        const s = xeroByPhone.get(p)!.size;
        return { confidence: 'strong', key: `xphone:${p}`, reason: `Xero: shares phone ${p} with ${s - 1} other contact(s)` };
      }
    }
    const n = normName(c.Name);
    if (n.length >= DUP_NAME_MIN_LEN && inDupBand((xeroByName.get(n) || []).length)) {
      const s = (xeroByName.get(n) || []).length;
      return { confidence: 'possible', key: `xname:${n}`, reason: `Xero: shares name "${c.Name}" with ${s - 1} other contact(s)` };
    }
    return null;
  };

  const sm8DupInfo = (co: SM8Company, emails: Set<string>, phones: Set<string>): DupInfo | null => {
    for (const e of emails) {
      if (inDupBand(sm8EmailToCos.get(e)?.size || 0) && !emailPolluted(e)) {
        const s = sm8EmailToCos.get(e)!.size;
        return { confidence: 'strong', key: `semail:${e}`, reason: `SM8: shares email ${e} with ${s - 1} other client(s)` };
      }
    }
    for (const p of phones) {
      if (inDupBand(sm8PhoneToCos.get(p)?.size || 0) && !phonePolluted(p)) {
        const s = sm8PhoneToCos.get(p)!.size;
        return { confidence: 'strong', key: `sphone:${p}`, reason: `SM8: shares phone ${p} with ${s - 1} other client(s)` };
      }
    }
    const n = normName(co.name);
    if (n.length >= DUP_NAME_MIN_LEN && inDupBand(sm8NameToCos.get(n)?.size || 0)) {
      const s = sm8NameToCos.get(n)!.size;
      return { confidence: 'possible', key: `sname:${n}`, reason: `SM8: shares name "${co.name}" with ${s - 1} other client(s)` };
    }
    return null;
  };

  const strongest = (a: DupInfo | null, b: DupInfo | null): 'strong' | 'possible' | null => {
    const rank = (d: DupInfo | null) => (d?.confidence === 'strong' ? 2 : d?.confidence === 'possible' ? 1 : 0);
    const r = Math.max(rank(a), rank(b));
    return r === 2 ? 'strong' : r === 1 ? 'possible' : null;
  };

  // ---- 4. Build rows (SM8 companies are the spine) ----
  const rows: any[] = [];
  const coveredXeroIds = new Set<string>();

  for (const co of companies) {
    const g = ccByCompany.get(co.uuid) || { emails: new Set<string>(), phones: new Set<string>() };
    const nm = normName(co.name);

    let signal = 'none', confidence = 'none', matchEmail: string | null = null, matchPhone: string | null = null;
    let matchedIds: string[] = [];

    for (const e of g.emails) { if (emailUsable(e)) { signal = 'email'; confidence = 'high'; matchEmail = e; matchedIds = [...xeroByEmail.get(e)!]; break; } }
    if (signal === 'none') for (const p of g.phones) { if (phoneUsable(p)) { signal = 'phone'; confidence = 'high'; matchPhone = p; matchedIds = [...xeroByPhone.get(p)!]; break; } }
    if (signal === 'none' && xeroByName.has(nm)) { signal = 'name'; confidence = 'medium'; matchedIds = [...xeroByName.get(nm)!]; }

    const matched = matchedIds.length > 0;
    let xeroName: string | null = null;
    if (matched) {
      // Surface name-duplicate siblings of the matched contact so dups are visible.
      const primaryName = normName(xeroById.get(matchedIds[0])?.Name);
      const sameName = (xeroByName.get(primaryName) || []).filter((id) => !matchedIds.includes(id));
      matchedIds = [...new Set([...matchedIds, ...sameName])];
      matchedIds.forEach((id) => coveredXeroIds.add(id));
      xeroName = xeroById.get(matchedIds[0])?.Name || null;
    }

    const sm8Dup = sm8DupInfo(co, g.emails, g.phones);
    const xeroDup = matched ? xeroDupInfo(xeroById.get(matchedIds[0])!) : null;
    const dupInSm8 = !!sm8Dup;
    const dupInXero = !!xeroDup;
    const dupConfidence = strongest(sm8Dup, xeroDup);
    const dupReason = [sm8Dup?.reason, xeroDup?.reason].filter(Boolean).join(' ; ') || null;

    const coJobs = jobsByCompany.get(co.uuid) || [];
    const wonJobs = coJobs.filter((j) => ACCEPTED_STATUSES.has(j.status || ''));
    const acceptedCategories = [...new Set(wonJobs.map((j) => catName.get(j.category_uuid || '') || null).filter(Boolean))] as string[];

    // Rep = creator of the company's jobs (mode); flag Marcin if he created any.
    const creatorCounts = new Map<string, number>();
    for (const j of coJobs) if (j.created_by_staff_uuid) creatorCounts.set(j.created_by_staff_uuid, (creatorCounts.get(j.created_by_staff_uuid) || 0) + 1);
    let repUuid: string | null = null;
    if (creatorCounts.has(MARCIN_UUID)) repUuid = MARCIN_UUID;
    else if (creatorCounts.size) repUuid = [...creatorCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    rows.push({
      directory_key: `sm8:${co.uuid}`,
      canonical_name: co.name || xeroName || '(unnamed)',
      sm8_company_name: co.name || null,
      xero_contact_name: xeroName,
      sm8_company_uuids: [co.uuid],
      xero_contact_ids: matchedIds,
      match_email: matchEmail,
      match_phone: matchPhone,
      match_signal: signal,
      match_confidence: confidence,
      in_sm8: true,
      in_xero: matched,
      dup_in_sm8: dupInSm8,
      dup_in_xero: dupInXero,
      dup_confidence: dupConfidence,
      dup_reason: dupReason,
      sm8_dup_group_key: sm8Dup?.key || null,
      xero_dup_group_key: xeroDup?.key || null,
      missing_from_xero: !matched,
      missing_from_sm8: false,
      has_accepted_quote: wonJobs.length > 0,
      accepted_categories: acceptedCategories,
      created_by_rep: repUuid ? (staffName.get(repUuid) || null) : null,
      created_by_rep_uuid: repUuid,
    });
  }

  // ---- 5. Xero contacts with no SM8 match -> in_xero-only rows ----
  for (const c of xeroContacts) {
    if (c.ContactStatus === 'ARCHIVED' || coveredXeroIds.has(c.ContactID)) continue;
    const xeroDup = xeroDupInfo(c);
    rows.push({
      directory_key: `xero:${c.ContactID}`,
      canonical_name: c.Name || '(unnamed)',
      sm8_company_name: null,
      xero_contact_name: c.Name || null,
      sm8_company_uuids: [],
      xero_contact_ids: [c.ContactID],
      match_email: null,
      match_phone: null,
      match_signal: 'none',
      match_confidence: 'none',
      in_sm8: false,
      in_xero: true,
      dup_in_sm8: false,
      dup_in_xero: !!xeroDup,
      dup_confidence: xeroDup?.confidence || null,
      dup_reason: xeroDup?.reason || null,
      sm8_dup_group_key: null,
      xero_dup_group_key: xeroDup?.key || null,
      missing_from_xero: false,
      missing_from_sm8: true,
      has_accepted_quote: false,
      accepted_categories: [],
      created_by_rep: null,
      created_by_rep_uuid: null,
    });
  }

  // ---- 6. Upsert (idempotent on directory_key) ----
  for (const r of rows) {
    await pool.query(
      `INSERT INTO client_directory
         (directory_key, canonical_name, sm8_company_name, xero_contact_name,
          sm8_company_uuids, xero_contact_ids, match_email, match_phone,
          match_signal, match_confidence, in_sm8, in_xero, dup_in_sm8, dup_in_xero,
          missing_from_xero, missing_from_sm8, has_accepted_quote, accepted_categories,
          created_by_rep, created_by_rep_uuid,
          dup_confidence, dup_reason, sm8_dup_group_key, xero_dup_group_key, last_synced)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24, NOW())
       ON CONFLICT (directory_key) DO UPDATE SET
          canonical_name=EXCLUDED.canonical_name, sm8_company_name=EXCLUDED.sm8_company_name,
          xero_contact_name=EXCLUDED.xero_contact_name, sm8_company_uuids=EXCLUDED.sm8_company_uuids,
          xero_contact_ids=EXCLUDED.xero_contact_ids, match_email=EXCLUDED.match_email,
          match_phone=EXCLUDED.match_phone, match_signal=EXCLUDED.match_signal,
          match_confidence=EXCLUDED.match_confidence, in_sm8=EXCLUDED.in_sm8, in_xero=EXCLUDED.in_xero,
          dup_in_sm8=EXCLUDED.dup_in_sm8, dup_in_xero=EXCLUDED.dup_in_xero,
          missing_from_xero=EXCLUDED.missing_from_xero, missing_from_sm8=EXCLUDED.missing_from_sm8,
          has_accepted_quote=EXCLUDED.has_accepted_quote, accepted_categories=EXCLUDED.accepted_categories,
          created_by_rep=EXCLUDED.created_by_rep, created_by_rep_uuid=EXCLUDED.created_by_rep_uuid,
          dup_confidence=EXCLUDED.dup_confidence, dup_reason=EXCLUDED.dup_reason,
          sm8_dup_group_key=EXCLUDED.sm8_dup_group_key, xero_dup_group_key=EXCLUDED.xero_dup_group_key,
          last_synced=NOW()`,
      [
        r.directory_key, r.canonical_name, r.sm8_company_name, r.xero_contact_name,
        r.sm8_company_uuids, r.xero_contact_ids, r.match_email, r.match_phone,
        r.match_signal, r.match_confidence, r.in_sm8, r.in_xero, r.dup_in_sm8, r.dup_in_xero,
        r.missing_from_xero, r.missing_from_sm8, r.has_accepted_quote, r.accepted_categories,
        r.created_by_rep, r.created_by_rep_uuid,
        r.dup_confidence, r.dup_reason, r.sm8_dup_group_key, r.xero_dup_group_key,
      ]
    );
  }

  const summary: ClientDirectorySummary = {
    sm8Companies: companies.length,
    xeroContacts: xeroContacts.length,
    rows: rows.length,
    matched: rows.filter((r) => r.in_sm8 && r.in_xero).length,
    missingFromXero: rows.filter((r) => r.missing_from_xero).length,
    missingFromSm8: rows.filter((r) => r.missing_from_sm8).length,
    withAcceptedQuote: rows.filter((r) => r.has_accepted_quote).length,
    dupInSm8: rows.filter((r) => r.dup_in_sm8).length,
    dupInXero: rows.filter((r) => r.dup_in_xero).length,
    dupStrong: rows.filter((r) => r.dup_confidence === 'strong').length,
    dupPossible: rows.filter((r) => r.dup_confidence === 'possible').length,
    ranAt: new Date().toISOString(),
  };

  try { await setConfigValue('client_directory_last_sync', JSON.stringify(summary)); }
  catch (err) { logger.error({ event: 'client_directory_last_sync_write_error', error: err instanceof Error ? err.message : String(err) }); }

  logger.info({ event: 'client_directory_sync_complete', ...summary });
  return summary;
}

export function startClientDirectorySync(): void {
  // Daily at 3:30 AM CT — it reads the full SM8 + Xero contact set, so run off-peak.
  cron.schedule('30 3 * * *', () => {
    runClientDirectorySync().catch((err) =>
      logger.error({ event: 'client_directory_sync_cron_error', error: String(err) })
    );
  }, { timezone: 'America/Chicago' });

  logger.info({ event: 'client_directory_sync_started', schedule: 'daily@03:30-CT' });
}
