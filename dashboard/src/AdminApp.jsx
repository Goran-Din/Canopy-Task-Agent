import { useState, useEffect, useCallback } from 'react';

const DASHBOARD_URLS = [
  { label: 'Landscape Crews', url: 'https://crews.sunsetapp.us/crews' },
  { label: 'Hardscape Pipeline', url: 'https://hardscape.sunsetapp.us/hardscape' },
  { label: 'Admin Dashboard', url: 'https://admin.sunsetapp.us/admin' },
  { label: 'Task Agent API', url: 'https://tasks-agent.sunsetapp.us/health' },
];

export default function AdminApp() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ title: '', content: '', category: '', tags: '' });
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ title: '', content: '', category: 'general', tags: '' });
  const [copiedUrl, setCopiedUrl] = useState(null);

  // Check auth on mount
  useEffect(() => {
    fetch('/admin/knowledge', { credentials: 'include' })
      .then((r) => {
        if (r.ok) { setAuthed(true); return r.json(); }
        throw new Error('Not authed');
      })
      .then((data) => { setDocuments(data.documents || []); setLoading(false); })
      .catch(() => { setAuthed(false); setLoading(false); });
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      });
      if (!res.ok) { setLoginError('Invalid password'); return; }
      setAuthed(true);
      fetchDocuments();
    } catch { setLoginError('Login failed'); }
  };

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const url = searchQuery.trim()
        ? `/admin/knowledge/search?q=${encodeURIComponent(searchQuery.trim())}`
        : '/admin/knowledge';
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setDocuments(data.documents || []);
    } catch (err) {
      console.error('Fetch documents error:', err);
    } finally { setLoading(false); }
  }, [searchQuery]);

  useEffect(() => {
    if (!authed) return;
    fetchDocuments();
  }, [authed, fetchDocuments]);

  const handleSearch = (e) => {
    e.preventDefault();
    fetchDocuments();
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    try {
      const tags = addForm.tags ? addForm.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      const res = await fetch('/admin/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...addForm, tags }),
      });
      if (!res.ok) throw new Error('Failed');
      setAddForm({ title: '', content: '', category: 'general', tags: '' });
      setShowAdd(false);
      fetchDocuments();
    } catch (err) { console.error('Add error:', err); }
  };

  const handleEdit = async (id) => {
    try {
      const tags = editForm.tags ? editForm.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      const res = await fetch(`/admin/knowledge/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...editForm, tags }),
      });
      if (!res.ok) throw new Error('Failed');
      setEditingId(null);
      fetchDocuments();
    } catch (err) { console.error('Edit error:', err); }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this document?')) return;
    try {
      const res = await fetch(`/admin/knowledge/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed');
      fetchDocuments();
    } catch (err) { console.error('Delete error:', err); }
  };

  const startEdit = (doc) => {
    setEditingId(doc.id);
    setEditForm({
      title: doc.title,
      content: doc.content,
      category: doc.category,
      tags: (doc.tags || []).join(', '),
    });
  };

  const copyUrl = (url) => {
    navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  // Login wall
  if (!authed) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <form onSubmit={handleLogin} className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 w-full max-w-xs">
          <div className="text-center mb-4">
            <div className="text-lg font-bold text-gray-900">Admin Dashboard</div>
            <div className="text-xs text-gray-400 mt-1">Canopy Task Agent</div>
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 mb-3"
            autoFocus
          />
          {loginError && <div className="text-xs text-red-500 mb-2">{loginError}</div>}
          <button type="submit" className="w-full bg-indigo-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-indigo-700">
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
        <div className="max-w-4xl mx-auto">
          <div className="text-lg font-bold text-gray-900">Admin Dashboard</div>
          <div className="text-xs text-gray-400">Canopy Task Agent</div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-8">
        {/* Knowledge Base Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-900">Knowledge Base</h2>
            <button
              onClick={() => setShowAdd(!showAdd)}
              className="px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              {showAdd ? 'Cancel' : '+ Add Document'}
            </button>
          </div>

          {/* Search */}
          <form onSubmit={handleSearch} className="flex gap-2 mb-4">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search documents..."
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
            <button type="submit" className="px-4 py-2 text-sm bg-gray-100 rounded-lg hover:bg-gray-200 text-gray-700">
              Search
            </button>
            {searchQuery && (
              <button
                type="button"
                onClick={() => { setSearchQuery(''); }}
                className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                Clear
              </button>
            )}
          </form>

          {/* Add Form */}
          {showAdd && (
            <form onSubmit={handleAdd} className="bg-white border border-gray-200 rounded-xl p-4 mb-4 space-y-3">
              <input
                type="text"
                value={addForm.title}
                onChange={(e) => setAddForm({ ...addForm, title: e.target.value })}
                placeholder="Title"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
                required
              />
              <textarea
                value={addForm.content}
                onChange={(e) => setAddForm({ ...addForm, content: e.target.value })}
                placeholder="Content (SOPs, policies, procedures...)"
                rows={6}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
                required
              />
              <div className="flex gap-3">
                <input
                  type="text"
                  value={addForm.category}
                  onChange={(e) => setAddForm({ ...addForm, category: e.target.value })}
                  placeholder="Category"
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
                <input
                  type="text"
                  value={addForm.tags}
                  onChange={(e) => setAddForm({ ...addForm, tags: e.target.value })}
                  placeholder="Tags (comma-separated)"
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
              </div>
              <button type="submit" className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
                Save Document
              </button>
            </form>
          )}

          {/* Document List */}
          {loading ? (
            <div className="text-sm text-gray-400 py-8 text-center">Loading...</div>
          ) : documents.length === 0 ? (
            <div className="text-sm text-gray-400 py-8 text-center">
              {searchQuery ? 'No documents match your search.' : 'No documents yet. Add your first one above.'}
            </div>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <div key={doc.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setExpandedId(expandedId === doc.id ? null : doc.id)}
                    className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-50"
                  >
                    <div>
                      <div className="text-sm font-medium text-gray-900">{doc.title}</div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {doc.category}
                        {doc.tags?.length > 0 && (
                          <span className="ml-2">
                            {doc.tags.map((t) => (
                              <span key={t} className="inline-block bg-gray-100 text-gray-500 rounded px-1.5 py-0.5 text-[10px] mr-1">{t}</span>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-gray-400 text-xs">{expandedId === doc.id ? '\u25B2' : '\u25BC'}</span>
                  </button>

                  {expandedId === doc.id && (
                    <div className="px-4 pb-4 border-t border-gray-100">
                      {editingId === doc.id ? (
                        <div className="pt-3 space-y-3">
                          <input
                            type="text"
                            value={editForm.title}
                            onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
                          />
                          <textarea
                            value={editForm.content}
                            onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
                            rows={6}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
                          />
                          <div className="flex gap-3">
                            <input
                              type="text"
                              value={editForm.category}
                              onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
                            />
                            <input
                              type="text"
                              value={editForm.tags}
                              onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
                              placeholder="Tags (comma-separated)"
                              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
                            />
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => handleEdit(doc.id)} className="px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
                              Save
                            </button>
                            <button onClick={() => setEditingId(null)} className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="pt-3">
                          <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans">{doc.content}</pre>
                          <div className="flex gap-2 mt-3">
                            <button onClick={() => startEdit(doc)} className="px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">
                              Edit
                            </button>
                            <button onClick={() => handleDelete(doc.id)} className="px-3 py-1.5 text-xs font-medium text-red-600 hover:text-red-800">
                              Delete
                            </button>
                          </div>
                          <div className="text-[10px] text-gray-300 mt-2">
                            Updated {new Date(doc.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* System Info Section */}
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-4">System Info</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {DASHBOARD_URLS.map((item) => (
              <div key={item.url} className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-900">{item.label}</div>
                  <div className="text-xs text-gray-400 mt-0.5 break-all">{item.url}</div>
                </div>
                <button
                  onClick={() => copyUrl(item.url)}
                  className="ml-3 px-2.5 py-1 text-xs font-medium rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 shrink-0"
                >
                  {copiedUrl === item.url ? 'Copied!' : 'Copy'}
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
