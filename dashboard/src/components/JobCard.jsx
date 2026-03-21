import InvoiceBadge from './InvoiceBadge';
import CommentField from './CommentField';

const STATUS_COLORS = {
  scheduled: '#2563EB',
  in_progress: '#059669',
  completed: '#9CA3AF',
};

function formatTime(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    });
  } catch {
    return dateStr;
  }
}

export default function JobCard({ job, crewColor }) {
  const statusColor = STATUS_COLORS[job.status] || STATUS_COLORS.scheduled;

  return (
    <div
      className="bg-white rounded-lg shadow-sm mb-3 overflow-hidden"
      style={{ borderLeft: `4px solid ${crewColor}` }}
    >
      <div className="p-3">
        {/* Top row: job number + time */}
        <div className="flex justify-between items-center text-xs text-gray-500 mb-1">
          <span className="font-mono font-medium">#{job.job_number}</span>
          <span>{formatTime(job.scheduled_start)}</span>
        </div>

        {/* Client name */}
        <div className="font-bold text-base text-gray-900 leading-tight">
          {job.client_name}
        </div>

        {/* Address */}
        {job.address && (
          <div className="text-xs text-gray-400 mt-0.5">{job.address}</div>
        )}

        {/* Description */}
        {job.description && (
          <div className="text-xs text-gray-400 italic mt-1">
            {job.description.length > 40
              ? job.description.slice(0, 40) + '...'
              : job.description}
          </div>
        )}

        {/* Hours badge + employees */}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <span
            className="text-white text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ backgroundColor: '#2563EB' }}
          >
            {job.estimated_hours} hrs
          </span>

          <div className="flex flex-wrap gap-1 text-xs text-gray-600">
            {job.employees && job.employees.length > 0 ? (
              job.employees.map((emp, i) => (
                <span key={emp.uuid || i}>
                  {emp.is_lead ? (
                    <strong>{emp.name}</strong>
                  ) : emp.name === 'Unknown' ? (
                    <span style={{ color: '#DC2626' }}>Member TBD</span>
                  ) : (
                    emp.name
                  )}
                  {i < job.employees.length - 1 && ','}
                </span>
              ))
            ) : (
              <span style={{ color: '#DC2626' }}>Member TBD</span>
            )}
          </div>
        </div>

        {/* Status bar */}
        <div
          className="h-1 rounded-full mt-2"
          style={{ backgroundColor: statusColor }}
        />

        {/* Invoice badge */}
        <InvoiceBadge invoice={job.invoice} division="landscape_project" />

        {/* Comment field */}
        <CommentField
          jobUuid={job.job_uuid}
          division="landscape_project"
          initialComment={job.comment}
        />
      </div>
    </div>
  );
}
