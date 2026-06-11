import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import InvoiceBadge from './InvoiceBadge';
import CommentField from './CommentField';
import {
  STAGE_STYLES,
  STAGE_KEYS,
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
function StatusSelect({ value, onChange, disabled }) {
  const style = STAGE_STYLES[value] || STAGE_STYLES.request_site_visit;
  return (
    <select
      value={value}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-full text-xs font-semibold border-none outline-none cursor-pointer px-2 py-1 appearance-none disabled:opacity-50"
      style={{ backgroundColor: style.bg, color: style.text }}
    >
      {STAGE_KEYS.map((k) => (
        <option key={k} value={k} style={{ backgroundColor: '#fff', color: '#111827' }}>
          {STAGE_STYLES[k].label}
        </option>
      ))}
    </select>
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

// GDrive folder cell — shows a clickable link (never the raw URL); prompts to
// set/replace the URL (+ optional label). Empty -> "+ Add" affordance.
function GDriveCell({ url, label, disabled, onSave }) {
  const edit = (e) => {
    e.stopPropagation();
    const newUrl = window.prompt('Google Drive folder URL (leave blank to remove):', url || '');
    if (newUrl === null) return; // cancelled
    const trimmedUrl = newUrl.trim();
    if (!trimmedUrl) {
      onSave({ gdrive_url: null, gdrive_label: null });
      return;
    }
    const newLabel = window.prompt('Optional short label / folder number (e.g. "35"):', label || '');
    onSave({ gdrive_url: trimmedUrl, gdrive_label: (newLabel && newLabel.trim()) || null });
  };

  if (url) {
    return (
      <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-teal-700 hover:text-teal-900 underline truncate max-w-[120px]"
          title={label || 'GDrive Folder'}
        >
          {label || 'GDrive Folder'}
        </a>
        <button
          type="button"
          onClick={edit}
          disabled={disabled}
          className="text-gray-300 hover:text-gray-500 disabled:opacity-50"
          title="Edit GDrive link"
        >
          ✎
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={edit}
      disabled={disabled}
      className="text-xs text-gray-400 hover:text-teal-700 disabled:opacity-50"
    >
      + Add
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
        <CardRow label="Status">
          <StatusSelect value={p.stage} disabled={saving} onChange={(stage) => onPatch(p.id, { stage })} />
        </CardRow>
        <CardRow label="Crew">
          <CrewSelect value={p.crew_assignment} disabled={saving} onChange={(crew) => onPatch(p.id, { crew_assignment: crew })} />
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
        <CardRow label="Possible Start">
          <DateCell value={p.possible_start_date} disabled={saving} onSave={(possible_start_date) => onPatch(p.id, { possible_start_date })} />
        </CardRow>
        <CardRow label="Actual Start">
          <DateCell value={p.actual_start_date} disabled={saving} onSave={(actual_start_date) => onPatch(p.id, { actual_start_date })} />
        </CardRow>
        <CardRow label="GDrive">
          <GDriveCell url={p.gdrive_url} label={p.gdrive_label} disabled={saving} onSave={(patch) => onPatch(p.id, patch)} />
        </CardRow>
        <CardRow label="Notes">
          <TextCell value={p.notes} disabled={saving} placeholder="Add a note…" widthClass="w-full"
            onSave={(notes) => onPatch(p.id, { notes })} />
        </CardRow>
        <CardRow label="Date"><span className="text-gray-500">{formatDate(p.created_at)}</span></CardRow>
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
  date: (p) => new Date(p.created_at || 0).getTime(),
};

export default function ListTab() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [crewFilter, setCrewFilter] = useState('all');
  const [invoiceFilter, setInvoiceFilter] = useState('all');
  const [showHidden, setShowHidden] = useState(false);
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [expanded, setExpanded] = useState(null);
  const [savingId, setSavingId] = useState(null);

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
      if (!showHidden && p.hidden) return false;
      if (search) {
        const q = search.toLowerCase();
        const hay = `${p.sm8_client_name || ''} ${p.sm8_job_number || ''} ${p.design_number || ''} ${p.job_address || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (statusFilter !== 'all' && p.stage !== statusFilter) return false;
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
  }, [projects, search, statusFilter, crewFilter, invoiceFilter, sortKey, sortDir, showHidden]);

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
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <SummaryCard label="Total projects" value={summary.total} />
        <SummaryCard label="Open quotes" value={summary.openQuotes} accent="#633806" />
        <SummaryCard label="In production" value={summary.inProduction} accent="#0C447C" />
        <SummaryCard label="Completed" value={summary.completed} accent="#27500A" />
      </div>

      {/* Toolbar — stacks full-width on mobile, wraps inline on sm+ */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer, address, job #, design #..."
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-teal-500 w-full sm:w-56"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-teal-500 bg-white text-gray-700 w-full sm:w-auto"
        >
          <option value="all">All statuses</option>
          {STAGE_KEYS.map((k) => (
            <option key={k} value={k}>{STAGE_STYLES[k].label}</option>
          ))}
        </select>
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

      {/* Desktop / tablet: scrollable table with pinned identity + actions columns */}
      {!loading && filtered.length > 0 && (
        <div className="hidden md:block hs-scroll bg-white rounded-xl border border-gray-200">
          <table className="hs-table text-xs">
            <thead>
              <tr className="text-left text-gray-400">
                <th className="hs-sticky-left py-2.5 px-3 font-medium">Job #</th>
                <th className={`py-2.5 px-3 font-medium ${headerBtn}`} onClick={() => toggleSort('customer')}>Customer{sortArrow('customer')}</th>
                <th className="py-2.5 px-3 font-medium">Design #</th>
                <th className="py-2.5 px-3 font-medium">Scope</th>
                <th className={`py-2.5 px-3 font-medium ${headerBtn}`} onClick={() => toggleSort('status')}>Status{sortArrow('status')}</th>
                <th className="py-2.5 px-3 font-medium">Crew</th>
                <th className="py-2.5 px-3 font-medium">Invoice</th>
                <th className={`py-2.5 px-3 font-medium text-right ${headerBtn}`} onClick={() => toggleSort('value')}>Value{sortArrow('value')}</th>
                <th className="py-2.5 px-3 font-medium">Follow-Up</th>
                <th className="py-2.5 px-3 font-medium">Possible Start</th>
                <th className="py-2.5 px-3 font-medium">Actual Start</th>
                <th className="py-2.5 px-3 font-medium">GDrive</th>
                <th className="py-2.5 px-3 font-medium">Notes</th>
                <th className={`py-2.5 px-3 font-medium ${headerBtn}`} onClick={() => toggleSort('date')}>Date{sortArrow('date')}</th>
                <th className="hs-sticky-right py-2.5 px-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
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
                        <TextCell
                          value={p.scope_summary}
                          disabled={savingId === p.id}
                          placeholder="Add scope…"
                          widthClass="w-44"
                          onSave={(scope_summary) => patchProject(p.id, { scope_summary })}
                        />
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <StatusSelect
                          value={p.stage}
                          disabled={savingId === p.id}
                          onChange={(stage) => patchProject(p.id, { stage })}
                        />
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <CrewSelect
                          value={p.crew_assignment}
                          disabled={savingId === p.id}
                          onChange={(crew) => patchProject(p.id, { crew_assignment: crew })}
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
                        <DateCell
                          value={p.possible_start_date}
                          disabled={savingId === p.id}
                          onSave={(possible_start_date) => patchProject(p.id, { possible_start_date })}
                        />
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <DateCell
                          value={p.actual_start_date}
                          disabled={savingId === p.id}
                          onSave={(actual_start_date) => patchProject(p.id, { actual_start_date })}
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
                          value={p.notes}
                          disabled={savingId === p.id}
                          placeholder="Add a note…"
                          widthClass="w-44"
                          onSave={(notes) => patchProject(p.id, { notes })}
                        />
                      </td>
                      <td className="py-2 px-3 text-gray-500 whitespace-nowrap">{formatDate(p.created_at)}</td>
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
                        <td colSpan={15} className="px-3 pb-3 pt-1">
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
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile (<768px): stacked cards, no horizontal scroll */}
      {!loading && filtered.length > 0 && (
        <div className="md:hidden space-y-3">
          {filtered.map((p) => (
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
}
