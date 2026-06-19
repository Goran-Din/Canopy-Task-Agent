import { useState, useEffect } from 'react';
import InvoiceBadge from './InvoiceBadge';
import RowMeta, { hasRowMeta } from './RowMeta';
import { useNoteThread, NotePreview, NoteAddTrigger, NoteExpansion } from './NoteThread';
import { useReminders, ReminderChips, ReminderAddTrigger, ReminderForm } from './Reminders';
import { STAGE_STYLES } from '../stages';

const CREW_STYLES = {
  hp1: { bg: '#6B7280', label: 'HP#1' },
  hp2: { bg: '#92400E', label: 'HP#2' },
};

const CREW_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'hp1', label: 'HP#1' },
  { key: 'hp2', label: 'HP#2' },
  { key: 'unassigned', label: 'Unassigned' },
];

const INVOICE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'not_invoiced', label: 'Not Invoiced' },
  { key: 'overdue', label: 'Overdue' },
];

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

// Tentative "target start" (possible_start_date) — the soft date set while the
// deal is being closed, separate from the firm crew_schedule.start_date. Saves
// on change via PATCH; manages its own local value for immediate feedback.
function PossibleStartEditor({ prospectId, value }) {
  const [date, setDate] = useState(value ? String(value).split('T')[0] : '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDate(value ? String(value).split('T')[0] : ''); }, [value]);

  const save = async (newVal) => {
    setSaving(true);
    try {
      const res = await fetch(`/dashboard/prospects/${prospectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ possible_start_date: newVal || null }),
      });
      if (!res.ok) throw new Error('save failed');
    } catch (err) {
      console.error('Possible start save error:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <label
      className="inline-flex items-center gap-1 text-[10px] text-gray-500"
      onClick={(e) => e.stopPropagation()}
      title="Tentative target start (soft) — the firm work date is set when the job is scheduled"
    >
      <span className="text-gray-400">Target start</span>
      <input
        type="date"
        value={date}
        disabled={saving}
        onChange={(e) => { setDate(e.target.value); save(e.target.value); }}
        className="border border-gray-200 rounded px-1.5 py-0.5 text-[10px] outline-none focus:border-teal-500 disabled:opacity-50"
      />
    </label>
  );
}

function PipelineRow({ p }) {
  const stageStyle = STAGE_STYLES[p.stage] || STAGE_STYLES.request_site_visit;
  const crew = p.crew_assignment ? CREW_STYLES[p.crew_assignment] : null;
  const invoice = buildInvoice(p);
  const nt = useNoteThread({ prospectId: p.id, latestComment: p.latest_comment, commentCount: p.comment_count });
  const rm = useReminders({ prospectId: p.id, reminders: p.reminders || [] });
  const showMeta = hasRowMeta(p);

  return (
    <div className="px-3 py-2">
      {/* Line 1 — identity (left) · invoice / Set reminder / Note (right) */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[15px] font-medium text-gray-900 truncate max-w-[260px]" title={p.sm8_client_name}>
          {p.sm8_client_name}
        </span>
        {p.sm8_job_number && (
          <span className="shrink-0 text-[11px] text-gray-400 font-mono">#{p.sm8_job_number}</span>
        )}
        <span
          className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full"
          style={{ backgroundColor: stageStyle.bg, color: stageStyle.text }}
        >
          {stageStyle.label}
        </span>
        {crew && (
          <span
            className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white"
            style={{ backgroundColor: crew.bg }}
          >
            {crew.label}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <PossibleStartEditor prospectId={p.id} value={p.possible_start_date} />
          {invoice && <InvoiceBadge invoice={invoice} division="hardscape" />}
          <ReminderAddTrigger rm={rm} />
          <NoteAddTrigger nt={nt} />
        </div>
      </div>

      {/* Line 2 — address first · Design # | latest note · View all */}
      <div className="flex items-center gap-x-1 gap-y-0.5 flex-wrap text-[10px] text-gray-400 mt-[5px] min-w-0">
        <RowMeta p={p} />
        {showMeta && <span className="text-gray-300">|</span>}
        <NotePreview nt={nt} />
      </div>

      {/* Line 3 — open reminder chips only (omitted when none) */}
      {rm.items.length > 0 && (
        <div className="mt-[5px]">
          <ReminderChips rm={rm} />
        </div>
      )}

      {/* Transient: reminder form + note thread/input */}
      <ReminderForm rm={rm} />
      <NoteExpansion nt={nt} />
    </div>
  );
}

export default function PipelineTab({ prospects, loading }) {
  const [search, setSearch] = useState('');
  const [crewFilter, setCrewFilter] = useState('all');
  const [invoiceFilter, setInvoiceFilter] = useState('all');

  // Pipeline = quote_accepted only, flat list. Duplicates live in Archive.
  const filtered = prospects
    .filter((p) => p.stage === 'quote_accepted' && !p.is_duplicate)
    .filter((p) => {
      if (search && !p.sm8_client_name.toLowerCase().includes(search.toLowerCase())) return false;
      if (crewFilter === 'hp1' && p.crew_assignment !== 'hp1') return false;
      if (crewFilter === 'hp2' && p.crew_assignment !== 'hp2') return false;
      if (crewFilter === 'unassigned' && p.crew_assignment) return false;
      if (invoiceFilter !== 'all') {
        const st = p.invoice_status || 'not_invoiced';
        if (st !== invoiceFilter) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  const hasAny = filtered.length > 0;

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients..."
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-blue-500 w-48"
        />

        <div className="flex rounded-lg overflow-hidden border border-gray-200">
          {CREW_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setCrewFilter(f.key)}
              className={`px-3 py-1.5 text-xs font-medium ${
                crewFilter === f.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex rounded-lg overflow-hidden border border-gray-200">
          {INVOICE_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setInvoiceFilter(f.key)}
              className={`px-3 py-1.5 text-xs font-medium ${
                invoiceFilter === f.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-blue-600 border-t-transparent" />
        </div>
      )}

      {/* Empty state */}
      {!loading && !hasAny && (
        <div className="text-center text-gray-400 text-sm py-12">
          No accepted quotes. Jobs appear here when their status is set to “Quote accepted”.
        </div>
      )}

      {/* Flat list — quote_accepted only */}
      {!loading && hasAny && (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
          {filtered.map((p) => (
            <PipelineRow key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}
