import { useCallback, useEffect, useState } from 'react'
import Navbar from '../components/Navbar.jsx'
import homeBackgroundImage from '../assets/images/2v2chess_home.png'
import PlayerProfileModal from '../components/PlayerProfileModal.jsx'

const DEFAULT_API_BASE_URL = 'http://localhost:3001'

function getApiBaseUrl() {
  const configured = typeof import.meta.env.VITE_API_BASE_URL === 'string'
    ? import.meta.env.VITE_API_BASE_URL.trim()
    : ''
  const resolved = configured || DEFAULT_API_BASE_URL
  return resolved.endsWith('/') ? resolved.slice(0, -1) : resolved
}

function getStoredAccessToken() {
  try { return localStorage.getItem('accessToken') ?? '' } catch { return '' }
}

function getStoredUser() {
  try {
    const raw = localStorage.getItem('authUser')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

// ─── Admin Panel Modal ────────────────────────────────────────────────────────

function AdminPlayerModal({ entry, accessToken, apiBaseUrl, onClose, onDeleted, onRoleChanged }) {
  const [details, setDetails] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isDeleting, setIsDeleting] = useState(false)
  const [roleInput, setRoleInput] = useState(entry.role ?? 'player')
  const [isChangingRole, setIsChangingRole] = useState(false)
  const [actionStatus, setActionStatus] = useState('')

  useEffect(() => {
    let alive = true
    async function load() {
      setIsLoading(true)
      try {
        const res = await fetch(`${apiBaseUrl}/users/${encodeURIComponent(entry.user_id)}/admin-details`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        const payload = await res.json().catch(() => null)
        if (alive && res.ok && payload?.ok) setDetails(payload)
      } finally {
        if (alive) setIsLoading(false)
      }
    }
    load()
    return () => { alive = false }
  }, [entry.user_id, accessToken, apiBaseUrl])

  const handleDelete = async () => {
    if (!window.confirm(`Delete ${entry.username}? This cannot be undone.`)) return
    setIsDeleting(true)
    setActionStatus('')
    try {
      const res = await fetch(`${apiBaseUrl}/users/${encodeURIComponent(entry.user_id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const payload = await res.json().catch(() => null)
      if (res.ok && payload?.ok) {
        onDeleted(entry.user_id)
        onClose()
      } else {
        setActionStatus(typeof payload?.error === 'string' ? payload.error : 'Delete failed.')
      }
    } catch {
      setActionStatus('Delete failed.')
    } finally {
      setIsDeleting(false)
    }
  }

  const handleRoleChange = async (e) => {
    e.preventDefault()
    setIsChangingRole(true)
    setActionStatus('')
    try {
      const res = await fetch(`${apiBaseUrl}/users/${encodeURIComponent(entry.user_id)}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ role: roleInput }),
      })
      const payload = await res.json().catch(() => null)
      if (res.ok && payload?.ok) {
        setActionStatus('Role updated.')
        onRoleChanged(entry.user_id, roleInput)
      } else {
        setActionStatus(typeof payload?.error === 'string' ? payload.error : 'Role change failed.')
      }
    } catch {
      setActionStatus('Role change failed.')
    } finally {
      setIsChangingRole(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-700/60 bg-slate-900 p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-slate-400 hover:text-white text-lg leading-none"
          aria-label="Close"
        >
          ✕
        </button>

        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300">Admin</span>
          <h2 className="text-lg font-bold text-white">{entry.username}</h2>
        </div>
        <p className="text-xs text-slate-500 mb-4 truncate">{entry.user_id}</p>

        {isLoading ? (
          <p className="text-sm text-slate-400">Loading details…</p>
        ) : details ? (
          <>
            {/* Stats */}
            <div className="grid grid-cols-3 gap-2 mb-5">
              <AdminStat label="Rating" value={Number(entry.rating ?? 0)} />
              <AdminStat label="Games" value={Number(details.stats?.total_games ?? 0)} />
              <AdminStat label="Reports" value={Number(details.reports?.length ?? 0)} color="rose" />
            </div>

            {/* Reports */}
            {details.reports?.length > 0 && (
              <section className="mb-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-rose-300 mb-2">
                  Reports ({details.reports.length})
                </h3>
                <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                  {details.reports.map((r) => (
                    <div key={r.report_id} className="rounded-lg bg-slate-800/60 border border-rose-500/20 p-2 text-xs">
                      <div className="flex justify-between text-slate-400 mb-1">
                        <span className="font-medium text-slate-300">{r.reporter_username ?? r.reporter_id}</span>
                        <span>{new Date(r.created_at).toLocaleDateString()}</span>
                      </div>
                      <p className="text-slate-300 break-words">{r.reason}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Messages */}
            {details.messages?.length > 0 && (
              <section className="mb-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  Recent Messages ({details.messages.length})
                </h3>
                <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                  {details.messages.map((m) => (
                    <div key={m.chat_id} className="rounded bg-slate-800/50 border border-slate-700/40 px-2 py-1 text-xs">
                      <div className="flex justify-between text-slate-500 mb-0.5">
                        <span className="capitalize">{m.chat_type} chat · game {m.game_id}</span>
                        <span>{new Date(m.created_at).toLocaleDateString()}</span>
                      </div>
                      <p className="text-slate-300 break-words">{m.message}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-400 mb-4">Could not load details.</p>
        )}

        {/* Role change */}
        <form onSubmit={handleRoleChange} className="flex items-center gap-2 mb-4">
          <select
            value={roleInput}
            onChange={(e) => setRoleInput(e.target.value)}
            disabled={isChangingRole}
            className="flex-1 rounded-lg bg-slate-800/70 border border-slate-600/50 px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
          >
            <option value="player">player</option>
            <option value="admin">admin</option>
          </select>
          <button
            type="submit"
            disabled={isChangingRole}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isChangingRole ? 'Saving…' : 'Set Role'}
          </button>
        </form>

        {actionStatus && (
          <p className="text-xs text-slate-300 mb-3">{actionStatus}</p>
        )}

        {/* Delete */}
        <button
          type="button"
          onClick={handleDelete}
          disabled={isDeleting}
          className="w-full rounded-lg py-2 text-xs font-semibold bg-rose-500/20 border border-rose-500/40 text-rose-300 hover:bg-rose-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isDeleting ? 'Deleting…' : 'Delete Profile'}
        </button>
      </div>
    </div>
  )
}

function AdminStat({ label, value, color = 'slate' }) {
  const valueClass = color === 'rose' ? 'text-rose-300' : color === 'amber' ? 'text-amber-300' : 'text-white'
  return (
    <div className="rounded-lg bg-slate-800/60 border border-slate-700/50 p-2 text-center">
      <p className="text-[10px] text-slate-400">{label}</p>
      <p className={['text-base font-bold', valueClass].join(' ')}>{value}</p>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LeaderboardsPage() {
  const apiBaseUrl = getApiBaseUrl()
  const [entries, setEntries] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [adminTarget, setAdminTarget] = useState(null)
  const [selectedPlayer, setSelectedPlayer] = useState(null)

  const accessToken = getStoredAccessToken()
  const currentUser = getStoredUser()
  const isAdmin = Array.isArray(currentUser?.roles)
    ? currentUser.roles.includes('admin')
    : currentUser?.role === 'admin'

  const loadLeaderboard = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
      const response = await fetch(`${apiBaseUrl}/leaderboards`, { headers })
      const payload = await response.json().catch(() => null)

      if (!response.ok || payload?.ok !== true || !Array.isArray(payload?.leaderboard)) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not load leaderboard')
      }

      setEntries(payload.leaderboard)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load leaderboard')
    } finally {
      setIsLoading(false)
    }
  }, [apiBaseUrl, accessToken])

  useEffect(() => {
    loadLeaderboard()
  }, [loadLeaderboard])

  const handleDeleted = (userId) => {
    setEntries((prev) => prev.filter((e) => e.user_id !== userId))
  }

  const handleRoleChanged = (userId, newRole) => {
    setEntries((prev) => prev.map((e) => e.user_id === userId ? { ...e, role: newRole } : e))
  }

  return (
    <div className="h-dvh overflow-hidden bg-slate-950 text-slate-100">
      <Navbar />

      <section
        className="relative flex h-[calc(100dvh-4rem)] items-center justify-center overflow-hidden"
        style={{
          backgroundImage: `url(${homeBackgroundImage})`,
          backgroundPosition: 'center',
          backgroundSize: 'cover',
          backgroundRepeat: 'no-repeat',
        }}
      >
        <div className="absolute inset-0 bg-slate-950/65" />

        <div
          className="relative z-10 w-full max-w-3xl rounded-2xl border border-slate-700/60 bg-slate-900/80 px-8 py-7 shadow-2xl shadow-black/50"
          style={{ backdropFilter: 'blur(16px)' }}
        >
          <h1 className="text-center text-2xl font-extrabold uppercase tracking-widest text-white">
            Leaderboards
          </h1>

          {isLoading ? (
            <p className="mt-5 text-center text-sm text-slate-300">Loading leaderboard...</p>
          ) : error ? (
            <p className="mt-5 text-center text-sm text-rose-300">{error}</p>
          ) : entries.length === 0 ? (
            <p className="mt-5 text-center text-sm text-slate-300">No leaderboard entries yet.</p>
          ) : (
            <div className="mt-5 overflow-hidden rounded-xl border border-slate-700/60">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-slate-800/80 text-slate-200">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Rank</th>
                    <th className="px-4 py-3 font-semibold">Player</th>
                    <th className="px-4 py-3 font-semibold text-right">Rating</th>
                    {isAdmin && <th className="px-4 py-3 font-semibold text-right">Reports</th>}
                    {isAdmin && <th className="px-2 py-3" />}
                  </tr>
                </thead>
                <tbody className="bg-slate-900/70 text-slate-100">
                  {entries.map((entry, index) => (
                    <tr key={entry.user_id || `${entry.username}-${index}`} className="border-t border-slate-700/60">
                      <td className="px-4 py-3 text-slate-300">#{index + 1}</td>
                      <td className="px-4 py-3 font-medium text-white">
                        <button
                          type="button"
                          onClick={() => setSelectedPlayer({
                            userId: entry.user_id,
                            username: entry.username || 'Unknown player',
                          })}
                          className="text-left text-white hover:text-indigo-200 transition-colors"
                        >
                          {entry.username || 'Unknown player'}
                        </button>
                        {isAdmin && entry.role === 'admin' && (
                          <span className="ml-2 text-[10px] px-1 py-0.5 rounded bg-amber-500/20 border border-amber-500/30 text-amber-300">admin</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-indigo-300">{Number(entry.rating ?? 0)}</td>
                      {isAdmin && (
                        <td className="px-4 py-3 text-right">
                          {Number(entry.report_count ?? 0) > 0 ? (
                            <span className="font-semibold text-rose-300">{entry.report_count}</span>
                          ) : (
                            <span className="text-slate-500">0</span>
                          )}
                        </td>
                      )}
                      {isAdmin && (
                        <td className="px-2 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setAdminTarget(entry)}
                            className="rounded p-1 text-slate-400 hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
                            title="Admin: manage player"
                          >
                            🔧
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {adminTarget && (
        <AdminPlayerModal
          entry={adminTarget}
          accessToken={accessToken}
          apiBaseUrl={apiBaseUrl}
          onClose={() => setAdminTarget(null)}
          onDeleted={handleDeleted}
          onRoleChanged={handleRoleChanged}
        />
      )}

      {selectedPlayer && (
        <PlayerProfileModal
          userId={selectedPlayer.userId}
          username={selectedPlayer.username}
          accessToken={accessToken}
          onClose={() => setSelectedPlayer(null)}
        />
      )}
    </div>
  )
}
