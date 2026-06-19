import { useState } from 'react';

// Shared note logic + presentational pieces for the Pipeline and Crew Calendar
// rows. The pieces are split (preview, add-trigger, expansion) so a row can put
// the "+ Note" button on one line and the latest-note preview on another while
// sharing one thread state via the useNoteThread hook.
function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
}

// One thread per prospect: latest note inline, full thread loaded on demand
// (newest first), and adding a note that appears immediately.
export function useNoteThread({ prospectId, latestComment, commentCount = 0 }) {
  const [thread, setThread] = useState(null); // newest-first array once loaded
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);

  const latest = thread && thread.length ? thread[0].content : (latestComment || null);
  const count = thread ? thread.length : commentCount;

  const loadThread = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/dashboard/prospects/${prospectId}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setThread((data.comments || []).slice().reverse()); // newest first
      }
    } catch (err) {
      console.error('Load thread error:', err);
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = async () => {
    if (!expanded && thread === null) await loadThread();
    setExpanded((v) => !v);
  };

  const openNote = () => setNoteOpen(true);
  const closeNote = () => { setNoteOpen(false); setNoteText(''); };

  const saveNote = async () => {
    const content = noteText.trim();
    if (!content) return;
    setSaving(true);
    try {
      const res = await fetch(`/dashboard/prospects/${prospectId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content, author: 'Team' }),
      });
      if (!res.ok) throw new Error('Add note failed');
      await loadThread();   // refresh thread (newest first), includes the new note
      setNoteText('');
      setNoteOpen(false);
      setExpanded(true);    // reveal it right away
    } catch (err) {
      console.error('Add note error:', err);
    } finally {
      setSaving(false);
    }
  };

  return {
    latest, count, expanded, toggleExpand, thread, loading,
    noteOpen, openNote, closeNote, noteText, setNoteText, saveNote, saving,
  };
}

// Latest note (italic, muted, truncated) + a "View all N notes" link when the
// thread has more than one entry. Renders inline so it can sit on a meta line.
export function NotePreview({ nt }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className="text-gray-300 shrink-0">💬</span>
      {nt.latest
        ? <span className="italic text-gray-500 truncate">{nt.latest}</span>
        : <span className="italic text-gray-300 shrink-0">No notes yet</span>}
      {nt.count > 1 && (
        <button
          onClick={nt.toggleExpand}
          className="text-[10px] text-blue-600 hover:text-blue-800 shrink-0"
        >
          {nt.expanded ? 'Hide notes' : `View all ${nt.count} notes`}
        </button>
      )}
    </span>
  );
}

// The "+ Note" trigger button (hidden while the input is open).
export function NoteAddTrigger({ nt, disabled }) {
  if (nt.noteOpen) return null;
  return (
    <button
      onClick={nt.openNote}
      disabled={disabled}
      className="text-[10px] font-medium border border-gray-200 text-gray-600 px-2 py-1 rounded hover:bg-gray-50 disabled:opacity-50"
    >
      + Note
    </button>
  );
}

// Transient block placed below the row: the expanded thread and the add-note
// input. Renders nothing when neither is active.
export function NoteExpansion({ nt }) {
  if (!nt.expanded && !nt.noteOpen) return null;
  return (
    <div className="mt-1" onClick={(e) => e.stopPropagation()}>
      {nt.expanded && (
        <div className="mb-1 border-l-2 border-gray-100 pl-2 space-y-1 max-h-48 overflow-y-auto">
          {nt.loading && <div className="text-[10px] text-gray-400">Loading…</div>}
          {!nt.loading && nt.thread && nt.thread.map((c, i) => (
            <div key={c.id || i} className="text-[11px] text-gray-600">
              <span className="text-gray-400 mr-1">[{shortDate(c.activity_date)}]</span>
              {c.content}
            </div>
          ))}
        </div>
      )}

      {nt.noteOpen && (
        <div className="flex items-start gap-2">
          <textarea
            value={nt.noteText}
            onChange={(e) => nt.setNoteText(e.target.value)}
            placeholder="Add a progress note…"
            rows={2}
            className="flex-1 text-[11px] border border-gray-200 rounded px-2 py-1.5 outline-none focus:border-teal-500 resize-none"
          />
          <div className="flex flex-col gap-1">
            <button
              onClick={nt.saveNote}
              disabled={nt.saving || !nt.noteText.trim()}
              className="text-[10px] font-medium bg-teal-600 text-white px-2 py-1 rounded hover:bg-teal-700 disabled:opacity-50"
            >
              {nt.saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={nt.closeNote}
              className="text-[10px] font-medium border border-gray-200 text-gray-600 px-2 py-1 rounded hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
