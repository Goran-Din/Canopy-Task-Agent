import { useState, useRef } from 'react';

export default function CommentField({ jobUuid, division, initialComment }) {
  const [comment, setComment] = useState(initialComment || '');
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const textareaRef = useRef(null);

  const handleExpand = () => {
    setExpanded(true);
    setError(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleBlur = async () => {
    const trimmed = comment.trim();
    // If unchanged from initial, just collapse
    if (trimmed === (initialComment || '').trim()) {
      setExpanded(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/comment/${jobUuid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ comment_text: trimmed, division }),
      });
      if (!res.ok) throw new Error('Save failed');
      setExpanded(false);
    } catch {
      setError('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!expanded) {
    return (
      <div
        onClick={handleExpand}
        className="mt-1 cursor-pointer rounded px-2 py-1.5 text-xs"
        style={{ backgroundColor: '#F9FAFB', color: comment ? '#374151' : '#9CA3AF' }}
      >
        {comment
          ? comment.length > 60 ? comment.slice(0, 60) + '...' : comment
          : 'Add a note for this job...'}
      </div>
    );
  }

  return (
    <div className="mt-1 relative">
      <textarea
        ref={textareaRef}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onBlur={handleBlur}
        disabled={saving}
        className="w-full rounded border-none px-2 py-1.5 text-xs resize-none outline-none"
        style={{
          backgroundColor: '#F9FAFB',
          maxHeight: '100px',
          overflowY: 'auto',
          minHeight: '48px',
        }}
        placeholder="Add a note for this job..."
      />
      {saving && (
        <span className="absolute right-2 top-1.5 text-xs text-gray-400">Saving...</span>
      )}
      {error && (
        <span className="text-xs" style={{ color: '#DC2626' }}>{error}</span>
      )}
    </div>
  );
}
