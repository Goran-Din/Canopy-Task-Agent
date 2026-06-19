import { useState } from 'react';

// Follow-up reminders for a prospect row, split into a hook + pieces so the row
// can put the "+ Set reminder" trigger on line 1 and the chips on line 3.
// Open reminders are chips (due date + note, date red when overdue, a "done"
// control); the form adds a new one and it appears immediately; several stack.
// State is local after mount so adds/dones reflect at once.
function todayCT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function shortDate(ymd) {
  if (!ymd) return '';
  const d = new Date(String(ymd).split('T')[0] + 'T12:00:00');
  if (isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function sortByDue(list) {
  return [...list].sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
}

export function useReminders({ prospectId, reminders = [] }) {
  const [items, setItems] = useState(() => sortByDue(reminders));
  const [adding, setAdding] = useState(false);
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const today = todayCT();

  const openAdd = () => setAdding(true);
  const closeAdd = () => { setAdding(false); setDue(''); setNote(''); };

  const addReminder = async () => {
    const d = due;
    const n = note.trim();
    if (!d || !n) return;
    setSaving(true);
    try {
      const res = await fetch(`/dashboard/prospects/${prospectId}/reminders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ due_date: d, note: n }),
      });
      if (!res.ok) throw new Error('Create reminder failed');
      const data = await res.json();
      setItems((prev) => sortByDue([...prev, data.reminder]));
      setDue(''); setNote(''); setAdding(false);
    } catch (err) {
      console.error('Add reminder error:', err);
    } finally {
      setSaving(false);
    }
  };

  const markDone = async (id) => {
    setBusyId(id);
    try {
      const res = await fetch(`/dashboard/reminders/${id}/done`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Mark done failed');
      setItems((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      console.error('Reminder done error:', err);
    } finally {
      setBusyId(null);
    }
  };

  return { items, today, adding, openAdd, closeAdd, due, setDue, note, setNote, saving, addReminder, busyId, markDone };
}

// Open reminder chips. Returns null when there are none (so the row can omit
// the whole line and drop to two lines).
export function ReminderChips({ rm }) {
  if (rm.items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
      {rm.items.map((r) => {
        const overdue = String(r.due_date) < rm.today;
        return (
          <span
            key={r.id}
            className="inline-flex items-center gap-1 text-[10px] rounded-full border px-2 py-0.5"
            style={{ borderColor: overdue ? '#FCA5A5' : '#E5E7EB', backgroundColor: overdue ? '#FEF2F2' : '#fff' }}
          >
            <span className="font-semibold" style={{ color: overdue ? '#DC2626' : '#6B7280' }}>
              🔔 {shortDate(r.due_date)}
            </span>
            <span className="text-gray-600">{r.note}</span>
            <button
              onClick={() => rm.markDone(r.id)}
              disabled={rm.busyId === r.id}
              title="Mark reminder done"
              className="text-gray-400 hover:text-green-600 disabled:opacity-50"
            >
              ✓
            </button>
          </span>
        );
      })}
    </div>
  );
}

// The "+ Set reminder" trigger (hidden while the form is open).
export function ReminderAddTrigger({ rm }) {
  if (rm.adding) return null;
  return (
    <button
      onClick={rm.openAdd}
      className="text-[10px] font-medium border border-gray-200 text-gray-600 px-2 py-1 rounded hover:bg-gray-50"
    >
      + Set reminder
    </button>
  );
}

// Transient date+text form, placed below the row.
export function ReminderForm({ rm }) {
  if (!rm.adding) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-1" onClick={(e) => e.stopPropagation()}>
      <input
        type="date"
        value={rm.due}
        min={rm.today}
        onChange={(e) => rm.setDue(e.target.value)}
        className="text-[10px] border border-gray-200 rounded px-1.5 py-1 outline-none focus:border-teal-500"
      />
      <input
        type="text"
        value={rm.note}
        onChange={(e) => rm.setNote(e.target.value)}
        placeholder="Reminder note…"
        className="text-[10px] border border-gray-200 rounded px-1.5 py-1 outline-none focus:border-teal-500 w-44"
      />
      <button
        onClick={rm.addReminder}
        disabled={rm.saving || !rm.due || !rm.note.trim()}
        className="text-[10px] font-medium bg-teal-600 text-white px-2 py-1 rounded hover:bg-teal-700 disabled:opacity-50"
      >
        {rm.saving ? 'Saving…' : 'Add'}
      </button>
      <button
        onClick={rm.closeAdd}
        className="text-[10px] font-medium border border-gray-200 text-gray-600 px-2 py-1 rounded hover:bg-gray-50"
      >
        Cancel
      </button>
    </div>
  );
}
