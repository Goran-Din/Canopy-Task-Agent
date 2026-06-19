import { useState, useEffect, useCallback, useRef } from 'react';
import RowMeta from './RowMeta';

// Completed jobs (stage = completed). Clean list for now — full financial
// analysis is a later phase. Pulls from the existing /dashboard/projects feed
// (which returns every stage) and filters client-side.

// Client-side cooldown after a manual Xero sync (the server enforces ~60s too).
const SYNC_COOLDOWN_MS = 60_000;

// "Last synced" relative-time label (mirrors the List's ServiceM8 sync label).
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

// Same format the shared InvoiceBadge uses for amounts (2 decimals).
function formatAmount(amount) {
  if (amount == null) return '';
  return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Chip palette — identical hex to the shared InvoiceBadge so the per-invoice
// pills and the summary badge match the List/Pipeline colors exactly.
const PILL = {
  Paid:         { bg: '#D1FAE5', text: '#059669' }, // green
  Invoiced:     { bg: '#FEF3C7', text: '#D97706' }, // amber
  Overdue:      { bg: '#FEE2E2', text: '#DC2626' }, // red
  not_invoiced: { bg: '#F3F4F6', text: '#6B7280' }, // gray
};

// Summary-badge styling reuses the per-invoice palettes, except "Not invoiced"
// gets its own violet so completed-but-unbilled jobs stand out for billing — and
// stays visually distinct from red Overdue (a different action: create an invoice
// vs. chase payment). Violet here only; the per-invoice PILL palette is untouched.
const SUMMARY_BADGE = {
  'Paid in full':  PILL.Paid,
  'Partially paid': PILL.Invoiced,
  'Overdue':       PILL.Overdue,
  'Not invoiced':  { bg: '#EDE9FE', text: '#6D28D9' }, // violet
};

// Format a date-only 'YYYY-MM-DD' string as a local calendar date WITHOUT a
// timezone shift (the feed already returns clean date strings via to_char, so
// we build the Date from explicit parts rather than parsing the string as UTC).
function formatDateOnly(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function Pill({ status, label }) {
  const style = PILL[status] || PILL.not_invoiced;
  return (
    <span
      className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full"
      style={{ backgroundColor: style.bg, color: style.text }}
    >
      {label || status}
    </span>
  );
}

// The Phase 4b billing block: Project Total + at-a-glance summary line + the
// per-invoice list (each Xero invoice's pill, number, amount, date, Reference).
// Reads the real feed fields populated in Phase 4a — no placeholder data.
function BillingBlock({ p }) {
  const projectTotal = p.project_total != null ? Number(p.project_total) : null;
  const totalInvoiced = Number(p.total_invoiced || 0);
  const totalPaid = Number(p.total_paid || 0);
  const invoices = Array.isArray(p.invoices) ? p.invoices : [];

  // A usable total for the percentage (guard against null AND 0 → no div-by-zero).
  const hasTotal = projectTotal != null && projectTotal > 0;
  const pct = hasTotal ? Math.round((totalInvoiced / projectTotal) * 100) : null;

  // Summary badge state.
  let badge;
  if (invoices.length === 0) {
    badge = 'Not invoiced';
  } else if (invoices.some((i) => i.status === 'Overdue')) {
    badge = 'Overdue';
  } else {
    const fullyPaid = totalPaid >= totalInvoiced
      && (projectTotal == null ? totalInvoiced > 0 : totalInvoiced >= projectTotal);
    badge = fullyPaid ? 'Paid in full' : 'Partially paid';
  }

  return (
    <div className="mt-1.5">
      {/* Summary line: badge · Invoiced $X / $Total (Y%) · Paid $Z */}
      <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[11px] text-gray-600">
        <span
          className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full"
          style={{ backgroundColor: SUMMARY_BADGE[badge].bg, color: SUMMARY_BADGE[badge].text }}
        >
          {badge}
        </span>
        {invoices.length > 0 ? (
          <span>
            <span className="text-gray-500">Invoiced</span>{' '}
            <span className="font-semibold text-gray-800">{formatAmount(totalInvoiced)}</span>
            {hasTotal && (
              <span className="text-gray-500"> / {formatAmount(projectTotal)} ({pct}%)</span>
            )}
            <span className="text-gray-300"> · </span>
            <span className="text-gray-500">Paid</span>{' '}
            <span className="font-semibold" style={{ color: '#059669' }}>{formatAmount(totalPaid)}</span>
          </span>
        ) : (
          <span className="text-gray-400">No invoices yet</span>
        )}
      </div>

      {/* Per-invoice list: [pill] INV-#### · $amount · <date> · <Reference> */}
      {invoices.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {invoices.map((inv, idx) => {
            const dateLabel = inv.paid_date
              ? `paid ${formatDateOnly(inv.paid_date)}`
              : inv.due_date ? `due ${formatDateOnly(inv.due_date)}` : '';
            return (
              <div
                key={inv.xero_invoice_id || inv.invoice_number || idx}
                className="flex items-center gap-x-1.5 gap-y-0.5 flex-wrap text-[11px] text-gray-500"
              >
                <Pill status={inv.status} />
                {inv.invoice_number && <span className="font-mono text-gray-700">{inv.invoice_number}</span>}
                <span className="text-gray-300">·</span>
                <span className="font-semibold text-gray-800">{formatAmount(inv.amount)}</span>
                {dateLabel && (<><span className="text-gray-300">·</span><span>{dateLabel}</span></>)}
                {inv.note && (<><span className="text-gray-300">·</span><span className="italic truncate max-w-[280px]" title={inv.note}>{inv.note}</span></>)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function CompletedTab() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // "Sync from Xero" state.
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);    // { text, kind: 'ok'|'err'|'warn' }
  const [lastSync, setLastSync] = useState(null);   // parsed xero_invoice_last_sync
  const [syncRunningRemote, setSyncRunningRemote] = useState(false);
  const [cooling, setCooling] = useState(false);    // client-side cooldown active
  const cooldownTimer = useRef(null);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/dashboard/projects', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch projects');
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (err) {
      console.error('Completed fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll last-Xero-sync info + whether a sync is running (cron or manual).
  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await fetch('/dashboard/sync-xero-status', { credentials: 'include' });
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
      const res = await fetch('/dashboard/sync-xero', { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({ status: 'error' }));

      if (res.status === 409 || data.status === 'already_running') {
        setSyncRunningRemote(true);
        setSyncMsg({ text: 'Sync already in progress…', kind: 'warn' });
      } else if (data.status === 'day_limited') {
        setSyncMsg({ text: 'Xero daily limit reached — try again after it resets', kind: 'warn' });
        startCooldown();
      } else if (data.status === 'cooldown') {
        setSyncMsg({ text: 'Just synced — try again shortly', kind: 'warn' });
        startCooldown();
      } else if (data.status === 'ok') {
        const upserted = data.prospectInvoicesUpserted ?? 0;
        const fetched = data.invoicesFetched ?? 0;
        setSyncMsg({ text: `Synced ${fetched} invoices · ${upserted} attached`, kind: 'ok' });
        await fetchProjects();   // show updated invoices/statuses/totals
        startCooldown();
      } else {
        throw new Error(data.error || 'Sync failed');
      }
      await fetchSyncStatus();   // refresh "last synced"
    } catch (err) {
      console.error('Xero sync error:', err);
      setSyncMsg({ text: 'Sync failed — try again', kind: 'err' });
    } finally {
      setSyncing(false);
    }
  }, [syncing, syncRunningRemote, cooling, fetchProjects, fetchSyncStatus, startCooldown]);

  useEffect(() => {
    fetchProjects();
    const interval = setInterval(fetchProjects, 60000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  useEffect(() => {
    fetchSyncStatus();
    const interval = setInterval(fetchSyncStatus, 30000);
    return () => {
      clearInterval(interval);
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    };
  }, [fetchSyncStatus]);

  const rows = projects
    .filter((p) => p.stage === 'completed' && !p.is_duplicate)
    .filter((p) => !search || (p.sm8_client_name || '').toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  const syncBusy = syncing || syncRunningRemote;

  return (
    <div>
      {/* Sync bar — on-demand read-only Xero invoice pull + last-synced indicator */}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 mb-3">
        {syncMsg && (
          <span className={`text-xs ${
            syncMsg.kind === 'ok' ? 'text-teal-700'
              : syncMsg.kind === 'warn' ? 'text-amber-600'
              : 'text-red-600'
          }`}>
            {syncMsg.text}
          </span>
        )}
        <span className="text-xs text-gray-400">
          {syncBusy ? 'Sync in progress…' : `Last synced: ${relativeTime(lastSync?.ranAt)}`}
        </span>
        <button
          onClick={runSync}
          disabled={syncBusy || cooling}
          title={cooling ? 'Cooling down — try again shortly' : 'Pull the latest invoices from Xero'}
          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-teal-600 bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
        >
          {syncBusy ? (
            <>
              <span className="animate-spin inline-block h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
              Syncing…
            </>
          ) : (
            <>↻ Sync from Xero</>
          )}
        </button>
      </div>

      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="text-sm font-semibold text-gray-700">
          Completed jobs
          <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full ml-2">{rows.length}</span>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients..."
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-blue-500 w-48"
        />
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-teal-600 border-t-transparent" />
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="text-center text-gray-400 text-sm py-12">No completed jobs.</div>
      )}

      {!loading && rows.length > 0 && (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
          {rows.map((p) => {
            const projectTotal = p.project_total != null ? Number(p.project_total) : null;
            return (
              <div key={p.id} className="px-3 py-2">
                {/* Line 1 — identity + Project Total on the right */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[15px] font-medium text-gray-900 truncate max-w-[260px]" title={p.sm8_client_name}>
                    {p.sm8_client_name}
                  </span>
                  {p.sm8_job_number && (
                    <span className="shrink-0 text-[11px] text-gray-400 font-mono">#{p.sm8_job_number}</span>
                  )}
                  <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                    Completed
                  </span>
                  {p.completed_on && (
                    <span className="shrink-0 text-[11px] text-gray-400">· {formatDateOnly(p.completed_on)}</span>
                  )}
                  <div className="ml-auto text-[11px]">
                    <span className="text-gray-400">Project Total </span>
                    {projectTotal != null ? (
                      <span className="font-semibold text-gray-900">{formatAmount(projectTotal)}</span>
                    ) : (
                      <span className="text-gray-400 italic">not set</span>
                    )}
                  </div>
                </div>

                {/* Phase 4b billing block — summary line + per-invoice list */}
                <BillingBlock p={p} />

                {/* Address · Design # · GDrive */}
                <div className="flex items-center gap-x-1 gap-y-0.5 flex-wrap text-[10px] text-gray-400 mt-[5px] min-w-0">
                  <RowMeta p={p} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
