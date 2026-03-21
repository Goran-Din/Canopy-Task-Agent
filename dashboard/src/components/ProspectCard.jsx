import InvoiceBadge from './InvoiceBadge';
import CommentField from './CommentField';

const STAGE_STYLES = {
  initial_contact:      { bg: '#F3F4F6', text: '#6B7280', label: 'Initial Contact' },
  site_visit:           { bg: '#DBEAFE', text: '#1D4ED8', label: 'Site Visit' },
  quote_sent:           { bg: '#FEF3C7', text: '#D97706', label: 'Quote Sent' },
  revision_requested:   { bg: '#FEE2E2', text: '#DC2626', label: 'Revision Requested' },
  visual_rendering:     { bg: '#EDE9FE', text: '#7C3AED', label: 'Visual Rendering' },
  final_quote:          { bg: '#ECFDF5', text: '#059669', label: 'Final Quote' },
  deposit_invoice:      { bg: '#FFF7ED', text: '#EA580C', label: 'Deposit Invoice' },
  scheduled:            { bg: '#D1FAE5', text: '#065F46', label: 'Scheduled' },
  in_progress:          { bg: '#CFFAFE', text: '#0E7490', label: 'In Progress' },
};

const CREW_STYLES = {
  hp1: { bg: '#6B7280', text: '#FFFFFF', label: 'HP#1' },
  hp2: { bg: '#92400E', text: '#FFFFFF', label: 'HP#2' },
};

const CREW_BORDER = {
  hp1: '#6B7280',
  hp2: '#92400E',
};

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const then = new Date(dateStr);
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ProspectCard({ prospect }) {
  const stageStyle = STAGE_STYLES[prospect.stage] || STAGE_STYLES.initial_contact;
  const crewStyle = prospect.crew_assignment
    ? CREW_STYLES[prospect.crew_assignment]
    : { bg: '#F3F4F6', text: '#6B7280', label: 'Unassigned' };
  const borderColor = CREW_BORDER[prospect.crew_assignment] || '#E5E7EB';

  const invoice = prospect.invoice_status
    ? {
        status: prospect.invoice_status,
        invoice_number: prospect.invoice_number,
        invoice_amount: prospect.invoice_amount ? parseFloat(prospect.invoice_amount) : null,
        due_date: prospect.invoice_due_date ? String(prospect.invoice_due_date).split('T')[0] : null,
        paid_date: prospect.invoice_paid_date ? String(prospect.invoice_paid_date).split('T')[0] : null,
      }
    : null;

  return (
    <div
      className="bg-white rounded-lg shadow-sm mb-3 overflow-hidden"
      style={{ borderLeft: `4px solid ${borderColor}` }}
    >
      <div className="p-3">
        {/* Top row: client name + job number */}
        <div className="flex justify-between items-start gap-2">
          <div className="font-bold text-base text-gray-900 leading-tight">
            {prospect.sm8_client_name}
          </div>
          {prospect.sm8_job_number && (
            <span className="shrink-0 text-xs font-mono bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
              #{prospect.sm8_job_number}
            </span>
          )}
        </div>

        {/* Row 2: salesperson + relative time */}
        <div className="flex justify-between items-center text-xs text-gray-400 mt-1">
          <span>{prospect.assigned_to_name || 'Unassigned'}</span>
          <span>{timeAgo(prospect.updated_at)}</span>
        </div>

        {/* Row 3: stage badge + crew badge */}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <span
            className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ backgroundColor: stageStyle.bg, color: stageStyle.text }}
          >
            {stageStyle.label}
          </span>
          <span
            className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ backgroundColor: crewStyle.bg, color: crewStyle.text }}
          >
            {crewStyle.label}
          </span>
        </div>

        {/* Row 4: schedule info */}
        {prospect.scheduled_start && (
          <div className="text-xs text-gray-500 mt-2">
            📅 Starts {formatDate(prospect.scheduled_start)}
            {prospect.estimated_crew_days ? ` · ${prospect.estimated_crew_days} day${prospect.estimated_crew_days > 1 ? 's' : ''} est.` : ''}
          </div>
        )}

        {/* Row 5: client folder link */}
        {prospect.client_folder_url && (
          <a
            href={prospect.client_folder_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs text-blue-600 hover:text-blue-800 mt-1.5"
          >
            📁 Client Folder
          </a>
        )}

        {/* Row 6: notes preview */}
        {prospect.notes && (
          <div className="text-xs text-gray-400 italic mt-1.5">
            {prospect.notes.length > 80
              ? prospect.notes.slice(0, 80) + '...'
              : prospect.notes}
          </div>
        )}

        {/* Row 7: comment count */}
        {prospect.comment_count > 0 && (
          <div className="mt-1.5">
            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
              💬 {prospect.comment_count} note{prospect.comment_count !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* Row 8: Invoice badge */}
        <InvoiceBadge invoice={invoice} division="hardscape" />

        {/* Row 9: Comment field */}
        {prospect.sm8_job_uuid && (
          <CommentField
            jobUuid={prospect.sm8_job_uuid}
            division="hardscape"
            initialComment={prospect.job_comment || prospect.comment}
          />
        )}
      </div>
    </div>
  );
}
