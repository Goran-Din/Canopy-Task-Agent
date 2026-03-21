import { useState, useEffect, useCallback, useRef } from 'react';

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

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function daysBetween(a, b) {
  const da = new Date(a + 'T12:00:00');
  const db = new Date(b + 'T12:00:00');
  return Math.round((db - da) / 86400000);
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateFull(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
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
  const [loading, setLoading] = useState(true);

  // View state
  const todayStr = toDateStr(new Date());
  const [viewStart, setViewStart] = useState(todayStr);
  const DAY_COUNT = 30;

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
      const [schedRes, hp1Res, hp2Res, prospRes] = await Promise.all([
        fetch('/dashboard/crew-schedule', { credentials: 'include' }),
        fetch('/dashboard/crew-schedule/next-available?crew=hp1', { credentials: 'include' }),
        fetch('/dashboard/crew-schedule/next-available?crew=hp2', { credentials: 'include' }),
        fetch('/dashboard/prospects', { credentials: 'include' }),
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

  // -------------------------------------------------------------------------
  // Month navigation
  // -------------------------------------------------------------------------

  const viewMonth = getMonthLabel(viewStart);

  const prevMonth = () => {
    const d = new Date(viewStart + 'T12:00:00');
    d.setDate(d.getDate() - 30);
    const minDate = new Date(todayStr + 'T12:00:00');
    minDate.setDate(minDate.getDate() - 30);
    if (d >= minDate) setViewStart(toDateStr(d));
  };

  const nextMonth = () => {
    const d = new Date(viewStart + 'T12:00:00');
    d.setDate(d.getDate() + 30);
    setViewStart(toDateStr(d));
  };

  const goToday = () => setViewStart(todayStr);

  // -------------------------------------------------------------------------
  // Schedule Job modal helpers
  // -------------------------------------------------------------------------

  const scheduledProspectIds = new Set(schedule.map((e) => e.prospect_id));
  const eligibleProspects = prospects.filter(
    (p) =>
      ['deposit_invoice', 'scheduled', 'in_progress'].includes(p.stage) &&
      (!p.crew_assignment || !scheduledProspectIds.has(p.id))
  );

  const openScheduleModal = () => {
    const nextDate =
      schedCrew === 'hp1'
        ? hp1Next?.next_available_date || todayStr
        : hp2Next?.next_available_date || todayStr;
    setSchedStart(nextDate);
    setSchedProspectId(eligibleProspects.length > 0 ? String(eligibleProspects[0].id) : '');
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
    setSchedStart(nextDate);
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
          {viewStart !== todayStr && (
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

                    {/* Job blocks */}
                    {jobs.map((job) => {
                      const startStr = typeof job.start_date === 'string'
                        ? job.start_date.split('T')[0]
                        : toDateStr(new Date(job.start_date));
                      const offset = daysBetween(viewStart, startStr);
                      const width = job.estimated_days || 1;

                      // Skip if fully out of view
                      if (offset + width <= 0 || offset >= DAY_COUNT) return null;

                      const left = Math.max(0, offset) * COL_W;
                      const visibleWidth = (Math.min(offset + width, DAY_COUNT) - Math.max(offset, 0)) * COL_W - 2;
                      const bgColor = STATUS_COLORS[job.status] || STATUS_COLORS.scheduled;
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
                            backgroundColor: bgColor,
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
                            {job.sm8_client_name}
                          </div>
                          <div className="text-white/80 text-[9px] truncate">
                            {job.sm8_job_number ? `#${job.sm8_job_number} ` : ''}· {job.estimated_days}d{job.crew_size ? ` · ${job.crew_size} ppl` : ''}
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
  const startStr = typeof job.start_date === 'string'
    ? job.start_date.split('T')[0]
    : toDateStr(new Date(job.start_date));
  const endStr = addDays(startStr, job.estimated_days);
  const bgColor = STATUS_COLORS[job.status] || STATUS_COLORS.scheduled;

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
            {formatDateShort(endDate)} ({schedDays} day{schedDays > 1 ? 's' : ''} · {schedCrewSize} employee{schedCrewSize !== 1 ? 's' : ''})
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
            {formatDateShort(endDate)} ({editDays} day{editDays > 1 ? 's' : ''} · {editCrewSize} employee{editCrewSize !== 1 ? 's' : ''})
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
