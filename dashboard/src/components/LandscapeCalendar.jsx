import { useState, useEffect, useCallback, useRef } from 'react';
import DatePickerCalendar from './DatePickerCalendar';

const CREW_META = {
  lp1: { label: 'LP#1', color: '#2563EB' },
  lp2: { label: 'LP#2', color: '#EAB308' },
  lp3: { label: 'LP#3', color: '#EA580C' },
  lp4: { label: 'LP#4', color: '#9333EA' },
};

const CREW_IDS = ['lp1', 'lp2', 'lp3', 'lp4'];
const LABEL_W = 120;
const DAY_COUNT = 30;
const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 min

// Time grid constants
const DAY_START = 7; // 7 AM
const DAY_END = 18; // 6 PM
const TOTAL_HOURS = DAY_END - DAY_START; // 11
const HOUR_HEIGHT = 18; // px per hour
const ROW_H = TOTAL_HOURS * HOUR_HEIGHT; // 198px

/** Build time label array; labelInterval controls which labels are shown */
function buildTimeLabels(interval) {
  return Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => {
    const h = DAY_START + i;
    const label = h === 0 ? '12AM' : h < 12 ? `${h}AM` : h === 12 ? '12PM' : `${h - 12}PM`;
    return i % interval === 0 ? label : '';
  });
}

/** Determine breakpoint: 'mobile' | 'tablet' | 'desktop' */
function getBreakpoint() {
  const w = window.innerWidth;
  if (w < 768) return 'mobile';
  if (w <= 1024) return 'tablet';
  return 'desktop';
}

/** Column width varies by breakpoint */
function calcColW(bp) {
  const containerW = window.innerWidth - 48;
  if (bp === 'tablet') {
    return Math.max(60, Math.floor((containerW - LABEL_W) / 5));
  }
  // desktop: 7 visible days
  return Math.max(80, Math.min(160, Math.floor((containerW - LABEL_W) / 7)));
}

function toDateStr(d) {
  return d.toISOString().split('T')[0];
}

function getMonday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return toDateStr(d);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return toDateStr(d);
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

function formatDateFull(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatDateMobile(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr.replace(' ', 'T')).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    });
  } catch {
    return '';
  }
}

function formatTimeShort(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr.replace(' ', 'T'));
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    return `${h}:${String(m).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function parseHour(isoStr) {
  if (!isoStr) return null;
  try {
    const d = new Date(isoStr.replace(' ', 'T'));
    return d.getUTCHours() + d.getUTCMinutes() / 60;
  } catch {
    return null;
  }
}

const STATUS_LABELS = {
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Completed',
};

const STATUS_COLORS = {
  scheduled: '#3B82F6',
  in_progress: '#10B981',
  completed: '#6B7280',
};

// ---------------------------------------------------------------------------
// MAIN COMPONENT
// ---------------------------------------------------------------------------

export default function LandscapeCalendar() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const todayStr = toDateStr(new Date());
  const [viewStart, setViewStart] = useState(() => getMonday(todayStr));

  // Tooltip (desktop/tablet only)
  const [tooltip, setTooltip] = useState(null);
  const tooltipRef = useRef(null);

  // Date picker popup
  const [pickerOpen, setPickerOpen] = useState(false);

  // Responsive breakpoint
  const [bp, setBp] = useState(getBreakpoint);
  const [colW, setColW] = useState(() => calcColW(getBreakpoint()));
  useEffect(() => {
    const onResize = () => {
      const newBp = getBreakpoint();
      setBp(newBp);
      setColW(calcColW(newBp));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Mobile: single-day index offset from viewStart
  const [mobileDayOffset, setMobileDayOffset] = useState(0);
  const mobileDate = addDays(viewStart, mobileDayOffset);

  // Collapsible crew sections on mobile
  const [expandedCrews, setExpandedCrews] = useState(() => {
    const m = {};
    CREW_IDS.forEach((id) => (m[id] = true));
    return m;
  });
  const toggleCrew = (id) =>
    setExpandedCrews((prev) => ({ ...prev, [id]: !prev[id] }));

  // Fetch data
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(
        `/landscape/calendar?from_date=${viewStart}&days=${DAY_COUNT}`,
        { credentials: 'include' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Calendar fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [viewStart]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const interval = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Close tooltip on outside click
  useEffect(() => {
    if (!tooltip) return;
    const handler = (e) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target)) setTooltip(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [tooltip]);

  // Build date columns
  const dates = [];
  for (let i = 0; i < DAY_COUNT; i++) dates.push(addDays(viewStart, i));

  // Navigation
  const currentMonthLabel = getMonthLabel(viewStart);
  const thisMonday = getMonday(todayStr);
  const showTodayBtn = viewStart !== thisMonday || (bp === 'mobile' && mobileDayOffset !== 0);

  const prevWeek = () => {
    setViewStart(addDays(viewStart, -7));
    setMobileDayOffset(0);
  };
  const nextWeek = () => {
    setViewStart(addDays(viewStart, 7));
    setMobileDayOffset(0);
  };
  const goToToday = () => {
    setViewStart(thisMonday);
    setMobileDayOffset(0);
  };

  // Mobile day navigation
  const prevDay = () => {
    if (mobileDayOffset > 0) {
      setMobileDayOffset(mobileDayOffset - 1);
    } else {
      setViewStart(addDays(viewStart, -7));
      setMobileDayOffset(6);
    }
  };
  const nextDay = () => {
    if (mobileDayOffset < DAY_COUNT - 1) {
      setMobileDayOffset(mobileDayOffset + 1);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  const crews = data?.crews || {};
  const totalJobs = CREW_IDS.reduce((sum, id) => sum + (crews[id]?.jobs?.length || 0), 0);

  function getJobsByDate(crewId) {
    const jobs = crews[crewId]?.jobs || [];
    const byDate = {};
    for (const job of jobs) {
      if (!byDate[job.date]) byDate[job.date] = [];
      byDate[job.date].push(job);
    }
    return byDate;
  }

  function getJobPosition(job) {
    const startHour = parseHour(job.scheduled_start);
    const duration = job.estimated_hours || 2;
    const clampedDuration = Math.min(duration, TOTAL_HOURS);

    let top;
    if (startHour === null) {
      top = 0;
    } else {
      top = (Math.max(startHour, DAY_START) - DAY_START) * HOUR_HEIGHT;
    }

    const height = Math.max(clampedDuration * HOUR_HEIGHT, 24);
    const maxTop = ROW_H - 24;
    return { top: Math.min(top, maxTop), height: Math.min(height, ROW_H - Math.min(top, maxTop)) };
  }

  // ===================================================================
  // MOBILE VIEW — single day, vertical job list, collapsible crews
  // ===================================================================
  if (bp === 'mobile') {
    return (
      <div className="pb-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-gray-900">Crew Calendar</h2>
          <div className="flex items-center gap-1">
            {showTodayBtn && (
              <button onClick={goToToday} className="px-2 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg mr-1">Today</button>
            )}
            <div className="relative">
              <button
                onClick={() => setPickerOpen(!pickerOpen)}
                className="text-xs font-medium text-gray-600 px-2 py-1 rounded-lg hover:bg-gray-100"
              >
                {getMonthLabel(mobileDate)}
              </button>
              {pickerOpen && (
                <DatePickerCalendar
                  selectedDate={mobileDate}
                  todayStr={todayStr}
                  onSelect={(d) => {
                    // Compute new viewStart (Monday of that week) and offset
                    const mon = getMonday(d);
                    const diff = Math.round(
                      (new Date(d + 'T12:00:00') - new Date(mon + 'T12:00:00')) / 86400000
                    );
                    setViewStart(mon);
                    setMobileDayOffset(diff);
                  }}
                  onClose={() => setPickerOpen(false)}
                  minDate="2025-01-01"
                  maxDate={addDays(todayStr, 365)}
                />
              )}
            </div>
          </div>
        </div>

        {/* Day navigation — full width, large tap targets */}
        <div className="flex items-center justify-between mb-3 w-full">
          <button onClick={prevDay} className="w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-xl border border-gray-200 text-gray-600 text-lg font-bold active:bg-gray-100">&#8249;</button>
          <div className={`flex-1 text-center text-sm font-bold px-2 ${mobileDate === todayStr ? 'text-blue-700' : 'text-gray-800'}`}>
            {formatDateMobile(mobileDate)}
          </div>
          <button onClick={nextDay} className="w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-xl border border-gray-200 text-gray-600 text-lg font-bold active:bg-gray-100">&#8250;</button>
        </div>

        {/* Crew sections */}
        {CREW_IDS.map((crewId) => {
          const meta = CREW_META[crewId];
          const leadName = crews[crewId]?.lead_name || '';
          const dayJobs = (crews[crewId]?.jobs || []).filter((j) => j.date === mobileDate);
          const expanded = expandedCrews[crewId];

          return (
            <div key={crewId} className="mb-2 bg-white rounded-xl border border-gray-200 overflow-hidden">
              {/* Crew header — tap to collapse */}
              <button
                onClick={() => toggleCrew(crewId)}
                className="w-full flex items-center justify-between px-3 py-2.5"
              >
                <div className="flex items-center">
                  <div className="w-3 h-3 rounded-full mr-2 flex-shrink-0" style={{ backgroundColor: meta.color }} />
                  <span className="text-sm font-bold" style={{ color: meta.color }}>
                    {meta.label} {leadName}
                  </span>
                  {dayJobs.length > 0 && (
                    <span className="ml-2 text-xs text-gray-400 font-normal">{dayJobs.length} job{dayJobs.length !== 1 ? 's' : ''}</span>
                  )}
                </div>
                <span className="text-gray-400 text-xs">{expanded ? '\u25B2' : '\u25BC'}</span>
              </button>

              {/* Job list */}
              {expanded && (
                <div className="px-3 pb-3">
                  {dayJobs.length === 0 ? (
                    <div className="text-xs text-gray-400 py-2">No jobs scheduled</div>
                  ) : (
                    dayJobs.map((job) => {
                      const startShort = formatTimeShort(job.scheduled_start);
                      const endShort = formatTimeShort(job.scheduled_end);
                      const timeRange = startShort && endShort ? `${startShort}-${endShort}` : startShort || '';

                      return (
                        <div
                          key={job.job_uuid}
                          className="bg-gray-50 rounded-lg mb-1.5 px-3 py-2"
                          style={{ borderLeft: `4px solid ${meta.color}` }}
                        >
                          <div className="text-sm font-bold text-gray-900 truncate">{job.client_name}</div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            #{job.job_number}
                            {timeRange && <> &middot; {timeRange}</>}
                            {job.estimated_hours > 0 && <> &middot; {job.estimated_hours}h</>}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}

        {totalJobs === 0 && (
          <div className="bg-gray-100 rounded-lg px-4 py-3 mt-2 text-center text-gray-500 text-xs">
            No jobs scheduled for this period
          </div>
        )}
      </div>
    );
  }

  // ===================================================================
  // TABLET + DESKTOP — horizontal time grid
  // ===================================================================
  const visibleDays = bp === 'tablet' ? 5 : 7;
  const timeLabels = buildTimeLabels(bp === 'tablet' ? 3 : 2);
  const totalW = LABEL_W + DAY_COUNT * colW;

  // Month boundary labels
  const monthLabels = [];
  let lastMonth = '';
  for (let i = 0; i < dates.length; i++) {
    const d = new Date(dates[i] + 'T12:00:00');
    const ml = d.toLocaleDateString('en-US', { month: 'short' });
    if (ml !== lastMonth) {
      monthLabels.push({ idx: i, label: ml });
      lastMonth = ml;
    }
  }

  const navStep = visibleDays;
  const prevStep = () => setViewStart(addDays(viewStart, -navStep));
  const nextStep = () => setViewStart(addDays(viewStart, navStep));

  return (
    <div className="pb-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-gray-900">Crew Calendar</h2>
        <div className="flex items-center gap-2">
          {showTodayBtn && (
            <button onClick={goToToday} className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100">Today</button>
          )}
          <button onClick={prevStep} className="w-7 h-7 flex items-center justify-center rounded border border-gray-200 text-gray-600 text-sm font-bold hover:bg-gray-50">&#8249;</button>
          <div className="relative">
            <button
              onClick={() => setPickerOpen(!pickerOpen)}
              className="text-sm font-medium text-gray-700 min-w-[140px] text-center px-2 py-1 rounded-lg hover:bg-gray-100 cursor-pointer"
            >
              {currentMonthLabel}
            </button>
            {pickerOpen && (
              <DatePickerCalendar
                selectedDate={viewStart}
                todayStr={todayStr}
                onSelect={setViewStart}
                onClose={() => setPickerOpen(false)}
                minDate="2025-01-01"
                maxDate={addDays(todayStr, 365)}
              />
            )}
          </div>
          <button onClick={nextStep} className="w-7 h-7 flex items-center justify-center rounded border border-gray-200 text-gray-600 text-sm font-bold hover:bg-gray-50">&#8250;</button>
        </div>
      </div>

      {/* Empty state banner */}
      {totalJobs === 0 && (
        <div className="bg-gray-100 rounded-lg px-4 py-3 mb-3 text-center text-gray-500 text-xs">
          No jobs scheduled for this period — jobs will appear here automatically when scheduled in ServiceM8
        </div>
      )}

      {/* Crew rows with time grids */}
      {CREW_IDS.map((crewId) => {
        const meta = CREW_META[crewId];
        const leadName = crews[crewId]?.lead_name || '';
        const jobsByDate = getJobsByDate(crewId);

        return (
          <div key={crewId} className="bg-white rounded-xl border border-gray-200 overflow-x-auto mb-3" style={{ minWidth: 0 }}>
            {/* Crew header */}
            <div className="flex items-center px-3 py-2 border-b border-gray-200 bg-gray-50/50">
              <div
                className="w-3 h-3 rounded-full mr-2 flex-shrink-0"
                style={{ backgroundColor: meta.color }}
              />
              <span className="text-xs font-bold" style={{ color: meta.color }}>
                {meta.label} {leadName}
              </span>
            </div>

            <div style={{ width: totalW, minWidth: totalW }}>
              {/* Month labels row */}
              <div className="flex" style={{ height: 18 }}>
                <div style={{ width: LABEL_W, minWidth: LABEL_W }} />
                <div className="relative flex-1" style={{ height: 18 }}>
                  {monthLabels.map((m) => (
                    <div
                      key={m.idx}
                      className="absolute text-[10px] font-semibold text-gray-400 uppercase"
                      style={{ left: m.idx * colW, top: 3 }}
                    >
                      {m.label}
                    </div>
                  ))}
                </div>
              </div>

              {/* Day numbers header */}
              <div className="flex border-b border-gray-200" style={{ height: 32 }}>
                <div style={{ width: LABEL_W, minWidth: LABEL_W }} className="border-r border-gray-100" />
                {dates.map((d) => {
                  const isToday = d === todayStr;
                  const wknd = isWeekend(d);
                  return (
                    <div
                      key={d}
                      className={`flex flex-col items-center justify-center text-[10px] border-r border-gray-100
                        ${isToday ? 'bg-blue-50 font-bold text-blue-700' : wknd ? 'bg-gray-50 text-gray-400' : 'text-gray-500'}`}
                      style={{ width: colW, minWidth: colW }}
                    >
                      <span>{getDayName(d)}</span>
                      <span className="font-semibold text-xs">{getDayNum(d)}</span>
                    </div>
                  );
                })}
              </div>

              {/* Time grid row */}
              <div className="flex" style={{ height: ROW_H }}>
                {/* Time labels column */}
                <div className="relative border-r border-gray-100" style={{ width: LABEL_W, minWidth: LABEL_W }}>
                  {timeLabels.map((label, i) => (
                    <div
                      key={i}
                      className="absolute text-[9px] text-gray-400 pr-2 text-right w-full"
                      style={{ top: i * HOUR_HEIGHT - 6 }}
                    >
                      {label}
                    </div>
                  ))}
                </div>

                {/* Day columns with time grid */}
                {dates.map((d) => {
                  const isToday = d === todayStr;
                  const wknd = isWeekend(d);
                  const dayJobs = jobsByDate[d] || [];

                  return (
                    <div
                      key={d}
                      className={`relative border-r border-gray-100 ${isToday ? 'bg-blue-50/30' : wknd ? 'bg-gray-50/30' : ''}`}
                      style={{ width: colW, minWidth: colW }}
                    >
                      {/* Hour grid lines */}
                      {timeLabels.map((_, i) => (
                        <div
                          key={i}
                          className="absolute left-0 right-0 border-t border-gray-100"
                          style={{ top: i * HOUR_HEIGHT }}
                        />
                      ))}

                      {/* Job blocks */}
                      {dayJobs.map((job) => {
                        const pos = getJobPosition(job);
                        const startTimeShort = formatTimeShort(job.scheduled_start);
                        const endTimeShort = formatTimeShort(job.scheduled_end);
                        const timeRange = startTimeShort && endTimeShort
                          ? `${startTimeShort}-${endTimeShort}`
                          : startTimeShort || '';

                        return (
                          <div
                            key={job.job_uuid}
                            className="absolute rounded cursor-pointer overflow-hidden z-10"
                            style={{
                              left: 2,
                              right: 2,
                              top: pos.top,
                              height: pos.height,
                              backgroundColor: meta.color,
                            }}
                            onMouseEnter={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setTooltip({
                                job,
                                crewId,
                                x: rect.left + rect.width / 2,
                                y: rect.bottom + 4,
                              });
                            }}
                            onMouseLeave={() => setTooltip(null)}
                          >
                            <div className="text-white" style={{ padding: '3px 5px', lineHeight: 1.2 }}>
                              <div className="text-[11px] font-bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                                {job.client_name}
                              </div>
                              <div className="text-[10px] opacity-85">#{job.job_number}</div>
                              {timeRange && pos.height >= 56 && (
                                <div className="text-[9px] opacity-75">{timeRange}</div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}

      {/* Tooltip */}
      {tooltip && (
        <div
          ref={tooltipRef}
          className="fixed z-50 bg-gray-900 text-white rounded-lg shadow-lg px-3 py-2 text-xs pointer-events-none"
          style={{
            left: Math.min(tooltip.x, window.innerWidth - 220),
            top: tooltip.y,
            maxWidth: 240,
          }}
        >
          <div className="font-bold mb-1">{tooltip.job.client_name}</div>
          <div className="text-gray-300">Job #{tooltip.job.job_number}</div>
          <div className="text-gray-300">
            {formatDateFull(tooltip.job.date)}
            {tooltip.job.scheduled_start && <> &middot; {formatTime(tooltip.job.scheduled_start)}</>}
          </div>
          <div className="text-gray-300">{tooltip.job.estimated_hours} hours estimated</div>
          <div className="text-gray-300">{tooltip.job.employee_count} employees</div>
          <div className="mt-1">
            <span
              className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{ backgroundColor: STATUS_COLORS[tooltip.job.status] || '#6B7280' }}
            >
              {STATUS_LABELS[tooltip.job.status] || tooltip.job.status}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
