import { useState, useEffect, useCallback } from 'react';
import PipelineTab from './components/PipelineTab';
import ArchiveTab from './components/ArchiveTab';

const TABS = [
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'archive', label: 'Archive' },
];

export default function HardscapeApp() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [tab, setTab] = useState('pipeline');
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(true);

  // Check auth on mount
  useEffect(() => {
    fetch('/dashboard/prospects', { credentials: 'include' })
      .then((r) => {
        if (r.ok) {
          setAuthed(true);
          return r.json();
        }
        throw new Error('Not authed');
      })
      .then((data) => {
        setProspects(data.prospects || []);
        setLoading(false);
      })
      .catch(() => {
        setAuthed(false);
        setLoading(false);
      });
  }, []);

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
        setLoginError('Invalid password');
        return;
      }
      setAuthed(true);
      fetchProspects();
    } catch {
      setLoginError('Login failed');
    }
  };

  const fetchProspects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/dashboard/prospects', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setProspects(data.prospects || []);
    } catch (err) {
      console.error('Fetch prospects error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-refresh every 60s
  useEffect(() => {
    if (!authed) return;
    fetchProspects();
    const interval = setInterval(fetchProspects, 60000);
    return () => clearInterval(interval);
  }, [authed, fetchProspects]);

  // Login wall
  if (!authed) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <form
          onSubmit={handleLogin}
          className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 w-full max-w-xs"
        >
          <div className="text-center mb-4">
            <div className="text-lg font-bold text-gray-900">Hardscape Pipeline</div>
            <div className="text-xs text-gray-400 mt-1">Sunset Services US</div>
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Dashboard password"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 mb-3"
            autoFocus
          />
          {loginError && (
            <div className="text-xs text-red-500 mb-2">{loginError}</div>
          )}
          <button
            type="submit"
            className="w-full bg-teal-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-teal-700"
          >
            Sign In
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <div className="text-lg font-bold text-gray-900">Hardscape Pipeline</div>
            <div className="text-xs text-gray-400">Sunset Services US</div>
          </div>

          {/* Tabs */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-1.5 text-sm font-medium ${
                  tab === t.key
                    ? 'bg-teal-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-4 py-4">
        {tab === 'pipeline' && (
          <PipelineTab prospects={prospects} loading={loading} />
        )}
        {tab === 'archive' && <ArchiveTab />}
      </div>
    </div>
  );
}
