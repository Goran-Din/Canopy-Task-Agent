import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import CrewColumn from './components/CrewColumn';

const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes
const MAX_DAYS_FORWARD = 30;
const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Get today's date string (YYYY-MM-DD) in Chicago timezone */
function getTodayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/** Add days to a YYYY-MM-DD string */
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

/** Format date for display: "Saturday, March 21, 2026" */
function formatDateLong(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Format date short: "Sat 03/21" */
function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
  });
}

function formatSyncTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    });
  } catch {
    return '';
  }
}

/** Inline calendar popup for date picking */
function DatePickerCalendar({ selectedDate, todayStr, onSelect, onClose }) {
  const ref = useRef(null);
  const minDate = todayStr;
  const maxDate = addDays(todayStr, MAX_DAYS_FORWARD);

  // Start viewing the month of the currently selected date
  const [viewYear, setViewYear] = useState(() => {
    const d = new Date(selectedDate + 'T12:00:00');
    return d.getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date(selectedDate + 'T12:00:00');
    return d.getMonth();
  });

  // Close on click outside
  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  // Build day grid
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11); }
    else setViewMonth(viewMonth - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0); }
    else setViewMonth(viewMonth + 1);
  }

  function toDateStr(day) {
    const m = String(viewMonth + 1).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${viewYear}-${m}-${dd}`;
  }

  return (
    <div
      ref={ref}
      className="absolute top-full mt-1 bg-white rounded-xl shadow-lg border border-gray-200 p-3 z-50 w-[280px] left-1/2 -translate-x-1/2 sm:w-[280px] max-sm:left-2 max-sm:right-2 max-sm:translate-x-0 max-sm:w-auto"
    >
      {/* Month nav */}
      <div className="flex items-center justify-between mb-2">
        <button onClick={prevMonth} className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 text-gray-600 text-sm font-bold">
          &#8249;
        </button>
        <span className="text-sm font-semibold text-gray-800">{monthLabel}</span>
        <button onClick={nextMonth} className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 text-gray-600 text-sm font-bold">
          &#8250;
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 gap-0 mb-1">
        {DAY_NAMES.map((n) => (
          <div key={n} className="text-center text-[10px] font-medium text-gray-400 py-0.5">{n}</div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-0">
        {cells.map((day, i) => {
          if (day === null) return <div key={`e${i}`} />;
          const ds = toDateStr(day);
          const isSelected = ds === selectedDate;
          const isCurrentToday = ds === todayStr;
          const disabled = ds < minDate || ds > maxDate;

          return (
            <button
              key={ds}
              disabled={disabled}
              onClick={() => { onSelect(ds); onClose(); }}
              className={`w-9 h-9 mx-auto flex items-center justify-center rounded-full text-xs font-medium relative
                ${disabled ? 'text-gray-300 cursor-not-allowed' : 'hover:bg-blue-50 text-gray-700'}
                ${isSelected ? 'bg-blue-600 text-white hover:bg-blue-700' : ''}
              `}
            >
              {day}
              {isCurrentToday && !isSelected && (
                <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-blue-600" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function LandscapeApp() {
  const [scheduleData, setScheduleData] = useState(null);
  const [selectedDate, setSelectedDate] = useState(getTodayStr);
  const [filterCrew, setFilterCrew] = useState('all');
  const [filterInvoice, setFilterInvoice] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [calendarOpen, setCalendarOpen] = useState(false);

  const todayStr = useMemo(() => getTodayStr(), []);

  const canGoBack = selectedDate > todayStr;
  const canGoForward = selectedDate < addDays(todayStr, MAX_DAYS_FORWARD);
  const isToday = selectedDate === todayStr;

  const fetchSchedule = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`/landscape/schedule?date=${selectedDate}`, {
        credentials: 'include',
      });
      if (res.status === 401) {
        setNeedsLogin(true);
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setScheduleData(data);
      setNeedsLogin(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    fetchSchedule();
    const interval = setInterval(fetchSchedule, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchSchedule]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch('/dashboard/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setLoginError('Incorrect password');
        return;
      }
      setNeedsLogin(false);
      setPassword('');
      setLoading(true);
      fetchSchedule();
    } catch {
      setLoginError('Connection error');
    }
  };

  // Login wall
  if (needsLogin) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <form
          onSubmit={handleLogin}
          className="bg-white rounded-xl shadow-lg p-8 w-full max-w-sm"
        >
          <h1 className="text-xl font-bold text-gray-900 mb-6 text-center">
            Landscape Crew Board
          </h1>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm mb-3 outline-none focus:border-blue-500"
          />
          {loginError && (
            <p className="text-red-600 text-xs mb-3">{loginError}</p>
          )}
          <button
            type="submit"
            className="w-full bg-blue-600 text-white font-medium rounded-lg py-2.5 text-sm hover:bg-blue-700"
          >
            Sign In
          </button>
        </form>
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  // Error state
  if (error && !scheduleData) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <button
          onClick={() => { setLoading(true); fetchSchedule(); }}
          className="text-gray-600 text-sm bg-white rounded-lg shadow px-6 py-4"
        >
          Unable to load schedule. Tap to retry.
        </button>
      </div>
    );
  }

  const crews = scheduleData?.crews || [];

  // Apply filters
  const filteredCrews = crews
    .filter((c) => filterCrew === 'all' || c.crew_id === filterCrew)
    .map((c) => {
      if (filterInvoice === 'all') return c;
      const filteredJobs = c.jobs.filter((j) => {
        const st = j.invoice?.status || 'not_invoiced';
        return st === filterInvoice;
      });
      return { ...c, jobs: filteredJobs };
    });

  const crewIds = ['lp1', 'lp2', 'lp3', 'lp4'];
  const crewLabels = { lp1: 'LP#1', lp2: 'LP#2', lp3: 'LP#3', lp4: 'LP#4' };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-bold text-gray-900">
            <span className="mr-1">&#127807;</span> Landscape Crew Board
          </h1>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            {scheduleData?.last_sync && (
              <span>Last sync: {formatSyncTime(scheduleData.last_sync)}</span>
            )}
            <button
              onClick={() => { setLoading(true); fetchSchedule(); }}
              className="text-blue-600 hover:text-blue-800 font-medium text-sm"
              title="Refresh"
            >
              &#8634;
            </button>
          </div>
        </div>

        {/* Date navigator */}
        <div className="max-w-7xl mx-auto px-4 pb-2 flex items-center justify-center gap-2">
          <button
            onClick={() => canGoBack && setSelectedDate(addDays(selectedDate, -1))}
            disabled={!canGoBack}
            className={`w-8 h-8 flex items-center justify-center rounded-lg border text-sm font-bold ${
              canGoBack
                ? 'border-gray-300 text-gray-700 hover:bg-gray-100'
                : 'border-gray-100 text-gray-300 cursor-not-allowed'
            }`}
          >
            &#8249;
          </button>
          <div className="relative">
            <button
              onClick={() => setCalendarOpen(!calendarOpen)}
              className="text-sm font-semibold text-gray-800 min-w-[220px] text-center px-2 py-1 rounded-lg hover:bg-gray-100 cursor-pointer"
            >
              {formatDateLong(selectedDate)}
            </button>
            {calendarOpen && (
              <DatePickerCalendar
                selectedDate={selectedDate}
                todayStr={todayStr}
                onSelect={setSelectedDate}
                onClose={() => setCalendarOpen(false)}
              />
            )}
          </div>
          <button
            onClick={() => canGoForward && setSelectedDate(addDays(selectedDate, 1))}
            disabled={!canGoForward}
            className={`w-8 h-8 flex items-center justify-center rounded-lg border text-sm font-bold ${
              canGoForward
                ? 'border-gray-300 text-gray-700 hover:bg-gray-100'
                : 'border-gray-100 text-gray-300 cursor-not-allowed'
            }`}
          >
            &#8250;
          </button>
          {!isToday && (
            <button
              onClick={() => setSelectedDate(getTodayStr())}
              className="px-2.5 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100"
            >
              Today
            </button>
          )}
        </div>

        {/* Filter bar */}
        <div className="max-w-7xl mx-auto px-4 pb-3 flex flex-wrap gap-2">

          {/* Crew filter */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200">
            <button
              onClick={() => setFilterCrew('all')}
              className={`px-3 py-1.5 text-xs font-medium ${
                filterCrew === 'all'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              All
            </button>
            {crewIds.map((id) => (
              <button
                key={id}
                onClick={() => setFilterCrew(id)}
                className={`px-3 py-1.5 text-xs font-medium ${
                  filterCrew === id
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {crewLabels[id]}
              </button>
            ))}
          </div>

          {/* Invoice filter */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200">
            {[
              { key: 'all', label: 'All' },
              { key: 'not_invoiced', label: 'Not Invoiced' },
              { key: 'overdue', label: 'Overdue' },
            ].map((f) => (
              <button
                key={f.key}
                onClick={() => setFilterInvoice(f.key)}
                className={`px-3 py-1.5 text-xs font-medium ${
                  filterInvoice === f.key
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {filteredCrews.map((crew) => (
            <CrewColumn key={crew.crew_id} crew={crew} />
          ))}
        </div>
      </main>
    </div>
  );
}
