import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import InvoiceBadge from './InvoiceBadge';
import CommentField from './CommentField';
import {
  STAGE_STYLES,
  STAGE_KEYS,
  SELECTABLE_STAGE_KEYS,
  QUOTE_STAGES,
  PRODUCTION_STAGES,
  CREW_OPTIONS,
} from '../stages';

const INVOICE_FILTERS = [
  { key: 'all', label: 'All invoices' },
  { key: 'not_invoiced', label: 'Not invoiced' },
  { key: 'invoiced', label: 'Invoiced' },
  { key: 'paid', label: 'Paid' },
  { key: 'overdue', label: 'Overdue' },
];

const CREW_FILTERS = [
  { key: 'all', label: 'All crews' },
  { key: 'hp1', label: 'HP#1' },
  { key: 'hp2', label: 'HP#2' },
  { key: 'unassigned', label: 'Unassigned' },
];

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// tz-safe format for a date-only 'YYYY-MM-DD' string (e.g. quote_created_on from
// the feed) — builds the Date from explicit parts so it never shifts a day in a
// non-UTC browser (same approach as CompletedTab's billing-block dates).
function formatDateOnly(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return formatDate(iso);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// The List "Date" = real SM8 quote-created date (quote_created_on), falling back
// to our created_at for any row without an SM8 date (manual/non-SM8 rows) so the
// column is never blank.
function listDateDisplay(p) {
  return p.quote_created_on ? formatDateOnly(p.quote_created_on) : formatDate(p.created_at);
}
// Sortable epoch for the same value (quote_created_on first, else created_at).
function listDateSortValue(p) {
  const src = p.quote_created_on ? `${p.quote_created_on}T00:00:00` : p.created_at;
  return new Date(src || 0).getTime();
}

// "Last synced" relative-time label for the sync button.
function relativeTime(iso) {
  if (!iso) return 'never';
  const then = new Date(iso);
  if (isNaN(then)) return 'never';
  const secs = Math.round((Date.now() - then.getTime()) / 1000);
  if (secs < 0) return 'just now';
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

function buildInvoice(p) {
  if (!p.invoice_status) return null;
  return {
    status: p.invoice_status,
    invoice_number: p.invoice_number,
    invoice_amount: p.invoice_amount != null ? parseFloat(p.invoice_amount) : null,
    due_date: p.invoice_due_date ? String(p.invoice_due_date).split('T')[0] : null,
    paid_date: p.invoice_paid_date ? String(p.invoice_paid_date).split('T')[0] : null,
  };
}

function SummaryCard({ label, value, accent }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex-1 min-w-[130px]">
      <div className="text-2xl font-bold" style={{ color: accent || '#111827' }}>{value}</div>
      <div className="text-xs text-gray-400 mt-0.5">{label}</div>
    </div>
  );
}

// Inline status dropdown — colored by phase, PATCHes stage on change.
// request_site_visit is not offered (see SELECTABLE_STAGE_KEYS); a row that is
// somehow already on an unselectable stage still shows its current value.
function StatusSelect({ value, onChange, disabled }) {
  const style = STAGE_STYLES[value] || STAGE_STYLES.request_site_visit;
  const options = SELECTABLE_STAGE_KEYS.includes(value)
    ? SELECTABLE_STAGE_KEYS
    : [value, ...SELECTABLE_STAGE_KEYS];
  return (
    <select
      value={value}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-full text-xs font-semibold border-none outline-none cursor-pointer px-2 py-1 appearance-none disabled:opacity-50"
      style={{ backgroundColor: style.bg, color: style.text }}
    >
      {options.map((k) => (
        <option key={k} value={k} style={{ backgroundColor: '#fff', color: '#111827' }}>
          {STAGE_STYLES[k]?.label || k}
        </option>
      ))}
    </select>
  );
}

// Read-only ServiceM8 status — soft tinted badge colored by value, distinct from
// the editable pipeline Status dropdown. Shows a subtle dash when empty.
// Known statuses get a soft color; anything else falls back to neutral grey.
const SM8_STATUS_STYLES = {
  'Quote':        'bg-orange-100 text-orange-700',
  'Work Order':   'bg-sky-100 text-sky-700',
  'Completed':    'bg-green-100 text-green-700',
  'Unsuccessful': 'bg-red-100 text-red-700',
};

function Sm8StatusBadge({ value }) {
  if (!value) return <span className="text-gray-300">—</span>;
  const tint = SM8_STATUS_STYLES[value] || 'bg-gray-100 text-gray-500';
  return (
    <span className={`inline-block rounded-full ${tint} text-xs font-medium px-2 py-1 whitespace-nowrap`}>
      {value}
    </span>
  );
}

function CrewSelect({ value, onChange, disabled }) {
  return (
    <select
      value={value || ''}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value || null)}
      className="rounded-md text-xs border border-gray-200 outline-none cursor-pointer px-2 py-1 bg-white text-gray-700 focus:border-teal-500 disabled:opacity-50"
    >
      <option value="">Unassigned</option>
      {CREW_OPTIONS.map((c) => (
        <option key={c.key} value={c.key}>{c.label}</option>
      ))}
    </select>
  );
}

// Inline editable Design # — manual reference, saves on blur if changed.
function DesignNumberCell({ value, disabled, onSave }) {
  const [text, setText] = useState(value || '');
  useEffect(() => { setText(value || ''); }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === (value || '').trim()) return;
    onSave(trimmed || null);
  };

  return (
    <input
      type="text"
      value={text}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      placeholder="—"
      className="w-20 rounded-md text-xs border border-gray-200 outline-none px-2 py-1 bg-white text-gray-700 focus:border-teal-500 disabled:opacity-50"
    />
  );
}

// Inline editable single-line text cell (Scope, Notes) — saves on blur if changed.
function TextCell({ value, disabled, onSave, placeholder = '—', widthClass = 'w-40' }) {
  const [text, setText] = useState(value || '');
  useEffect(() => { setText(value || ''); }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === (value || '').trim()) return;
    onSave(trimmed || null);
  };

  return (
    <input
      type="text"
      value={text}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      placeholder={placeholder}
      className={`${widthClass} rounded-md text-xs border border-gray-200 outline-none px-2 py-1 bg-white text-gray-700 focus:border-teal-500 disabled:opacity-50`}
    />
  );
}

// Inline editable currency/number cell — saves quoted_total on blur if changed.
function ValueCell({ value, disabled, onSave }) {
  const orig = value == null || value === '' ? '' : String(value);
  const [text, setText] = useState(orig);
  useEffect(() => { setText(value == null || value === '' ? '' : String(value)); }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === orig) return;
    if (trimmed === '') { onSave(null); return; }
    const n = Number(trimmed.replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(n)) { setText(orig); return; }
    onSave(n);
  };

  return (
    <div className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none">$</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        placeholder="—"
        className="w-24 rounded-md text-xs border border-gray-200 outline-none pl-5 pr-2 py-1 bg-white text-gray-700 text-right focus:border-teal-500 disabled:opacity-50"
      />
    </div>
  );
}

// Normalize a DATE coming back from Postgres/JSON to a yyyy-mm-dd input value.
function toDateInput(v) {
  if (!v) return '';
  return String(v).split('T')[0];
}

// Inline date-picker cell (native) — PATCHes the date field on change.
function DateCell({ value, disabled, onSave }) {
  return (
    <input
      type="date"
      value={toDateInput(value)}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onSave(e.target.value || null)}
      className="rounded-md text-xs border border-gray-200 outline-none px-2 py-1 bg-white text-gray-600 focus:border-teal-500 disabled:opacity-50"
    />
  );
}

// GDrive folder cell — inline editable. Empty -> "+ Add link" button that opens
// an inline URL bar (paste + OK/Cancel). Set -> a clickable "GDrive Folder" link
// (raw URL hidden) plus edit/clear controls. URL alone is enough; label optional.
function GDriveCell({ url, label, disabled, onSave }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(url || '');

  const startEdit = (e) => {
    e.stopPropagation();
    setText(url || '');
    setEditing(true);
  };
  const cancel = (e) => {
    if (e) e.stopPropagation();
    setText(url || '');
    setEditing(false);
  };
  const save = (e) => {
    if (e) e.stopPropagation();
    const trimmed = text.trim();
    if (!trimmed) {
      // Empty input: clear an existing link, otherwise just close.
      if (url) onSave({ gdrive_url: null, gdrive_label: null });
      setEditing(false);
      return;
    }
    onSave({ gdrive_url: trimmed });
    setEditing(false);
  };
  const clear = (e) => {
    e.stopPropagation();
    onSave({ gdrive_url: null, gdrive_label: null });
  };

  if (editing) {
    return (
      <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <input
          type="text"
          autoFocus
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            else if (e.key === 'Escape') cancel();
          }}
          placeholder="Paste folder URL"
          className="w-44 rounded-md text-xs border border-gray-200 outline-none px-2 py-1 bg-white text-gray-700 focus:border-teal-500 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={save}
          disabled={disabled}
          className="text-xs font-medium text-teal-700 hover:text-teal-900 disabled:opacity-50"
        >
          OK
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={disabled}
          className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (url) {
    return (
      <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-teal-700 hover:text-teal-900 underline whitespace-nowrap"
          title={label || 'GDrive Folder'}
        >
          {label || 'GDrive Folder'}
        </a>
        <button
          type="button"
          onClick={startEdit}
          disabled={disabled}
          className="text-gray-300 hover:text-gray-500 disabled:opacity-50"
          title="Edit link"
        >
          ✎
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={disabled}
          className="text-gray-300 hover:text-red-500 disabled:opacity-50"
          title="Remove link"
        >
          ✕
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={startEdit}
      disabled={disabled}
      className="text-xs text-gray-400 hover:text-teal-700 disabled:opacity-50 whitespace-nowrap"
    >
      + Add link
    </button>
  );
}

// One labeled row inside a mobile card (module-scope so it stays mounted).
function CardRow({ label, children }) {
  return (
    <>
      <div className="text-gray-400">{label}</div>
      <div className="min-w-0">{children}</div>
    </>
  );
}

// Stacked card used on narrow (<768px) screens — same controls as the table.
function MobileCard({ p, saving, onPatch, onHide, onUnhide }) {
  const invoice = buildInvoice(p);
  return (
    <div
      className={`rounded-xl border border-gray-200 p-3 ${p.hidden ? 'bg-gray-100' : 'bg-white'} ${saving ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`font-semibold text-sm ${p.hidden ? 'text-gray-500 italic' : 'text-gray-900'}`}>
            {p.sm8_client_name}
          </div>
          {p.job_address && <div className="text-[11px] text-gray-400">{p.job_address}</div>}
        </div>
        <div className="text-xs font-mono text-gray-400 shrink-0">
          {p.sm8_job_number ? `#${p.sm8_job_number}` : '—'}
        </div>
      </div>
      {p.hidden && (
        <div className="text-[11px] text-amber-700 mt-1">🚫 Hidden — {p.hidden_reason || 'no reason'}</div>
      )}

      <div className="mt-3 grid grid-cols-[78px_1fr] gap-y-2 gap-x-2 items-center text-xs">
        <CardRow label="ServiceM8 Status">
          <Sm8StatusBadge value={p.sm8_status} />
        </CardRow>
        <CardRow label="Status">
          <StatusSelect value={p.stage} disabled={saving} onChange={(stage) => onPatch(p.id, { stage })} />
        </CardRow>
        <CardRow label="Design #">
          <DesignNumberCell value={p.design_number} disabled={saving} onSave={(design_number) => onPatch(p.id, { design_number })} />
        </CardRow>
        <CardRow label="Scope">
          <TextCell value={p.scope_summary} disabled={saving} placeholder="Add scope…" widthClass="w-full"
            onSave={(scope_summary) => onPatch(p.id, { scope_summary })} />
        </CardRow>
        <CardRow label="Invoice"><InvoiceBadge invoice={invoice} division="hardscape" /></CardRow>
        <CardRow label="Value">
          <ValueCell value={p.quoted_total} disabled={saving} onSave={(quoted_total) => onPatch(p.id, { quoted_total })} />
        </CardRow>
        <CardRow label="Follow-Up">
          <DateCell value={p.follow_up_date} disabled={saving} onSave={(follow_up_date) => onPatch(p.id, { follow_up_date })} />
        </CardRow>
        <CardRow label="GDrive">
          <GDriveCell url={p.gdrive_url} label={p.gdrive_label} disabled={saving} onSave={(patch) => onPatch(p.id, patch)} />
        </CardRow>
        <CardRow label="Notes">
          <TextCell value={p.notes} disabled={saving} placeholder="Add a note…" widthClass="w-full"
            onSave={(notes) => onPatch(p.id, { notes })} />
        </CardRow>
        <CardRow label="Date"><span className="text-gray-500">{listDateDisplay(p)}</span></CardRow>
        <CardRow label="Job note">
          {p.sm8_job_uuid ? (
            <CommentField jobUuid={p.sm8_job_uuid} division="hardscape" initialComment={p.job_comment || ''} />
          ) : (
            <span className="text-gray-400 italic">No linked ServiceM8 job.</span>
          )}
        </CardRow>
      </div>

      <div className="mt-3 pt-2 border-t border-gray-100 flex justify-end">
        {p.hidden ? (
          <button onClick={() => onUnhide(p.id)} disabled={saving} className="text-xs font-medium text-teal-700 hover:text-teal-900 disabled:opacity-50">
            Unhide
          </button>
        ) : (
          <button onClick={() => onHide(p.id)} disabled={saving} className="text-xs font-medium text-gray-400 hover:text-red-600 disabled:opacity-50">
            Hide
          </button>
        )}
      </div>
    </div>
  );
}

const SORTABLE = {
  customer: (p) => (p.sm8_client_name || '').toLowerCase(),
  status: (p) => STAGE_KEYS.indexOf(p.stage),
  value: (p) => Number(p.quoted_total) || 0,
  date: (p) => listDateSortValue(p),
};

export default function ListTab() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [crewFilter, setCrewFilter] = useState('all');
  const [invoiceFilter, setInvoiceFilter] = useState('all');
  const [showHidden, setShowHidden] = useState(false);
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [expanded, setExpanded] = useState(null);
  const [savingId, setSavingId] = useState(null);
  // Per-section collapse state (List sections). Keyed by section key; absent/false
  // = expanded (the default). Independent per section; not persisted.
  const [collapsedSections, setCollapsedSections] = useState({});
  const toggleSection = useCallback(
    (key) => setCollapsedSections((c) => ({ ...c, [key]: !c[key] })),
    []
  );
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);   // { text, kind: 'ok'|'err' }
  const [lastSync, setLastSync] = useState(null); // parsed config_store value
  const [syncRunningRemote, setSyncRunningRemote] = useState(false);

  const fetchProjects = useCallback(async () => {
    try {
      const url = showHidden ? '/dashboard/projects?includeHidden=true' : '/dashboard/projects';
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch projects');
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (err) {
      console.error('Projects fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [showHidden]);

  useEffect(() => {
    fetchProjects();
    const interval = setInterval(fetchProjects, 60000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  // Optimistic PATCH for stage / crew_assignment, then refetch to resync.
  const patchProject = useCallback(async (id, patch) => {
    setSavingId(id);
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    try {
      const res = await fetch(`/dashboard/prospects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error('PATCH failed');
    } catch (err) {
      console.error('Update error:', err);
    } finally {
      await fetchProjects();
      setSavingId(null);
    }
  }, [fetchProjects]);

  // Poll last-sync info + whether a sync is currently running (cron or manual).
  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await fetch('/dashboard/sync-status', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setLastSync(data.last_sync || null);
      setSyncRunningRemote(!!data.running);
    } catch {
      // non-fatal — leave previous state
    }
  }, []);

  useEffect(() => {
    fetchSyncStatus();
    const interval = setInterval(fetchSyncStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchSyncStatus]);

  // Trigger the on-demand one-way pull. No aggressive client timeout — the full
  // SM8 pull can take several seconds.
  const runSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch('/dashboard/sync', { method: 'POST', credentials: 'include' });
      if (res.status === 409) {
        setSyncRunningRemote(true);
        setSyncMsg({ text: 'Sync already in progress…', kind: 'err' });
        return;
      }
      if (!res.ok) throw new Error('Sync failed');
      const data = await res.json();
      const s = data.summary || {};
      setSyncMsg({ text: `Pulled ${s.added ?? 0} new, refreshed ${s.refreshed ?? 0}`, kind: 'ok' });
      await fetchProjects();      // surface new/updated rows
      await fetchSyncStatus();    // refresh "last synced"
    } catch (err) {
      console.error('Sync error:', err);
      setSyncMsg({ text: 'Sync failed — try again', kind: 'err' });
    } finally {
      setSyncing(false);
    }
  }, [syncing, fetchProjects, fetchSyncStatus]);

  const hideProject = useCallback((id) => {
    const reason = window.prompt('Reason for hiding this project (required):');
    if (reason === null) return; // cancelled
    const trimmed = reason.trim();
    if (!trimmed) {
      window.alert('A reason is required to hide a project.');
      return;
    }
    patchProject(id, { hidden: true, hidden_reason: trimmed });
  }, [patchProject]);

  const unhideProject = useCallback((id) => {
    patchProject(id, { hidden: false });
  }, [patchProject]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'customer' || key === 'status' ? 'asc' : 'desc');
    }
  };

  const filtered = useMemo(() => {
    let rows = projects.filter((p) => {
      // List tab scope: only the two quote stages; duplicates live in Archive.
      if (p.stage !== 'pending_quote' && p.stage !== 'quote_sent') return false;
      if (p.is_duplicate) return false;
      if (!showHidden && p.hidden) return false;
      if (search) {
        const q = search.toLowerCase();
        const hay = `${p.sm8_client_name || ''} ${p.sm8_job_number || ''} ${p.design_number || ''} ${p.job_address || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (crewFilter === 'unassigned' && p.crew_assignment) return false;
      if ((crewFilter === 'hp1' || crewFilter === 'hp2') && p.crew_assignment !== crewFilter) return false;
      if (invoiceFilter !== 'all') {
        const st = p.invoice_status || 'not_invoiced';
        if (st !== invoiceFilter) return false;
      }
      return true;
    });

    const getter = SORTABLE[sortKey] || SORTABLE.date;
    rows = [...rows].sort((a, b) => {
      const va = getter(a);
      const vb = getter(b);
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  }, [projects, search, crewFilter, invoiceFilter, sortKey, sortDir, showHidden]);

  // Two labeled sections: Needs quote (pending_quote) and Quote sent (quote_sent).
  const listSections = useMemo(() => ([
    { key: 'pending_quote', label: 'Needs quote', rows: filtered.filter((p) => p.stage === 'pending_quote') },
    { key: 'quote_sent', label: 'Quote sent — follow up', rows: filtered.filter((p) => p.stage === 'quote_sent') },
  ]), [filtered]);

  const summary = useMemo(() => {
    const visible = projects.filter((p) => !p.hidden);
    const total = visible.length;
    const openQuotes = visible.filter((p) => QUOTE_STAGES.includes(p.stage)).length;
    const inProduction = visible.filter((p) => PRODUCTION_STAGES.includes(p.stage)).length;
    const completed = visible.filter((p) => p.stage === 'completed').length;
    return { total, openQuotes, inProduction, completed };
  }, [projects]);

  const sortArrow = (key) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const headerBtn = 'cursor-pointer select-none hover:text-gray-700';

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Sync bar — on-demand one-way pull from ServiceM8 + last-synced indicator */}
      <div className="shrink-0 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 mb-3">
        {syncMsg && (
          <span className={`text-xs ${syncMsg.kind === 'ok' ? 'text-teal-700' : 'text-red-600'}`}>
            {syncMsg.text}
          </span>
        )}
        <span className="text-xs text-gray-400">
          {syncRunningRemote && !syncing
            ? 'Sync in progress…'
            : `Last synced: ${relativeTime(lastSync?.ranAt)}`}
        </span>
        <button
          onClick={runSync}
          disabled={syncing || syncRunningRemote}
          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-teal-600 bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
        >
          {(syncing || syncRunningRemote) ? (
            <>
              <span className="animate-spin inline-block h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
              Syncing…
            </>
          ) : (
            <>↻ Sync from ServiceM8</>
          )}
        </button>
      </div>

      {/* Summary cards */}
      <div className="shrink-0 grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <SummaryCard label="Total projects" value={summary.total} />
        <SummaryCard label="Open quotes" value={summary.openQuotes} accent="#633806" />
        <SummaryCard label="In production" value={summary.inProduction} accent="#0C447C" />
        <SummaryCard label="Completed" value={summary.completed} accent="#27500A" />
      </div>

      {/* Toolbar — stacks full-width on mobile, wraps inline on sm+ */}
      <div className="shrink-0 flex flex-col sm:flex-row sm:flex-wrap gap-2 mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer, address, job #, design #..."
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-teal-500 w-full sm:w-56"
        />
        <select
          value={crewFilter}
          onChange={(e) => setCrewFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-teal-500 bg-white text-gray-700 w-full sm:w-auto"
        >
          {CREW_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <select
          value={invoiceFilter}
          onChange={(e) => setInvoiceFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-teal-500 bg-white text-gray-700 w-full sm:w-auto"
        >
          {INVOICE_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <button
          onClick={() => setShowHidden((v) => !v)}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border w-full sm:w-auto ${
            showHidden
              ? 'bg-gray-700 text-white border-gray-700'
              : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          {showHidden ? '✓ Showing hidden' : 'Show hidden'}
        </button>
        <div className="text-xs text-gray-400 sm:self-center sm:ml-auto">
          {filtered.length} of {projects.length}
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-10">
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-teal-600 border-t-transparent" />
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center text-gray-400 text-sm py-12">No projects match the current filters.</div>
      )}

      {/* Desktop / tablet: scrollable table with pinned identity + actions columns.
          flex-1 + min-h-0 makes it fill the remaining viewport height and scroll
          internally (both axes) instead of growing the page. */}
      {!loading && filtered.length > 0 && (
        <div className="hidden md:block hs-scroll flex-1 min-h-0 bg-white rounded-xl border border-gray-200">
          <table className="hs-table text-xs">
            <thead>
              <tr className="text-left text-gray-400">
                <th className="hs-sticky-left py-2.5 px-3 font-medium">Job #</th>
                <th className={`py-2.5 px-3 font-medium ${headerBtn}`} onClick={() => toggleSort('customer')}>Customer{sortArrow('customer')}</th>
                <th className="py-2.5 px-3 font-medium">Design #</th>
                <th className="py-2.5 px-3 font-medium">GDrive</th>
                <th className="py-2.5 px-3 font-medium">Scope</th>
                <th className="py-2.5 px-3 font-medium">ServiceM8 Status</th>
                <th className={`py-2.5 px-3 font-medium ${headerBtn}`} onClick={() => toggleSort('status')}>Status{sortArrow('status')}</th>
                <th className="py-2.5 px-3 font-medium">Invoice</th>
                <th className={`py-2.5 px-3 font-medium text-right ${headerBtn}`} onClick={() => toggleSort('value')}>Value{sortArrow('value')}</th>
                <th className="py-2.5 px-3 font-medium">Follow-Up</th>
                <th className="py-2.5 px-3 font-medium">Notes</th>
                <th className={`py-2.5 px-3 font-medium ${headerBtn}`} onClick={() => toggleSort('date')}>Date{sortArrow('date')}</th>
                <th className="hs-sticky-right py-2.5 px-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {listSections.map((sec) => {
                const sectionCollapsed = !!collapsedSections[sec.key];
                return (
                <Fragment key={`sec-${sec.key}`}>
                  <tr
                    className="bg-gray-50 cursor-pointer select-none hover:bg-gray-100"
                    onClick={() => toggleSection(sec.key)}
                  >
                    <td colSpan={13} className="py-1.5 px-3 text-[11px] font-semibold text-gray-600">
                      <span className="inline-block w-3 text-gray-400">{sectionCollapsed ? '▸' : '▾'}</span>
                      {sec.label} <span className="text-gray-400 font-normal">· {sec.rows.length}</span>
                    </td>
                  </tr>
                  {!sectionCollapsed && sec.rows.length === 0 && (
                    <tr>
                      <td colSpan={13} className="py-2 px-3 text-xs text-gray-400 italic">No jobs in this section.</td>
                    </tr>
                  )}
                  {!sectionCollapsed && sec.rows.map((p) => {
                    const invoice = buildInvoice(p);
                    const isOpen = expanded === p.id;
                return (
                  <Fragment key={p.id}>
                    <tr
                      onClick={() => setExpanded(isOpen ? null : p.id)}
                      className={`cursor-pointer ${isOpen ? 'hs-row-expanded' : ''} ${savingId === p.id ? 'opacity-60' : ''} ${p.hidden ? 'hs-row-hidden text-gray-400 italic' : ''}`}
                    >
                      <td className="hs-sticky-left py-2 px-3 font-mono text-gray-500 whitespace-nowrap">
                        {p.sm8_job_number ? `#${p.sm8_job_number}` : '—'}
                      </td>
                      <td className="py-2 px-3 max-w-[220px]">
                        <div className={`font-medium truncate ${p.hidden ? 'text-gray-500' : 'text-gray-900'}`} title={p.sm8_client_name}>{p.sm8_client_name}</div>
                        {p.job_address && (
                          <div className="text-[11px] text-gray-400 truncate" title={p.job_address}>
                            {p.job_address}
                          </div>
                        )}
                        {p.hidden && (
                          <div className="text-[11px] text-amber-700 not-italic truncate" title={p.hidden_reason || ''}>
                            🚫 Hidden — {p.hidden_reason || 'no reason'}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <DesignNumberCell
                          value={p.design_number}
                          disabled={savingId === p.id}
                          onSave={(design_number) => patchProject(p.id, { design_number })}
                        />
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <GDriveCell
                          url={p.gdrive_url}
                          label={p.gdrive_label}
                          disabled={savingId === p.id}
                          onSave={(patch) => patchProject(p.id, patch)}
                        />
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <TextCell
                          value={p.scope_summary}
                          disabled={savingId === p.id}
                          placeholder="Add scope…"
                          widthClass="w-44"
                          onSave={(scope_summary) => patchProject(p.id, { scope_summary })}
                        />
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <Sm8StatusBadge value={p.sm8_status} />
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <StatusSelect
                          value={p.stage}
                          disabled={savingId === p.id}
                          onChange={(stage) => patchProject(p.id, { stage })}
                        />
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <InvoiceBadge invoice={invoice} division="hardscape" />
                      </td>
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        <ValueCell
                          value={p.quoted_total}
                          disabled={savingId === p.id}
                          onSave={(quoted_total) => patchProject(p.id, { quoted_total })}
                        />
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <DateCell
                          value={p.follow_up_date}
                          disabled={savingId === p.id}
                          onSave={(follow_up_date) => patchProject(p.id, { follow_up_date })}
                        />
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <TextCell
                          value={p.notes}
                          disabled={savingId === p.id}
                          placeholder="Add a note…"
                          widthClass="w-44"
                          onSave={(notes) => patchProject(p.id, { notes })}
                        />
                      </td>
                      <td className="py-2 px-3 text-gray-500 whitespace-nowrap">{listDateDisplay(p)}</td>
                      <td className="hs-sticky-right py-2 px-3 whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                        {p.hidden ? (
                          <button
                            onClick={() => unhideProject(p.id)}
                            disabled={savingId === p.id}
                            className="text-xs font-medium text-teal-700 hover:text-teal-900 disabled:opacity-50"
                          >
                            Unhide
                          </button>
                        ) : (
                          <button
                            onClick={() => hideProject(p.id)}
                            disabled={savingId === p.id}
                            className="text-xs font-medium text-gray-400 hover:text-red-600 disabled:opacity-50"
                          >
                            Hide
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="hs-detail-row">
                        <td colSpan={13} className="px-3 pb-3 pt-1">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <div className="text-xs font-semibold text-gray-500 mb-1">Full scope</div>
                              <div className="text-xs text-gray-600 leading-relaxed">
                                {p.scope_summary || '(no scope details)'}
                              </div>
                              {p.sm8_status && (
                                <div className="text-xs text-gray-400 mt-2">ServiceM8 status: {p.sm8_status}</div>
                              )}
                            </div>
                            <div onClick={(e) => e.stopPropagation()}>
                              <div className="text-xs font-semibold text-gray-500 mb-1">
                                Job note {p.comment_count ? `(${p.comment_count} activity)` : ''}
                              </div>
                              {p.sm8_job_uuid ? (
                                <CommentField
                                  jobUuid={p.sm8_job_uuid}
                                  division="hardscape"
                                  initialComment={p.job_comment || ''}
                                />
                              ) : (
                                <div className="text-xs text-gray-400 italic">
                                  No linked ServiceM8 job — notes unavailable for this project.
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                      </Fragment>
                    );
                  })}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile (<768px): stacked cards, no horizontal scroll. Scrolls internally
          (flex-1 + min-h-0) within the height-constrained content column. */}
      {!loading && filtered.length > 0 && (
        <div className="md:hidden flex-1 min-h-0 overflow-y-auto space-y-4">
          {listSections.map((sec) => {
            const sectionCollapsed = !!collapsedSections[sec.key];
            return (
            <div key={`m-${sec.key}`}>
              <div
                className="text-[11px] font-semibold text-gray-600 mb-2 cursor-pointer select-none"
                onClick={() => toggleSection(sec.key)}
              >
                <span className="inline-block w-3 text-gray-400">{sectionCollapsed ? '▸' : '▾'}</span>
                {sec.label} <span className="text-gray-400 font-normal">· {sec.rows.length}</span>
              </div>
              {sectionCollapsed ? null : sec.rows.length === 0 ? (
                <div className="text-xs text-gray-400 italic">No jobs in this section.</div>
              ) : (
                <div className="space-y-3">
                  {sec.rows.map((p) => (
                    <MobileCard
                      key={p.id}
                      p={p}
                      saving={savingId === p.id}
                      onPatch={patchProject}
                      onHide={hideProject}
                      onUnhide={unhideProject}
                    />
                  ))}
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
