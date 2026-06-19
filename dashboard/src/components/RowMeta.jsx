// Shared meta cluster for Pipeline and Crew Calendar rows, rendered inline on
// line 2 so it can sit ahead of the note preview / work dates. Address FIRST
// (directly under the client name), then "· Design #N", then a folder link.
// Job # is shown as a pill on line 1, so it is not repeated here. Each item
// renders only when present; the folder link prefers client_folder_url and
// falls back to gdrive_url.
export function hasRowMeta(p) {
  return !!(p.job_address || p.design_number || p.client_folder_url || p.gdrive_url);
}

export default function RowMeta({ p }) {
  const folderUrl = p.client_folder_url || p.gdrive_url;
  const parts = [];

  if (p.job_address) {
    parts.push(
      <span key="addr" className="truncate max-w-[280px]" title={p.job_address}>
        📍 {p.job_address}
      </span>
    );
  }
  if (p.design_number) {
    parts.push(<span key="design" className="shrink-0">Design #{p.design_number}</span>);
  }
  if (folderUrl) {
    parts.push(
      <a
        key="gdrive"
        href={folderUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-blue-600 hover:text-blue-800 shrink-0"
      >
        📁 {p.gdrive_label || 'GDrive'}
      </a>
    );
  }

  if (parts.length === 0) return null;

  return (
    <>
      {parts.map((el, i) => (
        <span key={i} className="inline-flex items-center min-w-0">
          {i > 0 && <span className="mx-1 text-gray-300">·</span>}
          {el}
        </span>
      ))}
    </>
  );
}
