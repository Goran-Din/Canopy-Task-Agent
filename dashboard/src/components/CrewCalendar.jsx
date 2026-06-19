import { useState, useEffect, useCallback, useRef } from 'react';
import RowMeta, { hasRowMeta } from './RowMeta';
import { useNoteThread, NotePreview, NoteAddTrigger, NoteExpansion } from './NoteThread';

const CREW_META = {
  hp1: { label: 'HP#1 Rigo Tello', color: '#6B7280' },
  hp2: { label: 'HP#2 Daniel Tello', color: '#92400E' },
};

const STATUS_COLORS = {
  scheduled: '#3B82F6',
  in_progress: '#10B981',
  delayed: '#F59E0B',
};

function toDateStr(d) {
  return d.toISOString().split('T')[0];
}

// Today's date as 'YYYY-MM-DD' in US Central, so "today" / "start of week"
// don't drift against the viewer's local clock near midnight. 'en-CA' → ISO order.
function todayInBusinessTz() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Accept a date-only string ('2026-06-17') or a full ISO timestamp
// ('2026-06-17T07:00:00.000Z') and return just the 'YYYY-MM-DD' portion.
function dateOnly(dateStr) {
  if (!dateStr) return '';
  return String(dateStr).split('T')[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateOnly(dateStr) + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function daysBetween(a, b) {
  const da = new Date(dateOnly(a) + 'T12:00:00');
  const db = new Date(dateOnly(b) + 'T12:00:00');
  return Math.round((db - da) / 86400000);
}

// Beginning of the week (Sunday) containing dateStr.
function startOfWeek(dateStr) {
  const d = new Date(dateOnly(dateStr) + 'T12:00:00');
  d.setDate(d.getDate() - d.getDay());
  return toDateStr(d);
}

// Larger (later) of two YYYY-MM-DD strings.
function maxDateStr(a, b) {
  return a > b ? a : b;
}

const PAUSE_OUTLINE = '#F59E0B'; // amber

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Timeline band styling driven by job status:
//   in_progress → solid crew color
//   paused      → crew color + diagonal stripe + amber outline (visually distinct)
//   scheduled   → lighter crew color (default)
function bandStyleForStatus(crewColor, status) {
  if (status === 'paused') {
    return {
      backgroundColor: crewColor,
      backgroundImage:
        'repeating-linear-gradient(45deg, rgba(255,255,255,0.30) 0, rgba(255,255,255,0.30) 4px, transparent 4px, transparent 9px)',
      outline: `2px solid ${PAUSE_OUTLINE}`,
      outlineOffset: '-2px',
    };
  }
  if (status === 'in_progress') {
    return { backgroundColor: crewColor };
  }
  return { backgroundColor: hexToRgba(crewColor, 0.55) }; // scheduled — lighter
}

function formatDateShort(dateStr) {
  const d = new Date(dateOnly(dateStr) + 'T12:00:00');
  if (isNaN(d.getTime())) return 'Not scheduled';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateFull(dateStr) {
  const d = new Date(dateOnly(dateStr) + 'T12:00:00');
  if (isNaN(d.getTime())) return 'Not scheduled';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  return day === 0 || day === 6;
}

function getMonthLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function getDayNum(dateStr) {
  return new Date(dateStr + 'T12:00:00').getDate();
}

function getDayName(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
}

// ---------------------------------------------------------------------------
// MAIN COMPONENT
// ---------------------------------------------------------------------------

export default function CrewCalendar() {
  const [schedule, setSchedule] = useState([]);
  const [hp1Next, setHp1Next] = useState(null);
  const [hp2Next, setHp2Next] = useState(null);
  const [prospects, setProspects] = useState([]);
  const [completedJobs, setCompletedJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  // Job list below the timeline
  const [listView, setListView] = useState('active'); // 'active' | 'completed'
  const [completingId, setCompletingId] = useState(null);
  const [rowBusyId, setRowBusyId] = useState(null);

  // View state — window starts at the beginning of the current week and spans
  // ~8 weeks forward. Last week is never shown.
  const todayStr = todayInBusinessTz();
  const weekStart = startOfWeek(todayStr);
  const [viewStart, setViewStart] = useState(weekStart);
  const DAY_COUNT = 56;

  // Modals
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [delayPreview, setDelayPreview] = useState(null);
  const [delayEntryId, setDelayEntryId] = useState(null);
  const [delayDays, setDelayDays] = useState(0);
  const [delayReason, setDelayReason] = useState('');
  const [confirming, setConfirming] = useState(false);

  // Schedule form
  const [schedProspectId, setSchedProspectId] = useState('');
  const [schedCrew, setSchedCrew] = useState('hp1');
  const [schedStart, setSchedStart] = useState('');
  const [schedDays, setSchedDays] = useState(3);
  const [schedCrewSize, setSchedCrewSize] = useState(2);
  const [schedCrewMembers, setSchedCrewMembers] = useState('');
  const [scheduling, setScheduling] = useState(false);

  // Edit modal
  const [editJob, setEditJob] = useState(null);
  const [editCrew, setEditCrew] = useState('hp1');
  const [editStart, setEditStart] = useState('');
  const [editDays, setEditDays] = useState(3);
  const [editCrewSize, setEditCrewSize] = useState(2);
  const [editCrewMembers, setEditCrewMembers] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Tooltip
  const [hoveredJob, setHoveredJob] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const timelineRef = useRef(null);

  // Mobile detect
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Build days array
  const days = [];
  for (let i = 0; i < DAY_COUNT; i++) {
    days.push(addDays(viewStart, i));
  }

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [schedRes, hp1Res, hp2Res, prospRes, completedRes] = await Promise.all([
        fetch('/dashboard/crew-schedule', { credentials: 'include' }),
        fetch('/dashboard/crew-schedule/next-available?crew=hp1', { credentials: 'include' }),
        fetch('/dashboard/crew-schedule/next-available?crew=hp2', { credentials: 'include' }),
        fetch('/dashboard/prospects', { credentials: 'include' }),
        fetch('/dashboard/crew-schedule?status=completed', { credentials: 'include' }),
      ]);
      if (schedRes.ok) {
        const d = await schedRes.json();
        setSchedule(d.schedule || []);
      }
      if (hp1Res.ok) setHp1Next(await hp1Res.json());
      if (hp2Res.ok) setHp2Next(await hp2Res.json());
      if (prospRes.ok) {
        const d = await prospRes.json();
        setProspects(d.prospects || []);
      }
      if (completedRes.ok) {
        const d = await completedRes.json();
        setCompletedJobs(d.schedule || []);
      }
    } catch (err) {
      console.error('CrewCalendar fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 300000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Separate by crew
  const hp1Jobs = schedule
    .filter((e) => e.crew === 'hp1')
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const hp2Jobs = schedule
    .filter((e) => e.crew === 'hp2')
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  // Job list (below timeline): Active = scheduled + in_progress + paused, Completed = completed.
  const activeListJobs = schedule
    .filter((e) => e.status === 'scheduled' || e.status === 'in_progress' || e.status === 'paused')
    .sort((a, b) => dateOnly(a.start_date).localeCompare(dateOnly(b.start_date)));
  const completedListJobs = [...completedJobs]
    .sort((a, b) => dateOnly(a.start_date).localeCompare(dateOnly(b.start_date)));

  // -------------------------------------------------------------------------
  // Month navigation
  // -------------------------------------------------------------------------

  const viewMonth = getMonthLabel(viewStart);

  const prevMonth = () => {
    // Shift back 4 weeks, but never before the current week (no last week shown).
    const candidate = addDays(viewStart, -28);
    setViewStart(maxDateStr(weekStart, candidate));
  };

  const nextMonth = () => {
    setViewStart(addDays(viewStart, 28));
  };

  const goToday = () => setViewStart(weekStart);

  // -------------------------------------------------------------------------
  // Schedule Job modal helpers
  // -------------------------------------------------------------------------

  const scheduledProspectIds = new Set(schedule.map((e) => e.prospect_id));
  const eligibleProspects = prospects.filter(
    (p) =>
      ['quote_accepted', 'pending_permits', 'scheduled_for_work', 'work_in_progress'].includes(p.stage) &&
      (!p.crew_assignment || !scheduledProspectIds.has(p.id))
  );

  // Jobs in a production stage that should be on a crew but have no schedule
  // entry yet — surfaced so they aren't lost. (Auto-creating the entry on a
  // status change is Phase 3; here we just make them visible + schedulable.)
  const awaitingScheduling = prospects
    .filter(
      (p) =>
        ['pending_permits', 'scheduled_for_work', 'work_in_progress'].includes(p.stage) &&
        !scheduledProspectIds.has(p.id)
    )
    .sort((a, b) => (a.sm8_client_name || '').localeCompare(b.sm8_client_name || ''));

  const openScheduleModal = () => {
    const nextDate =
      schedCrew === 'hp1'
        ? hp1Next?.next_available_date || todayStr
        : hp2Next?.next_available_date || todayStr;
    setSchedStart(maxDateStr(todayStr, nextDate));
    setSchedProspectId(eligibleProspects.length > 0 ? String(eligibleProspects[0].id) : '');
    setSchedDays(3);
    setSchedCrewSize(2);
    setSchedCrewMembers('');
    setShowScheduleModal(true);
  };

  // Open the Schedule-Job modal pre-selected to a specific prospect (used by the
  // Awaiting-scheduling list). Default the firm Start Date to that prospect's
  // possible_start_date (the soft target) when set — floored at today so a stale
  // target never produces a past firm date — otherwise max(today, next-available).
  const openScheduleModalFor = (prospectId) => {
    const prospect = prospects.find((p) => p.id === prospectId);
    const possible = prospect?.possible_start_date ? dateOnly(prospect.possible_start_date) : '';
    const nextDate =
      schedCrew === 'hp1'
        ? hp1Next?.next_available_date || todayStr
        : hp2Next?.next_available_date || todayStr;
    const defaultStart = possible
      ? maxDateStr(todayStr, possible)
      : maxDateStr(todayStr, nextDate);
    setSchedStart(defaultStart);
    setSchedProspectId(String(prospectId));
    setSchedDays(3);
    setSchedCrewSize(2);
    setSchedCrewMembers('');
    setShowScheduleModal(true);
  };

  const handleCrewChange = (crew) => {
    setSchedCrew(crew);
    const nextDate =
      crew === 'hp1'
        ? hp1Next?.next_available_date || todayStr
        : hp2Next?.next_available_date || todayStr;
    setSchedStart(maxDateStr(todayStr, nextDate));
  };

  const handleScheduleSubmit = async () => {
    if (!schedProspectId || !schedStart || schedDays < 1) return;
    setScheduling(true);
    try {
      const res = await fetch('/dashboard/crew-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          prospect_id: Number(schedProspectId),
          crew: schedCrew,
          start_date: schedStart,
          estimated_days: schedDays,
          crew_size: schedCrewSize,
          crew_members: schedCrewMembers || null,
        }),
      });
      if (!res.ok) throw new Error('Schedule failed');
      setShowScheduleModal(false);
      fetchData();
    } catch (err) {
      console.error('Schedule error:', err);
    } finally {
      setScheduling(false);
    }
  };

  // -------------------------------------------------------------------------
  // Mark job completed
  // -------------------------------------------------------------------------

  const handleComplete = async (id) => {
    setCompletingId(id);
    try {
      const res = await fetch(`/dashboard/crew-schedule/${id}/complete`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Complete failed');
      await fetchData();
    } catch (err) {
      console.error('Complete error:', err);
    } finally {
      setCompletingId(null);
    }
  };

  // Change a job's progress status. 'completed' reuses the complete flow;
  // 'paused' prompts for a one-line reason. Scheduled/In Progress are direct.
  const handleStatusChange = async (job, newStatus) => {
    if (newStatus === job.status) return;
    if (newStatus === 'completed') {
      await handleComplete(job.id);
      return;
    }
    let reason;
    if (newStatus === 'paused') {
      reason = window.prompt('Reason for pausing (one line):');
      if (reason === null) return;            // cancelled
      if (!reason.trim()) return;             // empty — backend requires a reason
    }
    setRowBusyId(job.id);
    try {
      const res = await fetch(`/dashboard/crew-schedule/${job.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: newStatus, reason }),
      });
      if (!res.ok) throw new Error('Status change failed');
      await fetchData();
    } catch (err) {
      console.error('Status change error:', err);
    } finally {
      setRowBusyId(null);
    }
  };

  // Toggle a follow-up flag (needs_sealing / needs_landscape) on the prospect.
  const handleFlagToggle = async (job, flag) => {
    const newValue = !job[flag];
    setRowBusyId(job.id);
    try {
      const res = await fetch(`/dashboard/prospects/${job.prospect_id}/flags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ flag, value: newValue }),
      });
      if (!res.ok) throw new Error('Flag toggle failed');
      await fetchData();
    } catch (err) {
      console.error('Flag toggle error:', err);
    } finally {
      setRowBusyId(null);
    }
  };

  // -------------------------------------------------------------------------
  // Delay flow
  // -------------------------------------------------------------------------

  const handleDelayClick = async (entryId, numDays, e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    setHoveredJob(null);
    try {
      const res = await fetch(`/dashboard/crew-schedule/${entryId}/delay`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ days: numDays }),
      });
      if (!res.ok) throw new Error('Delay preview failed');
      const data = await res.json();
      setDelayPreview(data);
      setDelayEntryId(entryId);
      setDelayDays(numDays);
      setDelayReason('');
    } catch (err) {
      console.error('Delay preview error:', err);
    }
  };

  const handleDelayConfirm = async () => {
    setConfirming(true);
    try {
      const res = await fetch(`/dashboard/crew-schedule/${delayEntryId}/delay/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ days: delayDays, reason: delayReason || undefined }),
      });
      if (!res.ok) throw new Error('Delay confirm failed');
      setDelayPreview(null);
      setDelayEntryId(null);
      fetchData();
    } catch (err) {
      console.error('Delay confirm error:', err);
    } finally {
      setConfirming(false);
    }
  };

  // -------------------------------------------------------------------------
  // Edit job
  // -------------------------------------------------------------------------

  const openEditModal = (job) => {
    const startStr = typeof job.start_date === 'string'
      ? job.start_date.split('T')[0]
      : toDateStr(new Date(job.start_date));
    setEditJob(job);
    setEditCrew(job.crew);
    setEditStart(startStr);
    setEditDays(job.estimated_days || 3);
    setEditCrewSize(job.crew_size || 2);
    setEditCrewMembers(job.crew_members || '');
    setDeleteConfirm(false);
    setHoveredJob(null);
  };

  const handleEditSave = async () => {
    if (!editJob) return;
    setSaving(true);
    try {
      const res = await fetch(`/dashboard/crew-schedule/${editJob.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          crew: editCrew,
          start_date: editStart,
          estimated_days: editDays,
          crew_size: editCrewSize,
          crew_members: editCrewMembers || null,
        }),
      });
      if (!res.ok) throw new Error('Edit failed');
      setEditJob(null);
      fetchData();
    } catch (err) {
      console.error('Edit save error:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleEditDelete = async () => {
    if (!editJob) return;
    setSaving(true);
    try {
      const res = await fetch(`/dashboard/crew-schedule/${editJob.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Delete failed');
      setEditJob(null);
      setDeleteConfirm(false);
      fetchData();
    } catch (err) {
      console.error('Delete error:', err);
    } finally {
      setSaving(false);
    }
  };

  // -------------------------------------------------------------------------
  // Tooltip
  // -------------------------------------------------------------------------

  const handleJobHover = (job, e) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (rect) {
      setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top - 10 });
    }
    setHoveredJob(job);
  };

  const handleJobLeave = () => setHoveredJob(null);

  // -------------------------------------------------------------------------
  // RENDER — MOBILE LIST VIEW
  // -------------------------------------------------------------------------

  if (isMobile) {
    return (
      <div>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-semibold text-gray-700">Crew Calendar</div>
          <button
            onClick={openScheduleModal}
            className="px-3 py-1.5 text-xs font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700"
          >
            + Schedule Job
          </button>
        </div>

        {loading && (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-4 border-teal-600 border-t-transparent" />
          </div>
        )}

        {/* HP#1 */}
        {!loading && (
          <div className="mb-6">
            <div className="text-xs font-bold text-gray-600 mb-2" style={{ color: CREW_META.hp1.color }}>
              {CREW_META.hp1.label}
            </div>
            {hp1Jobs.length === 0 ? (
              <div className="text-xs text-green-600 mb-2">Available now</div>
            ) : (
              <>
                {hp1Next && (
                  <div className="text-xs text-green-600 mb-2">
                    Next available: {formatDateShort(hp1Next.next_available_date)}
                  </div>
                )}
                {hp1Jobs.map((job) => (
                  <MobileJobCard key={job.id} job={job} onDelay={handleDelayClick} onEdit={openEditModal} />
                ))}
              </>
            )}
          </div>
        )}

        {/* HP#2 */}
        {!loading && (
          <div className="mb-6">
            <div className="text-xs font-bold text-gray-600 mb-2" style={{ color: CREW_META.hp2.color }}>
              {CREW_META.hp2.label}
            </div>
            {hp2Jobs.length === 0 ? (
              <div className="text-xs text-green-600 mb-2">Available now</div>
            ) : (
              <>
                {hp2Next && (
                  <div className="text-xs text-green-600 mb-2">
                    Next available: {formatDateShort(hp2Next.next_available_date)}
                  </div>
                )}
                {hp2Jobs.map((job) => (
                  <MobileJobCard key={job.id} job={job} onDelay={handleDelayClick} onEdit={openEditModal} />
                ))}
              </>
            )}
          </div>
        )}

        {/* Job list */}
        {!loading && (
          <JobList
            activeJobs={activeListJobs}
            completedJobs={completedListJobs}
            listView={listView}
            setListView={setListView}
            onComplete={handleComplete}
            onStatusChange={handleStatusChange}
            onFlagToggle={handleFlagToggle}
            completingId={completingId}
            rowBusyId={rowBusyId}
          />
        )}

        {/* Awaiting scheduling */}
        {!loading && (
          <AwaitingScheduling items={awaitingScheduling} onSchedule={openScheduleModalFor} />
        )}

        {/* Modals */}
        {showScheduleModal && (
          <ScheduleModal
            eligibleProspects={eligibleProspects}
            schedProspectId={schedProspectId}
            setSchedProspectId={setSchedProspectId}
            schedCrew={schedCrew}
            handleCrewChange={handleCrewChange}
            schedStart={schedStart}
            setSchedStart={setSchedStart}
            schedDays={schedDays}
            setSchedDays={setSchedDays}
            schedCrewSize={schedCrewSize}
            setSchedCrewSize={setSchedCrewSize}
            schedCrewMembers={schedCrewMembers}
            setSchedCrewMembers={setSchedCrewMembers}
            scheduling={scheduling}
            onSubmit={handleScheduleSubmit}
            onClose={() => setShowScheduleModal(false)}
            hp1Next={hp1Next}
            hp2Next={hp2Next}
            todayStr={todayStr}
          />
        )}
        {delayPreview && (
          <DelayModal
            preview={delayPreview}
            reason={delayReason}
            setReason={setDelayReason}
            confirming={confirming}
            onConfirm={handleDelayConfirm}
            onClose={() => { setDelayPreview(null); setDelayEntryId(null); }}
          />
        )}
        {editJob && (
          <EditJobModal
            job={editJob}
            editCrew={editCrew}
            setEditCrew={setEditCrew}
            editStart={editStart}
            setEditStart={setEditStart}
            editDays={editDays}
            setEditDays={setEditDays}
            editCrewSize={editCrewSize}
            setEditCrewSize={setEditCrewSize}
            editCrewMembers={editCrewMembers}
            setEditCrewMembers={setEditCrewMembers}
            saving={saving}
            deleteConfirm={deleteConfirm}
            setDeleteConfirm={setDeleteConfirm}
            onSave={handleEditSave}
            onDelete={handleEditDelete}
            onClose={() => { setEditJob(null); setDeleteConfirm(false); }}
            hp1Next={hp1Next}
            hp2Next={hp2Next}
            todayStr={todayStr}
          />
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // RENDER — DESKTOP TIMELINE VIEW
  // -------------------------------------------------------------------------

  const COL_W = 40;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-semibold text-gray-700">Crew Calendar</div>
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded">←</button>
          <span className="text-xs font-medium text-gray-600 w-32 text-center">{viewMonth}</span>
          <button onClick={nextMonth} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded">→</button>
          {viewStart !== weekStart && (
            <button onClick={goToday} className="px-2 py-1 text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded">Today</button>
          )}
        </div>
        <button
          onClick={openScheduleModal}
          className="px-3 py-1.5 text-xs font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700"
        >
          + Schedule Job
        </button>
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-teal-600 border-t-transparent" />
        </div>
      )}

      {!loading && (
        <div className="overflow-x-auto border border-gray-200 rounded-lg" ref={timelineRef}>
          <div style={{ minWidth: 120 + DAY_COUNT * COL_W }}>
            {/* Date axis — month labels */}
            <div className="flex" style={{ height: 20 }}>
              <div style={{ width: 120, flexShrink: 0 }} />
              {days.map((d, i) => {
                const showMonth = i === 0 || d.slice(0, 7) !== days[i - 1].slice(0, 7);
                return (
                  <div key={d + '-m'} style={{ width: COL_W, flexShrink: 0 }} className="text-center">
                    {showMonth && (
                      <span className="text-[9px] text-gray-400 font-medium">
                        {new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' })}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Date axis — day numbers + day names */}
            <div className="flex border-b border-gray-200" style={{ height: 36 }}>
              <div style={{ width: 120, flexShrink: 0 }} className="border-r border-gray-200" />
              {days.map((d) => {
                const isToday = d === todayStr;
                const weekend = isWeekend(d);
                return (
                  <div
                    key={d}
                    style={{ width: COL_W, flexShrink: 0 }}
                    className={`text-center border-r border-gray-100 ${
                      isToday ? 'bg-blue-50' : weekend ? 'bg-gray-50' : ''
                    }`}
                  >
                    <div className="text-[9px] text-gray-400">{getDayName(d)}</div>
                    <div className={`text-xs font-medium ${isToday ? 'text-blue-600' : 'text-gray-600'}`}>
                      {getDayNum(d)}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Crew rows */}
            {['hp1', 'hp2'].map((crewKey) => {
              const meta = CREW_META[crewKey];
              const jobs = crewKey === 'hp1' ? hp1Jobs : hp2Jobs;
              const nextInfo = crewKey === 'hp1' ? hp1Next : hp2Next;

              return (
                <div key={crewKey} className="flex border-b border-gray-100" style={{ minHeight: 56 }}>
                  {/* Label */}
                  <div
                    style={{ width: 120, flexShrink: 0 }}
                    className="border-r border-gray-200 p-2 flex flex-col justify-center"
                  >
                    <div className="text-xs font-bold" style={{ color: meta.color }}>{meta.label}</div>
                    {jobs.length === 0 ? (
                      <div className="text-[10px] text-green-600">Available now</div>
                    ) : nextInfo ? (
                      <div className="text-[10px] text-green-600">
                        Next: {formatDateShort(nextInfo.next_available_date)}
                      </div>
                    ) : null}
                  </div>

                  {/* Timeline area */}
                  <div className="relative flex-1" style={{ height: 56 }}>
                    {/* Day columns (background) */}
                    <div className="absolute inset-0 flex">
                      {days.map((d) => {
                        const isToday = d === todayStr;
                        const weekend = isWeekend(d);
                        return (
                          <div
                            key={d}
                            style={{ width: COL_W, flexShrink: 0 }}
                            className={`border-r border-gray-50 ${
                              isToday ? 'bg-blue-50' : weekend ? 'bg-gray-50' : ''
                            }`}
                          />
                        );
                      })}
                    </div>

                    {/* Job blocks — colored by CREW */}
                    {jobs.map((job) => {
                      const startStr = dateOnly(job.start_date);
                      // No valid date → don't draw a band (it appears in the list as "Not scheduled").
                      if (!startStr) return null;

                      const offset = daysBetween(viewStart, startStr);
                      const width = job.estimated_days || 1;

                      // Skip if fully out of view
                      if (offset + width <= 0 || offset >= DAY_COUNT) return null;

                      const left = Math.max(0, offset) * COL_W;
                      const visibleWidth = (Math.min(offset + width, DAY_COUNT) - Math.max(offset, 0)) * COL_W - 2;
                      const endStr = addDays(startStr, job.estimated_days);

                      return (
                        <div
                          key={job.id}
                          className="absolute group"
                          style={{
                            left,
                            width: visibleWidth,
                            top: 6,
                            height: 44,
                            ...bandStyleForStatus(meta.color, job.status),
                            borderRadius: 4,
                            padding: '3px 6px',
                            cursor: 'pointer',
                            overflow: 'hidden',
                            zIndex: 10,
                          }}
                          onClick={() => openEditModal(job)}
                          onMouseEnter={(e) => handleJobHover({ ...job, _startStr: startStr, _endStr: endStr }, e)}
                          onMouseLeave={handleJobLeave}
                        >
                          <div className="text-white text-[10px] font-semibold leading-tight truncate">
                            {job.sm8_client_name}{job.sm8_job_number ? ` · #${job.sm8_job_number}` : ''}
                          </div>
                          <div className="text-white/80 text-[9px] truncate">
                            {job.estimated_days}d{job.crew_size ? ` · ${job.crew_size} ppl` : ''}
                          </div>

                          {/* Delay buttons on hover */}
                          <div className="hidden group-hover:flex absolute right-1 top-1 gap-0.5">
                            <button
                              onClick={(e) => handleDelayClick(job.id, 1, e)}
                              className="bg-white/30 hover:bg-white/50 text-white text-[9px] font-bold px-1 rounded"
                            >+1d</button>
                            <button
                              onClick={(e) => handleDelayClick(job.id, 2, e)}
                              className="bg-white/30 hover:bg-white/50 text-white text-[9px] font-bold px-1 rounded"
                            >+2d</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Tooltip */}
          {hoveredJob && (
            <div
              className="absolute bg-gray-900 text-white text-[10px] rounded-lg px-3 py-2 shadow-lg z-50 pointer-events-none"
              style={{
                left: Math.min(tooltipPos.x, (timelineRef.current?.offsetWidth || 400) - 200),
                top: tooltipPos.y - 70,
              }}
            >
              <div className="font-bold">{hoveredJob.sm8_client_name}</div>
              {hoveredJob.sm8_job_number && <div>Job #{hoveredJob.sm8_job_number}</div>}
              <div>{formatDateShort(hoveredJob._startStr)} → {formatDateShort(hoveredJob._endStr)}</div>
              <div>{hoveredJob.estimated_days} day{hoveredJob.estimated_days > 1 ? 's' : ''} est.</div>
              {hoveredJob.crew_members && (
                <div>Crew: {hoveredJob.crew_size || '?'} employees — {hoveredJob.crew_members}</div>
              )}
              <div className="mt-0.5">
                <span
                  className="inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold"
                  style={{ backgroundColor: STATUS_COLORS[hoveredJob.status] || STATUS_COLORS.scheduled }}
                >
                  {hoveredJob.status}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Job list below the timeline */}
      {!loading && (
        <JobList
          activeJobs={activeListJobs}
          completedJobs={completedListJobs}
          listView={listView}
          setListView={setListView}
          onComplete={handleComplete}
          onStatusChange={handleStatusChange}
          onFlagToggle={handleFlagToggle}
          completingId={completingId}
          rowBusyId={rowBusyId}
        />
      )}

      {/* Awaiting scheduling */}
      {!loading && (
        <AwaitingScheduling items={awaitingScheduling} onSchedule={openScheduleModalFor} />
      )}

      {/* Schedule modal */}
      {showScheduleModal && (
        <ScheduleModal
          eligibleProspects={eligibleProspects}
          schedProspectId={schedProspectId}
          setSchedProspectId={setSchedProspectId}
          schedCrew={schedCrew}
          handleCrewChange={handleCrewChange}
          schedStart={schedStart}
          setSchedStart={setSchedStart}
          schedDays={schedDays}
          setSchedDays={setSchedDays}
          schedCrewSize={schedCrewSize}
          setSchedCrewSize={setSchedCrewSize}
          schedCrewMembers={schedCrewMembers}
          setSchedCrewMembers={setSchedCrewMembers}
          scheduling={scheduling}
          onSubmit={handleScheduleSubmit}
          onClose={() => setShowScheduleModal(false)}
          hp1Next={hp1Next}
          hp2Next={hp2Next}
          todayStr={todayStr}
        />
      )}

      {/* Delay modal */}
      {delayPreview && (
        <DelayModal
          preview={delayPreview}
          reason={delayReason}
          setReason={setDelayReason}
          confirming={confirming}
          onConfirm={handleDelayConfirm}
          onClose={() => { setDelayPreview(null); setDelayEntryId(null); }}
        />
      )}

      {/* Edit job modal */}
      {editJob && (
        <EditJobModal
          job={editJob}
          editCrew={editCrew}
          setEditCrew={setEditCrew}
          editStart={editStart}
          setEditStart={setEditStart}
          editDays={editDays}
          setEditDays={setEditDays}
          editCrewSize={editCrewSize}
          setEditCrewSize={setEditCrewSize}
          editCrewMembers={editCrewMembers}
          setEditCrewMembers={setEditCrewMembers}
          saving={saving}
          deleteConfirm={deleteConfirm}
          setDeleteConfirm={setDeleteConfirm}
          onSave={handleEditSave}
          onDelete={handleEditDelete}
          onClose={() => { setEditJob(null); setDeleteConfirm(false); }}
          hp1Next={hp1Next}
          hp2Next={hp2Next}
          todayStr={todayStr}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MobileJobCard
// ---------------------------------------------------------------------------

function MobileJobCard({ job, onDelay, onEdit }) {
  const startStr = dateOnly(job.start_date);
  const endStr = startStr ? addDays(startStr, job.estimated_days) : '';
  const bgColor = CREW_META[job.crew]?.color || '#6B7280';

  return (
    <div className="flex items-center justify-between bg-white border border-gray-100 rounded-lg p-2 mb-1.5 cursor-pointer" onClick={() => onEdit(job)}>
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-1.5 h-8 rounded-full flex-shrink-0" style={{ backgroundColor: bgColor }} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-gray-900 truncate">{job.sm8_client_name}</span>
            {job.sm8_job_number && (
              <span className="shrink-0 text-[9px] font-mono bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">#{job.sm8_job_number}</span>
            )}
          </div>
          <div className="text-[10px] text-gray-400">
            {formatDateShort(startStr)} → {formatDateShort(endStr)} · {job.estimated_days}d{job.crew_size ? ` · ${job.crew_size} ppl` : ''}
          </div>
        </div>
      </div>
      <div className="flex gap-1 flex-shrink-0 ml-2">
        <button
          onClick={(e) => onDelay(job.id, 1, e)}
          className="text-[9px] font-bold bg-gray-100 hover:bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded"
        >+1d</button>
        <button
          onClick={(e) => onDelay(job.id, 2, e)}
          className="text-[9px] font-bold bg-gray-100 hover:bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded"
        >+2d</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleModal
// ---------------------------------------------------------------------------

function ScheduleModal({
  eligibleProspects, schedProspectId, setSchedProspectId,
  schedCrew, handleCrewChange, schedStart, setSchedStart,
  schedDays, setSchedDays, schedCrewSize, setSchedCrewSize,
  schedCrewMembers, setSchedCrewMembers, scheduling, onSubmit, onClose,
  hp1Next, hp2Next, todayStr,
}) {
  const selectedProspect = eligibleProspects.find((p) => String(p.id) === schedProspectId);
  const endDate = schedStart ? addDays(schedStart, schedDays) : '';
  const crewLabel = schedCrew === 'hp1' ? 'HP#1' : 'HP#2';

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <div className="text-sm font-bold text-gray-900">Schedule Job</div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">×</button>
        </div>

        {/* Prospect */}
        <label className="block text-xs text-gray-500 mb-1">Prospect</label>
        <select
          value={schedProspectId}
          onChange={(e) => setSchedProspectId(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs mb-3 outline-none focus:border-teal-500"
        >
          {eligibleProspects.length === 0 && <option value="">No eligible prospects</option>}
          {eligibleProspects.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.sm8_client_name} — {p.sm8_job_number ? `Job #${p.sm8_job_number}` : 'No SM8 job yet'}
            </option>
          ))}
        </select>

        {/* Crew */}
        <label className="block text-xs text-gray-500 mb-1">Crew</label>
        <div className="flex gap-3 mb-3">
          {['hp1', 'hp2'].map((ck) => {
            const next = ck === 'hp1' ? hp1Next : hp2Next;
            const label = ck === 'hp1' ? 'HP#1 (Rigo Tello)' : 'HP#2 (Daniel Tello)';
            const nextDate = next?.next_available_date || todayStr;
            return (
              <label key={ck} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="crew"
                  checked={schedCrew === ck}
                  onChange={() => handleCrewChange(ck)}
                  className="mt-0.5 accent-teal-600"
                />
                <div>
                  <div className="text-xs font-medium text-gray-700">{label}</div>
                  <div className="text-[10px] text-green-600">Next: {formatDateShort(nextDate)}</div>
                </div>
              </label>
            );
          })}
        </div>

        {/* Start date */}
        <label className="block text-xs text-gray-500 mb-1">Start Date</label>
        <input
          type="date"
          value={schedStart}
          onChange={(e) => setSchedStart(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs mb-3 outline-none focus:border-teal-500"
        />

        {/* Days */}
        <label className="block text-xs text-gray-500 mb-1">Estimated Days</label>
        <input
          type="number"
          min={1}
          value={schedDays}
          onChange={(e) => setSchedDays(Math.max(1, Number(e.target.value)))}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs mb-3 outline-none focus:border-teal-500"
        />

        {/* Crew Size */}
        <label className="block text-xs text-gray-500 mb-1">Crew Size</label>
        <input
          type="number"
          min={1}
          max={8}
          value={schedCrewSize}
          onChange={(e) => setSchedCrewSize(Math.max(1, Math.min(8, Number(e.target.value))))}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs mb-1 outline-none focus:border-teal-500"
        />
        <div className="text-[10px] text-gray-400 mb-3">Typical: 2–5 employees</div>

        {/* Crew Members */}
        <label className="block text-xs text-gray-500 mb-1">Crew Members</label>
        <input
          type="text"
          value={schedCrewMembers}
          onChange={(e) => setSchedCrewMembers(e.target.value)}
          placeholder="e.g. Rigo, Angel, Juan, Antonio"
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs mb-1 outline-none focus:border-teal-500"
        />
        <div className="text-[10px] text-gray-400 mb-3">Enter names separated by commas</div>

        {/* Preview */}
        {selectedProspect && schedStart && (
          <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 mb-4">
            {crewLabel}: {selectedProspect.sm8_client_name} — {formatDateShort(schedStart)} to{' '}
            {formatDateShort(endDate)} ({schedDays} day{schedDays > 1 ? 's' : ''}
            {schedCrewSize ? ` · ${schedCrewSize} employee${schedCrewSize !== 1 ? 's' : ''}` : ''})
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onSubmit}
            disabled={scheduling || !schedProspectId || !schedStart}
            className="flex-1 bg-teal-600 text-white rounded-lg py-2 text-xs font-medium hover:bg-teal-700 disabled:opacity-50"
          >
            {scheduling ? 'Scheduling...' : 'Schedule'}
          </button>
          <button
            onClick={onClose}
            className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2 text-xs font-medium hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DelayModal
// ---------------------------------------------------------------------------

function DelayModal({ preview, reason, setReason, confirming, onConfirm, onClose }) {
  const crewLabel = preview.crew === 'hp1' ? 'HP#1' : 'HP#2';

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <div className="text-sm font-bold text-gray-900">
            Confirm Delay — {crewLabel}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">×</button>
        </div>

        <div className="text-xs text-gray-500 mb-3">
          Shifting {preview.affected.length} job{preview.affected.length !== 1 ? 's' : ''} by{' '}
          {preview.days} day{preview.days !== 1 ? 's' : ''}:
        </div>

        <div className="bg-gray-50 rounded-lg p-3 mb-3 max-h-48 overflow-y-auto">
          {preview.affected.map((a) => (
            <div key={a.id} className="text-xs text-gray-700 mb-1">
              <span className="font-medium">{a.sm8_client_name}:</span>{' '}
              {formatDateShort(a.old_start_date)} → {formatDateShort(a.new_start_date)}
            </div>
          ))}
        </div>

        <label className="block text-xs text-gray-500 mb-1">Reason (optional)</label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Rain delay, material delay..."
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs mb-4 outline-none focus:border-teal-500"
        />

        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            disabled={confirming}
            className="flex-1 bg-teal-600 text-white rounded-lg py-2 text-xs font-medium hover:bg-teal-700 disabled:opacity-50"
          >
            {confirming ? 'Applying...' : 'Confirm Delay'}
          </button>
          <button
            onClick={onClose}
            className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2 text-xs font-medium hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EditJobModal
// ---------------------------------------------------------------------------

function EditJobModal({
  job, editCrew, setEditCrew, editStart, setEditStart,
  editDays, setEditDays, editCrewSize, setEditCrewSize,
  editCrewMembers, setEditCrewMembers, saving, deleteConfirm, setDeleteConfirm,
  onSave, onDelete, onClose, hp1Next, hp2Next, todayStr,
}) {
  const endDate = editStart ? addDays(editStart, editDays) : '';

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <div className="text-sm font-bold text-gray-900">Edit — {job.sm8_client_name}</div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">×</button>
        </div>

        {/* SM8 Job Number */}
        <label className="block text-xs text-gray-500 mb-1">ServiceM8 Job</label>
        <div className="mb-3">
          {job.sm8_job_number ? (
            <span className="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-1 rounded">#{job.sm8_job_number}</span>
          ) : (
            <span className="text-xs text-gray-400 italic">Not linked</span>
          )}
        </div>

        {/* Crew */}
        <label className="block text-xs text-gray-500 mb-1">Crew</label>
        <div className="flex gap-3 mb-3">
          {['hp1', 'hp2'].map((ck) => {
            const next = ck === 'hp1' ? hp1Next : hp2Next;
            const label = ck === 'hp1' ? 'HP#1 (Rigo Tello)' : 'HP#2 (Daniel Tello)';
            const nextDate = next?.next_available_date || todayStr;
            return (
              <label key={ck} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="editCrew"
                  checked={editCrew === ck}
                  onChange={() => setEditCrew(ck)}
                  className="mt-0.5 accent-teal-600"
                />
                <div>
                  <div className="text-xs font-medium text-gray-700">{label}</div>
                  <div className="text-[10px] text-green-600">Next: {formatDateShort(nextDate)}</div>
                </div>
              </label>
            );
          })}
        </div>

        {/* Start Date */}
        <label className="block text-xs text-gray-500 mb-1">Start Date</label>
        <input
          type="date"
          value={editStart}
          onChange={(e) => setEditStart(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs mb-3 outline-none focus:border-teal-500"
        />

        {/* Estimated Days */}
        <label className="block text-xs text-gray-500 mb-1">Estimated Days</label>
        <input
          type="number"
          min={1}
          value={editDays}
          onChange={(e) => setEditDays(Math.max(1, Number(e.target.value)))}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs mb-3 outline-none focus:border-teal-500"
        />

        {/* Crew Size */}
        <label className="block text-xs text-gray-500 mb-1">Crew Size</label>
        <input
          type="number"
          min={1}
          max={8}
          value={editCrewSize}
          onChange={(e) => setEditCrewSize(Math.max(1, Math.min(8, Number(e.target.value))))}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs mb-3 outline-none focus:border-teal-500"
        />

        {/* Crew Members */}
        <label className="block text-xs text-gray-500 mb-1">Crew Members</label>
        <input
          type="text"
          value={editCrewMembers}
          onChange={(e) => setEditCrewMembers(e.target.value)}
          placeholder="e.g. Rigo, Angel, Juan, Antonio"
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs mb-3 outline-none focus:border-teal-500"
        />

        {/* Preview */}
        {editStart && (
          <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 mb-4">
            {editCrew === 'hp1' ? 'HP#1' : 'HP#2'}: {formatDateShort(editStart)} to{' '}
            {formatDateShort(endDate)} ({editDays} day{editDays > 1 ? 's' : ''}
            {editCrewSize ? ` · ${editCrewSize} employee${editCrewSize !== 1 ? 's' : ''}` : ''})
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 mb-3">
          <button
            onClick={onSave}
            disabled={saving || !editStart}
            className="flex-1 bg-teal-600 text-white rounded-lg py-2 text-xs font-medium hover:bg-teal-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button
            onClick={onClose}
            className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2 text-xs font-medium hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>

        {/* Delete */}
        {!deleteConfirm ? (
          <button
            onClick={() => setDeleteConfirm(true)}
            className="w-full border border-red-300 text-red-600 rounded-lg py-2 text-xs font-medium hover:bg-red-50"
          >
            Remove from Calendar
          </button>
        ) : (
          <div className="border border-red-300 rounded-lg p-3">
            <div className="text-xs text-red-600 mb-2">
              Remove this job from the calendar? It will return to Deposit Invoice stage.
            </div>
            <div className="flex gap-2">
              <button
                onClick={onDelete}
                disabled={saving}
                className="flex-1 bg-red-600 text-white rounded-lg py-1.5 text-xs font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {saving ? 'Removing...' : 'Yes, Remove'}
              </button>
              <button
                onClick={() => setDeleteConfirm(false)}
                className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-1.5 text-xs font-medium hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// JobList — active / completed scheduled jobs below the timeline
// ---------------------------------------------------------------------------

const LIST_STATUS_BADGE = {
  scheduled:   { bg: '#DBEAFE', text: '#1E40AF', label: 'Scheduled' },
  in_progress: { bg: '#D1FAE5', text: '#065F46', label: 'In Progress' },
  paused:      { bg: '#FEF3C7', text: '#92400E', label: 'Paused' },
  delayed:     { bg: '#FEF3C7', text: '#92400E', label: 'Delayed' },
  completed:   { bg: '#EAF3DE', text: '#27500A', label: 'Completed' },
};

// Settable statuses from the row control (Completed is handled separately).
const STATUS_OPTIONS = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
];

const FLAG_CHIPS = [
  { key: 'needs_sealing', label: 'Needs Sealing', color: '#0F766E' },
  { key: 'needs_landscape', label: 'Needs Landscape', color: '#15803D' },
];

// Tab definitions — adding a third tab (e.g. "Crew Activities") only needs a new
// entry here plus a content branch below; the toggle itself never changes.
const LIST_TABS = [
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
];

function JobList({
  activeJobs, completedJobs, listView, setListView,
  onComplete, onStatusChange, onFlagToggle, completingId, rowBusyId,
}) {
  const jobs = listView === 'completed' ? completedJobs : activeJobs;

  return (
    <div className="mt-6">
      {/* Tabs */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-gray-700">Scheduled Jobs</div>
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
          {LIST_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setListView(t.key)}
              className={`px-3 py-1 text-xs font-medium ${
                listView === t.key ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="text-xs text-gray-400 py-4 text-center border border-gray-100 rounded-lg">
          {listView === 'completed' ? 'No completed jobs yet.' : 'No active jobs scheduled.'}
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
          {jobs.map((job) => (
            <JobListRow
              key={job.id}
              job={job}
              listView={listView}
              onComplete={onComplete}
              onStatusChange={onStatusChange}
              onFlagToggle={onFlagToggle}
              completing={completingId === job.id}
              busy={rowBusyId === job.id || completingId === job.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function JobListRow({ job, listView, onComplete, onStatusChange, onFlagToggle, completing, busy }) {
  const crewMeta = CREW_META[job.crew] || { label: job.crew, color: '#6B7280' };
  const startStr = dateOnly(job.start_date);
  const endStr = startStr ? addDays(startStr, job.estimated_days) : '';
  const isActive = listView === 'active';
  const showMeta = hasRowMeta(job);
  const nt = useNoteThread({ prospectId: job.prospect_id, latestComment: job.latest_comment, commentCount: job.comment_count });

  return (
    <div className="px-3 py-2">
      {/* Line 1 — dot + identity (left) · status select / flags / Mark completed (right) */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: crewMeta.color }} />
        <span className="text-[15px] font-medium text-gray-900 truncate max-w-[240px]" title={job.sm8_client_name}>
          {job.sm8_client_name}
        </span>
        {job.sm8_job_number && (
          <span className="shrink-0 text-[11px] text-gray-400 font-mono">#{job.sm8_job_number}</span>
        )}
        <span className="shrink-0 text-[10px] text-gray-400">{crewMeta.label}</span>

        <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {isActive && (
            <select
              value={job.status === 'completed' ? '' : job.status}
              disabled={busy}
              onChange={(e) => onStatusChange(job, e.target.value)}
              className="text-[10px] border border-gray-200 rounded px-1.5 py-1 text-gray-700 outline-none focus:border-teal-500 disabled:opacity-50"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}

          {FLAG_CHIPS.map((f) => {
            const on = !!job[f.key];
            return (
              <button
                key={f.key}
                onClick={() => onFlagToggle(job, f.key)}
                disabled={busy}
                className="text-[10px] font-medium px-2 py-1 rounded-full border disabled:opacity-50"
                style={on
                  ? { backgroundColor: f.color, color: '#fff', borderColor: f.color }
                  : { backgroundColor: '#fff', color: '#6B7280', borderColor: '#E5E7EB' }}
              >
                {on ? '✓ ' : ''}{f.label}
              </button>
            );
          })}

          {isActive && (
            <button
              onClick={() => onComplete(job.id)}
              disabled={busy}
              className="text-[10px] font-medium border border-green-300 text-green-700 px-2 py-1 rounded hover:bg-green-50 disabled:opacity-50"
            >
              {completing ? 'Saving...' : 'Mark Completed'}
            </button>
          )}
        </div>
      </div>

      {/* Line 2 — address first · Design # | work dates */}
      <div className="flex items-center gap-x-1 gap-y-0.5 flex-wrap text-[10px] text-gray-400 mt-[5px] min-w-0">
        <RowMeta p={job} />
        {showMeta && <span className="text-gray-300">|</span>}
        <span className="shrink-0">
          {startStr
            ? `${formatDateShort(startStr)} → ${formatDateShort(endStr)} · ${job.estimated_days} day${job.estimated_days !== 1 ? 's' : ''}`
            : 'Not scheduled'}
        </span>
      </div>

      {/* Line 3 — latest note · View all · + Note */}
      <div className="flex items-center gap-2 flex-wrap text-[10px] text-gray-400 mt-[5px] min-w-0">
        <NotePreview nt={nt} />
        <NoteAddTrigger nt={nt} />
      </div>

      <NoteExpansion nt={nt} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AwaitingScheduling — production-stage prospects with no crew_schedule entry.
// Each opens the existing Schedule-Job modal pre-selected to that prospect.
// ---------------------------------------------------------------------------

const AWAITING_STAGE_LABEL = {
  pending_permits: 'Pending permits',
  scheduled_for_work: 'Scheduled for work',
  work_in_progress: 'Work in progress',
};

function AwaitingScheduling({ items, onSchedule }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-1">
        <div className="text-sm font-semibold text-gray-700">Awaiting scheduling</div>
        <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">{items.length}</span>
      </div>
      <div className="text-[11px] text-gray-400 mb-2">
        Jobs in a production stage with no crew booking yet — schedule them so they appear on the timeline.
      </div>
      <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
        {items.map((p) => (
          <div key={p.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-semibold text-gray-900 truncate max-w-[220px]" title={p.sm8_client_name}>
                  {p.sm8_client_name}
                </span>
                {p.sm8_job_number && (
                  <span className="shrink-0 text-[11px] text-gray-400 font-mono">#{p.sm8_job_number}</span>
                )}
                <span className="shrink-0 text-[10px] text-gray-400">{AWAITING_STAGE_LABEL[p.stage] || p.stage}</span>
              </div>
              {p.job_address && (
                <div className="text-[10px] text-gray-400 truncate mt-0.5" title={p.job_address}>📍 {p.job_address}</div>
              )}
            </div>
            <button
              onClick={() => onSchedule(p.id)}
              className="shrink-0 text-[10px] font-medium bg-teal-600 text-white px-2.5 py-1 rounded hover:bg-teal-700"
            >
              Schedule
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
