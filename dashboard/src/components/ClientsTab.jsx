import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

// Clients tab (Phase B) — reads the synced client_directory via /dashboard/clients.
// Three sub-tabs: All Clients · Accepted Quotes · Duplicates. Read-only; the only
// action is copying accepted-client emails to the clipboard. The matching /
// duplicate / accepted ENGINE lives in the worker — this only displays its output.

const SYNC_COOLDOWN_MS = 60_000;

// "Last synced" relative-time label (same wording as the other sync labels).
function relativeTime(iso) {
  if (!iso) return 'never';
  const then = new Date(iso);
  if (isNaN(then)) return 'never';
  const secs = Math.round((Date.now() - then.getTime()) / 1000);
  if (secs < 45) return 'just now';
  if (secs < 90) return '1 min ago';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days > 1 ? 's' : ''} ago`;
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const SUB_TABS = [
  { key: 'all', label: 'All Clients' },
  { key: 'accepted', label: 'Accepted Quotes' },
  { key: 'duplicates', label: 'Duplicates' },
];

function Chip({ children, bg, text, title }) {
  return (
    <span
      className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full"
      style={{ backgroundColor: bg, color: text }}
      title={title}
    >
      {children}
    </span>
  );
}

const matchesSearch = (c, q) => {
  if (!q) return true;
  const s = q.toLowerCase();
  return [c.canonical_name, c.sm8_company_name, c.xero_contact_name, c.match_email, c.match_phone, c.created_by_rep]
    .some((v) => v && String(v).toLowerCase().includes(s));
};

// Decode a group key like "xemail:a@b.com" / "sphone:1234567890" / "sname:..".
function describeGroupKey(key) {
  if (!key) return '';
  const [type, ...rest] = key.split(':');
  const val = rest.join(':');
  const label = {
    xemail: 'shared email', semail: 'shared email',
    xphone: 'shared phone', sphone: 'shared phone',
    xname: 'shared name', sname: 'shared name',
  }[type] || 'shared';
  return `${label}: ${val}`;
}

// ── All Clients ───────────────────────────────────────────────────────────
function AllClients({ rows, search }) {
  const [open, setOpen] = useState({});
  const list = useMemo(() => rows.filter((c) => matchesSearch(c, search)), [rows, search]);

  return (
    <div>
      <div className="text-sm font-semibold text-gray-700 mb-2">
        All clients
        <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full ml-2">{list.length}</span>
      </div>
      {list.length === 0 && <div className="text-center text-gray-400 text-sm py-12">No clients match.</div>}
      {list.length > 0 && (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
          {list.map((c) => {
            const nameMismatch = c.in_sm8 && c.in_xero && c.sm8_company_name && c.xero_contact_name
              && c.sm8_company_name.toLowerCase() !== c.xero_contact_name.toLowerCase();
            const isOpen = !!open[c.directory_key];
            return (
              <div key={c.directory_key} className="px-3 py-2">
                <div className="flex items-center gap-1.5 flex-wrap cursor-pointer" onClick={() => setOpen((o) => ({ ...o, [c.directory_key]: !o[c.directory_key] }))}>
                  <span className="text-gray-300 text-[11px] w-3">{isOpen ? '▾' : '▸'}</span>
                  <span className="text-[15px] font-medium text-gray-900 truncate max-w-[280px]" title={c.canonical_name}>
                    {c.canonical_name || '(unnamed)'}
                  </span>
                  {c.in_sm8 && <Chip bg="#E0E7FF" text="#4338CA">SM8</Chip>}
                  {c.in_xero && <Chip bg="#CCFBF1" text="#0F766E">Xero</Chip>}
                  {c.has_accepted_quote && <Chip bg="#D1FAE5" text="#059669">Accepted</Chip>}
                  {(c.accepted_categories || []).map((cat) => (
                    <Chip key={cat} bg="#F3E8FF" text="#7E22CE">{cat}</Chip>
                  ))}
                  {c.missing_from_xero && <Chip bg="#FEF3C7" text="#B45309" title="In ServiceM8 but no matching Xero contact">Missing from Xero</Chip>}
                  {c.missing_from_sm8 && <Chip bg="#FEF3C7" text="#B45309" title="In Xero but no matching ServiceM8 client">Missing from SM8</Chip>}
                  {(c.dup_in_sm8 || c.dup_in_xero) && (
                    <Chip
                      bg={c.dup_confidence === 'strong' ? '#FEE2E2' : '#FEF9C3'}
                      text={c.dup_confidence === 'strong' ? '#DC2626' : '#A16207'}
                      title={c.dup_reason || ''}
                    >
                      Duplicate{c.dup_confidence ? ` · ${c.dup_confidence}` : ''}
                    </Chip>
                  )}
                  {c.created_by_rep && <span className="ml-auto text-[11px] text-gray-400">{c.created_by_rep}</span>}
                </div>

                {nameMismatch && (
                  <div className="ml-5 mt-0.5 text-[11px] text-gray-500">
                    SM8: <span className="text-gray-700">{c.sm8_company_name}</span>
                    <span className="text-gray-300"> · </span>
                    Xero: <span className="text-gray-700">{c.xero_contact_name}</span>
                  </div>
                )}

                {isOpen && (
                  <div className="ml-5 mt-1.5 text-[11px] text-gray-600 space-y-0.5">
                    {c.match_email && <div><span className="text-gray-400">Email </span><span className="font-mono">{c.match_email}</span></div>}
                    {c.match_phone && <div><span className="text-gray-400">Phone </span><span className="font-mono">{c.match_phone}</span></div>}
                    <div><span className="text-gray-400">Match </span>{c.match_signal}{c.match_confidence !== 'none' ? ` (${c.match_confidence})` : ''}</div>
                    {(c.sm8_company_uuids || []).length > 0 && <div><span className="text-gray-400">SM8 id </span><span className="font-mono text-[10px]">{c.sm8_company_uuids.join(', ')}</span></div>}
                    {(c.xero_contact_ids || []).length > 0 && <div><span className="text-gray-400">Xero id </span><span className="font-mono text-[10px]">{c.xero_contact_ids.join(', ')}</span></div>}
                    {(c.dup_in_sm8 || c.dup_in_xero) && (
                      <div className="text-gray-500">
                        <span className="text-gray-400">Duplicate </span>
                        {c.dup_reason || ''}
                        {(c.sm8_dup_group_key || c.xero_dup_group_key) && (
                          <span className="text-gray-400"> · cluster {c.sm8_dup_group_key || c.xero_dup_group_key}</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Accepted Quotes ───────────────────────────────────────────────────────
function AcceptedQuotes({ rows, search }) {
  const [copied, setCopied] = useState(false);
  const accepted = useMemo(() => rows.filter((c) => c.has_accepted_quote), [rows]);
  const list = useMemo(() => accepted.filter((c) => matchesSearch(c, search)), [accepted, search]);
  const withEmail = useMemo(() => list.filter((c) => c.match_email), [list]);

  const copyEmails = useCallback(() => {
    const emails = [...new Set(withEmail.map((c) => c.match_email))];
    if (!emails.length) return;
    navigator.clipboard.writeText(emails.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [withEmail]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="text-sm font-semibold text-gray-700">
          Accepted quotes
          <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full ml-2">{list.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-400">{withEmail.length} of {list.length} have an email</span>
          <button
            onClick={copyEmails}
            disabled={!withEmail.length}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-teal-600 bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {copied ? '✓ Copied' : `Copy ${withEmail.length} emails`}
          </button>
        </div>
      </div>
      {list.length === 0 && <div className="text-center text-gray-400 text-sm py-12">No accepted clients match.</div>}
      {list.length > 0 && (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
          {list.map((c) => (
            <div key={c.directory_key} className="px-3 py-2 flex items-center gap-1.5 flex-wrap">
              <span className="text-[15px] font-medium text-gray-900 truncate max-w-[240px]" title={c.canonical_name}>
                {c.canonical_name || '(unnamed)'}
              </span>
              {(c.accepted_categories || []).map((cat) => (
                <Chip key={cat} bg="#F3E8FF" text="#7E22CE">{cat}</Chip>
              ))}
              {c.match_email
                ? <span className="ml-auto text-[12px] font-mono text-gray-600">{c.match_email}</span>
                : <span className="ml-auto text-[11px] text-gray-300 italic">no email</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Duplicates ────────────────────────────────────────────────────────────
const DUP_BUCKETS = [
  { key: 'both', label: 'In both systems', test: (c) => c.dup_in_sm8 && c.dup_in_xero },
  { key: 'xero', label: 'In Xero only', test: (c) => c.dup_in_xero && !c.dup_in_sm8 },
  { key: 'sm8', label: 'In ServiceM8 only', test: (c) => c.dup_in_sm8 && !c.dup_in_xero },
];

function Duplicates({ rows, search }) {
  const [bucket, setBucket] = useState('both');
  const dupRows = useMemo(() => rows.filter((c) => c.dup_in_sm8 || c.dup_in_xero), [rows]);
  const counts = useMemo(() => {
    const m = {};
    for (const b of DUP_BUCKETS) m[b.key] = dupRows.filter(b.test).length;
    return m;
  }, [dupRows]);

  const bucketDef = DUP_BUCKETS.find((b) => b.key === bucket);
  const inBucket = useMemo(
    () => dupRows.filter(bucketDef.test).filter((c) => matchesSearch(c, search)),
    [dupRows, bucketDef, search]
  );

  // Group by cluster key. A row may carry both sm8 & xero group keys; key the group
  // by the side relevant to the bucket so same-client records sit together.
  const groups = useMemo(() => {
    const g = new Map();
    for (const c of inBucket) {
      const key = (bucket === 'sm8' ? c.sm8_dup_group_key : c.xero_dup_group_key)
        || c.sm8_dup_group_key || c.xero_dup_group_key || `row:${c.directory_key}`;
      if (!g.has(key)) g.set(key, []);
      g.get(key).push(c);
    }
    // strong clusters first, then larger ones
    return [...g.entries()].sort((a, b) => {
      const sa = a[1].some((x) => x.dup_confidence === 'strong') ? 1 : 0;
      const sb = b[1].some((x) => x.dup_confidence === 'strong') ? 1 : 0;
      return sb - sa || b[1].length - a[1].length;
    });
  }, [inBucket, bucket]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {DUP_BUCKETS.map((b) => (
          <button
            key={b.key}
            onClick={() => setBucket(b.key)}
            className={`px-3 py-1 text-xs font-medium rounded-full border ${
              bucket === b.key ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {b.label} <span className={bucket === b.key ? 'text-teal-100' : 'text-gray-400'}>({counts[b.key]})</span>
          </button>
        ))}
      </div>

      <div className="text-sm font-semibold text-gray-700 mb-2">
        {groups.length} cluster{groups.length !== 1 ? 's' : ''}
        <span className="text-xs text-gray-400 ml-2">{inBucket.length} record{inBucket.length !== 1 ? 's' : ''}</span>
      </div>

      {groups.length === 0 && <div className="text-center text-gray-400 text-sm py-12">No duplicate clusters in this bucket.</div>}

      <div className="space-y-2">
        {groups.map(([key, members]) => {
          const strong = members.some((m) => m.dup_confidence === 'strong');
          const reason = describeGroupKey(key.startsWith('row:') ? '' : key) || members[0]?.dup_reason || 'duplicate';
          return (
            <div key={key} className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-3 py-1.5 bg-gray-50 flex items-center gap-2 flex-wrap">
                <Chip bg={strong ? '#FEE2E2' : '#FEF9C3'} text={strong ? '#DC2626' : '#A16207'}>
                  {strong ? 'strong' : 'possible'}
                </Chip>
                <span className="text-[12px] text-gray-700 font-medium">{reason}</span>
                <span className="ml-auto text-[11px] text-gray-400">{members.length} records</span>
              </div>
              <div className="divide-y divide-gray-100">
                {members.map((m) => (
                  <div key={m.directory_key} className="px-3 py-1.5 flex items-center gap-1.5 flex-wrap">
                    <span className="text-[13px] text-gray-800 truncate max-w-[260px]" title={m.canonical_name}>{m.canonical_name || '(unnamed)'}</span>
                    {m.in_sm8 && <Chip bg="#E0E7FF" text="#4338CA">SM8</Chip>}
                    {m.in_xero && <Chip bg="#CCFBF1" text="#0F766E">Xero</Chip>}
                    {m.match_email && <span className="ml-auto text-[11px] font-mono text-gray-500">{m.match_email}</span>}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────
export default function ClientsTab() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sub, setSub] = useState('all');
  const [search, setSearch] = useState('');

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [syncRunningRemote, setSyncRunningRemote] = useState(false);
  const [cooling, setCooling] = useState(false);
  const cooldownTimer = useRef(null);

  const fetchClients = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/dashboard/clients', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch clients');
      const data = await res.json();
      setClients(data.clients || []);
    } catch (err) {
      console.error('Clients fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await fetch('/dashboard/sync-clients-status', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setLastSync(data.last_sync || null);
      setSyncRunningRemote(!!data.running);
    } catch { /* non-fatal */ }
  }, []);

  const startCooldown = useCallback(() => {
    setCooling(true);
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = setTimeout(() => setCooling(false), SYNC_COOLDOWN_MS);
  }, []);

  const runSync = useCallback(async () => {
    if (syncing || syncRunningRemote || cooling) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch('/dashboard/sync-clients', { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({ status: 'error' }));
      if (res.status === 409 || data.status === 'already_running') {
        setSyncRunningRemote(true);
        setSyncMsg({ text: 'Sync already in progress…', kind: 'warn' });
      } else if (data.status === 'ok') {
        const s = data.summary || {};
        setSyncMsg({ text: `Synced ${s.rows ?? 0} clients · ${s.matched ?? 0} matched`, kind: 'ok' });
        await fetchClients();
        startCooldown();
      } else {
        throw new Error(data.error || 'Sync failed');
      }
      await fetchSyncStatus();
    } catch (err) {
      console.error('Client sync error:', err);
      setSyncMsg({ text: 'Sync failed — try again', kind: 'err' });
    } finally {
      setSyncing(false);
    }
  }, [syncing, syncRunningRemote, cooling, fetchClients, fetchSyncStatus, startCooldown]);

  useEffect(() => { fetchClients(); }, [fetchClients]);
  useEffect(() => {
    fetchSyncStatus();
    const interval = setInterval(fetchSyncStatus, 30000);
    return () => { clearInterval(interval); if (cooldownTimer.current) clearTimeout(cooldownTimer.current); };
  }, [fetchSyncStatus]);

  const syncBusy = syncing || syncRunningRemote;

  return (
    <div>
      {/* Sync bar */}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 mb-3">
        {syncMsg && (
          <span className={`text-xs ${syncMsg.kind === 'ok' ? 'text-teal-700' : syncMsg.kind === 'warn' ? 'text-amber-600' : 'text-red-600'}`}>
            {syncMsg.text}
          </span>
        )}
        <span className="text-xs text-gray-400">
          {syncBusy ? 'Sync in progress…' : `Last synced: ${relativeTime(lastSync?.ranAt)}`}
        </span>
        <button
          onClick={runSync}
          disabled={syncBusy || cooling}
          title={cooling ? 'Cooling down — try again shortly' : 'Re-sync clients from ServiceM8 + Xero'}
          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-teal-600 bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
        >
          {syncBusy ? (
            <><span className="animate-spin inline-block h-3 w-3 border-2 border-white border-t-transparent rounded-full" />Syncing…</>
          ) : (<>↻ Sync clients now</>)}
        </button>
      </div>

      {/* Sub-tabs + search */}
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="flex rounded-lg overflow-hidden border border-gray-200">
          {SUB_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setSub(t.key)}
              className={`px-3 py-1.5 text-xs font-medium ${sub === t.key ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or email..."
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-blue-500 w-56"
        />
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-teal-600 border-t-transparent" />
        </div>
      )}

      {!loading && sub === 'all' && <AllClients rows={clients} search={search} />}
      {!loading && sub === 'accepted' && <AcceptedQuotes rows={clients} search={search} />}
      {!loading && sub === 'duplicates' && <Duplicates rows={clients} search={search} />}
    </div>
  );
}
