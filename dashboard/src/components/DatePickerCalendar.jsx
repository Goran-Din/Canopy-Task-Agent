import { useState, useEffect, useRef } from 'react';

const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export default function DatePickerCalendar({ selectedDate, todayStr, onSelect, onClose, minDate, maxDate }) {
  const ref = useRef(null);
  const lo = minDate || todayStr;
  const hi = maxDate || addDays(todayStr, 90);

  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const [viewYear, setViewYear] = useState(() => {
    const d = new Date(selectedDate + 'T12:00:00');
    return d.getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date(selectedDate + 'T12:00:00');
    return d.getMonth();
  });

  // Desktop: close on click outside
  useEffect(() => {
    if (isMobile) return; // mobile uses explicit close button
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose, isMobile]);

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

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

  const calendarContent = (
    <>
      {/* Month nav + close button */}
      <div className="flex items-center justify-between mb-3">
        <button onClick={prevMonth} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600 text-base font-bold">
          &#8249;
        </button>
        <span className="text-sm font-semibold text-gray-800">{monthLabel}</span>
        <div className="flex items-center gap-1">
          <button onClick={nextMonth} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600 text-base font-bold">
            &#8250;
          </button>
          {isMobile && (
            <button onClick={onClose} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 text-base font-bold ml-1">
              &#10005;
            </button>
          )}
        </div>
      </div>

      {/* Day name headers */}
      <div className="grid grid-cols-7 gap-0 mb-1">
        {DAY_NAMES.map((n) => (
          <div key={n} className={`text-center font-medium text-gray-400 py-1 ${isMobile ? 'text-xs' : 'text-[10px]'}`}>{n}</div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-0">
        {cells.map((day, i) => {
          if (day === null) return <div key={`e${i}`} />;
          const ds = toDateStr(day);
          const isSelected = ds === selectedDate;
          const isCurrentToday = ds === todayStr;
          const disabled = ds < lo || ds > hi;
          const cellSize = isMobile ? 'w-10 h-10' : 'w-9 h-9';

          return (
            <button
              key={ds}
              disabled={disabled}
              onClick={() => { onSelect(ds); onClose(); }}
              className={`${cellSize} mx-auto flex items-center justify-center rounded-full font-medium relative
                ${isMobile ? 'text-sm' : 'text-xs'}
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
    </>
  );

  // MOBILE: full-screen overlay
  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/40" />
        {/* Card */}
        <div
          ref={ref}
          className="relative bg-white rounded-2xl shadow-xl p-4 mx-4 w-full max-w-sm z-10"
          onClick={(e) => e.stopPropagation()}
        >
          {calendarContent}
        </div>
      </div>
    );
  }

  // DESKTOP: dropdown
  return (
    <div
      ref={ref}
      className="absolute top-full mt-1 bg-white rounded-xl shadow-lg border border-gray-200 p-3 z-50 w-[280px] left-1/2 -translate-x-1/2"
    >
      {calendarContent}
    </div>
  );
}
