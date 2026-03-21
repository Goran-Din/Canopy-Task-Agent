import { useState, useEffect, useCallback } from 'react';
import InvoiceBadge from './InvoiceBadge';

const OUTCOME_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'completed', label: 'Completed' },
  { key: 'closed_lost', label: 'Closed / Lost' },
];

const CREW_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'hp1', label: 'HP#1' },
  { key: 'hp2', label: 'HP#2' },
];

const CREW_LABELS = { hp1: 'HP#1', hp2: 'HP#2' };

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ArchiveTab() {
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [outcome, setOutcome] = useState('all');
  const [crew, setCrew] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [reopening, setReopening] = useState(false);

  const fetchArchive = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (outcome !== 'all') params.set('outcome', outcome);
      if (crew !== 'all') params.set('crew', crew);
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (search) params.set('search', search);

      const qs = params.toString();
      const res = await fetch(`/dashboard/archive${qs ? '?' + qs : ''}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch archive');
      const data = await res.json();
      setProspects(data.prospects || []);
    } catch (err) {
      console.error('Archive fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [outcome, crew, dateFrom, dateTo, search]);

  useEffect(() => {
    fetchArchive();
  }, [fetchArchive]);

  const handleReopen = async (id) => {
    setReopening(true);
    try {
      const res = await fetch(`/dashboard/prospects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ stage: 'in_progress' }),
      });
      if (!res.ok) throw new Error('Failed to reopen');
      setSelected(null);
      fetchArchive();
    } catch (err) {
      console.error('Reopen error:', err);
    } finally {
      setReopening(false);
    }
  };

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 mb-4 items-end">
        <div className="flex rounded-lg overflow-hidden border border-gray-200">
          {OUTCOME_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setOutcome(f.key)}
              className={`px-3 py-1.5 text-xs font-medium ${
                outcome === f.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex rounded-lg overflow-hidden border border-gray-200">
          {CREW_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setCrew(f.key)}
              className={`px-3 py-1.5 text-xs font-medium ${
                crew === f.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-blue-500"
          placeholder="From"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-blue-500"
          placeholder="To"
        />

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients..."
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-blue-500 w-48"
        />
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-blue-600 border-t-transparent" />
        </div>
      )}

      {/* Empty */}
      {!loading && prospects.length === 0 && (
        <div className="text-center text-gray-400 text-sm py-12">
          No archived prospects match the current filters.
        </div>
      )}

      {/* Table */}
      {!loading && prospects.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-100">
                <th className="pb-2 pr-4 font-medium">Client</th>
                <th className="pb-2 pr-4 font-medium">Job #</th>
                <th className="pb-2 pr-4 font-medium">Outcome</th>
                <th className="pb-2 pr-4 font-medium">Crew</th>
                <th className="pb-2 pr-4 font-medium">Closed</th>
                <th className="pb-2 pr-4 font-medium">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {prospects.map((p) => {
                const isSelected = selected?.id === p.id;
                const invoice = p.invoice_status
                  ? {
                      status: p.invoice_status,
                      invoice_number: p.invoice_number,
                      invoice_amount: p.invoice_amount ? parseFloat(p.invoice_amount) : null,
                      due_date: p.invoice_due_date ? String(p.invoice_due_date).split('T')[0] : null,
                      paid_date: p.invoice_paid_date ? String(p.invoice_paid_date).split('T')[0] : null,
                    }
                  : null;

                return (
                  <tr
                    key={p.id}
                    onClick={() => setSelected(isSelected ? null : p)}
                    className={`border-b border-gray-50 cursor-pointer hover:bg-gray-50 ${
                      isSelected ? 'bg-blue-50' : ''
                    }`}
                  >
                    <td className="py-2 pr-4 font-medium text-gray-900">{p.sm8_client_name}</td>
                    <td className="py-2 pr-4 font-mono text-gray-500">
                      {p.sm8_job_number ? `#${p.sm8_job_number}` : '—'}
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={`px-2 py-0.5 rounded-full font-semibold ${
                          p.stage === 'completed'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-600'
                        }`}
                      >
                        {p.stage === 'completed' ? 'Completed' : 'Closed / Lost'}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-600">
                      {CREW_LABELS[p.crew_assignment] || 'Unassigned'}
                    </td>
                    <td className="py-2 pr-4 text-gray-500">{formatDate(p.updated_at)}</td>
                    <td className="py-2 pr-4">
                      <InvoiceBadge invoice={invoice} division="hardscape" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div className="mt-4 bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex justify-between items-start mb-3">
            <div>
              <div className="font-bold text-base text-gray-900">{selected.sm8_client_name}</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {selected.assigned_to_name || 'Unassigned'} · Closed {formatDate(selected.updated_at)}
              </div>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-gray-400 hover:text-gray-600 text-lg leading-none"
            >
              ×
            </button>
          </div>

          {selected.notes && (
            <div className="text-xs text-gray-500 mb-3">{selected.notes}</div>
          )}

          {selected.client_folder_url && (
            <a
              href={selected.client_folder_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs text-blue-600 hover:text-blue-800 mb-3"
            >
              Open Client Folder
            </a>
          )}

          <button
            onClick={() => handleReopen(selected.id)}
            disabled={reopening}
            className="block mt-2 px-4 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {reopening ? 'Reopening...' : 'Reopen as In Progress'}
          </button>
        </div>
      )}
    </div>
  );
}
