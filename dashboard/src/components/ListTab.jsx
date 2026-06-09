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

function formatCurrency(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function scopeTag(scope) {
  if (!scope) return 'No scope';
  const firstWord = scope.split(/[,.]/)[0].trim();
  return firstWord.length > 38 ? firstWord.slice(0, 38) + '…' : firstWord;
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
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [expanded, setExpanded] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/dashboard/projects', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch projects');
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (err) {
      console.error('Projects fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

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
  }, [projects, search, statusFilter, crewFilter, invoiceFilter, sortKey, sortDir]);

  const summary = useMemo(() => {
    const total = projects.length;
    const openQuotes = projects.filter((p) => QUOTE_STAGES.includes(p.stage)).length;
    const inProduction = projects.filter((p) => PRODUCTION_STAGES.includes(p.stage)).length;
    const completed = projects.filter((p) => p.stage === 'completed').length;
    return { total, openQuotes, inProduction, completed };
  }, [projects]);

  const sortArrow = (key) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const headerBtn = 'cursor-pointer select-none hover:text-gray-700';

  return (
    <div>
      {/* Summary cards */}
      <div className="flex flex-wrap gap-3 mb-4">
        <SummaryCard label="Total projects" value={summary.total} />
        <SummaryCard label="Open quotes" value={summary.openQuotes} accent="#633806" />
        <SummaryCard label="In production" value={summary.inProduction} accent="#0C447C" />
        <SummaryCard label="Completed" value={summary.completed} accent="#27500A" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer, address, job #, design #..."
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-teal-500 w-56"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-teal-500 bg-white text-gray-700"
        >
          <option value="all">All statuses</option>
          {STAGE_KEYS.map((k) => (
            <option key={k} value={k}>{STAGE_STYLES[k].label}</option>
          ))}
        </select>
        <select
          value={crewFilter}
          onChange={(e) => setCrewFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-teal-500 bg-white text-gray-700"
        >
          {CREW_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <select
          value={invoiceFilter}
          onChange={(e) => setInvoiceFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-teal-500 bg-white text-gray-700"
        >
          {INVOICE_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <div className="text-xs text-gray-400 self-center ml-auto">
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

      {!loading && filtered.length > 0 && (
        <div className="overflow-x-auto bg-white rounded-xl border border-gray-200">
          <table className="w-full text-xs" style={{ minWidth: '980px' }}>
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-100">
                <th className="py-2.5 px-3 font-medium">Job #</th>
                <th className={`py-2.5 px-3 font-medium ${headerBtn}`} onClick={() => toggleSort('customer')}>Customer{sortArrow('customer')}</th>
                <th className="py-2.5 px-3 font-medium">Design #</th>
                <th className="py-2.5 px-3 font-medium">Scope</th>
                <th className={`py-2.5 px-3 font-medium ${headerBtn}`} onClick={() => toggleSort('status')}>Status{sortArrow('status')}</th>
                <th className="py-2.5 px-3 font-medium">Crew</th>
                <th className="py-2.5 px-3 font-medium">Invoice</th>
                <th className={`py-2.5 px-3 font-medium text-right ${headerBtn}`} onClick={() => toggleSort('value')}>Value{sortArrow('value')}</th>
                <th className={`py-2.5 px-3 font-medium ${headerBtn}`} onClick={() => toggleSort('date')}>Date{sortArrow('date')}</th>
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
                      className={`border-b border-gray-50 cursor-pointer hover:bg-gray-50 ${isOpen ? 'bg-gray-50' : ''} ${savingId === p.id ? 'opacity-60' : ''}`}
                    >
                      <td className="py-2 px-3 font-mono text-gray-500 whitespace-nowrap">
                        {p.sm8_job_number ? `#${p.sm8_job_number}` : '—'}
                      </td>
                      <td className="py-2 px-3">
                        <div className="font-medium text-gray-900 whitespace-nowrap">{p.sm8_client_name}</div>
                        {p.job_address && (
                          <div className="text-[11px] text-gray-400 whitespace-nowrap" title={p.job_address}>
                            {p.job_address}
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
                      <td className="py-2 px-3 text-gray-500" title={p.scope_summary || ''}>
                        <span className="inline-block bg-gray-100 text-gray-600 rounded px-2 py-0.5 whitespace-nowrap">
                          {scopeTag(p.scope_summary)}
                        </span>
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
                      <td className="py-2 px-3 text-right font-medium text-gray-700 whitespace-nowrap">
                        {formatCurrency(p.quoted_total)}
                      </td>
                      <td className="py-2 px-3 text-gray-500 whitespace-nowrap">{formatDate(p.created_at)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-gray-50 border-b border-gray-100">
                        <td colSpan={9} className="px-3 pb-3 pt-1">
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
                                Notes {p.comment_count ? `(${p.comment_count} activity)` : ''}
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
    </div>
  );
}
