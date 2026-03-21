import JobCard from './JobCard';

function crewLabel(crewId) {
  const num = crewId.replace('lp', '');
  return `LP#${num}`;
}

export default function CrewColumn({ crew }) {
  return (
    <div className="flex flex-col min-w-0">
      {/* Header */}
      <div
        className="rounded-t-lg px-4 py-3 flex justify-between items-center"
        style={{ backgroundColor: crew.color }}
      >
        <span className="text-white font-bold text-sm">
          {crewLabel(crew.crew_id)} {crew.lead_name}
        </span>
        <span className="text-white/90 text-xs font-medium">
          {crew.total_hours} hrs
        </span>
      </div>

      {/* Open time warning */}
      {crew.has_open_time && (
        <div className="bg-amber-50 text-amber-700 text-xs font-medium px-4 py-1.5 flex items-center gap-1">
          <span>&#9888;&#65039;</span> {crew.open_hours} hrs open
        </div>
      )}

      {/* Job list */}
      <div className="bg-gray-50 rounded-b-lg p-3 flex-1 min-h-[100px]">
        {crew.jobs.length > 0 ? (
          crew.jobs.map((job) => (
            <JobCard key={job.job_uuid} job={job} crewColor={crew.color} />
          ))
        ) : (
          <div className="text-gray-400 italic text-sm text-center py-8">
            No jobs scheduled
          </div>
        )}
      </div>
    </div>
  );
}
