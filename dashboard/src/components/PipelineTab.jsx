import { useState } from 'react';
import ProspectCard from './ProspectCard';

const STAGE_ORDER = [
  'initial_contact', 'site_visit', 'quote_sent', 'revision_requested',
  'visual_rendering', 'final_quote', 'deposit_invoice', 'scheduled', 'in_progress',
];

const STAGE_LABELS = {
  initial_contact: 'Initial Contact',
  site_visit: 'Site Visit',
  quote_sent: 'Quote Sent',
  revision_requested: 'Revision Requested',
  visual_rendering: 'Visual Rendering',
  final_quote: 'Final Quote',
  deposit_invoice: 'Deposit Invoice',
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
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

export default function PipelineTab({ prospects, loading }) {
  const [search, setSearch] = useState('');
  const [crewFilter, setCrewFilter] = useState('all');
  const [invoiceFilter, setInvoiceFilter] = useState('all');
  const [collapsed, setCollapsed] = useState({});

  const toggleCollapse = (stage) => {
    setCollapsed((prev) => ({ ...prev, [stage]: !prev[stage] }));
  };

  // Apply filters
  const filtered = prospects.filter((p) => {
    if (search && !p.sm8_client_name.toLowerCase().includes(search.toLowerCase())) return false;
    if (crewFilter === 'hp1' && p.crew_assignment !== 'hp1') return false;
    if (crewFilter === 'hp2' && p.crew_assignment !== 'hp2') return false;
    if (crewFilter === 'unassigned' && p.crew_assignment) return false;
    if (invoiceFilter !== 'all') {
      const st = p.invoice_status || 'not_invoiced';
      if (st !== invoiceFilter) return false;
    }
    return true;
  });

  // Group by stage
  const grouped = {};
  for (const p of filtered) {
    if (!grouped[p.stage]) grouped[p.stage] = [];
    grouped[p.stage].push(p);
  }

  // Sort within each group by updated_at DESC
  for (const stage of Object.keys(grouped)) {
    grouped[stage].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }

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
          No active prospects. Use Telegram to add one.
        </div>
      )}

      {/* Stage sections */}
      {!loading && STAGE_ORDER.map((stage) => {
        const items = grouped[stage];
        if (!items || items.length === 0) return null;
        const isCollapsed = collapsed[stage];

        return (
          <div key={stage} className="mb-4">
            <button
              onClick={() => toggleCollapse(stage)}
              className="flex items-center gap-2 w-full text-left mb-2"
            >
              <span className="text-xs text-gray-400">{isCollapsed ? '▸' : '▾'}</span>
              <span className="text-sm font-semibold text-gray-700">
                {STAGE_LABELS[stage]}
              </span>
              <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                {items.length}
              </span>
            </button>
            {!isCollapsed && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {items.map((p) => (
                  <ProspectCard key={p.id} prospect={p} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
