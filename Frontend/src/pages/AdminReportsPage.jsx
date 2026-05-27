import { useEffect, useState } from 'react'
import Navbar from '../components/Navbar.jsx'
import homeBackgroundImage from '../assets/images/2v2chess_home.png'

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

function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

// ─── Player Modal ─────────────────────────────────────────────────────────────

function PlayerModal({ userId, username, accessToken, apiBaseUrl, onClose, onBanned }) {
  const [details, setDetails] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [banReason, setBanReason] = useState('')
  const [isBanning, setIsBanning] = useState(false)
  const [banStatus, setBanStatus] = useState('')
  const [isBanned, setIsBanned] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteStatus, setDeleteStatus] = useState('')

  useEffect(() => {
    let alive = true
    async function load() {
      setIsLoading(true)
      try {
        const res = await fetch(`${apiBaseUrl}/users/${encodeURIComponent(userId)}/admin-details`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        const payload = await res.json().catch(() => null)
        if (alive && res.ok && payload?.ok) {
          setDetails(payload)
          setIsBanned(payload.user?.banned === true)
        }
      } finally {
        if (alive) setIsLoading(false)
      }
    }
    load()
    return () => { alive = false }
  }, [userId, accessToken, apiBaseUrl])

  const handleBan = async (e) => {
    e.preventDefault()
    if (!banReason.trim()) {
      setBanStatus('Ban reason is required.')
      return
    }
    setIsBanning(true)
    setBanStatus('')
    try {
      const res = await fetch(`${apiBaseUrl}/users/${encodeURIComponent(userId)}/ban`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ ban_reason: banReason.trim() }),
      })
      const payload = await res.json().catch(() => null)
      if (res.ok && payload?.ok) {
        setIsBanned(true)
        setBanStatus('Player banned successfully.')
        onBanned?.(userId)
      } else {
        setBanStatus(typeof payload?.error === 'string' ? payload.error : 'Ban failed.')
      }
    } catch {
      setBanStatus('Ban failed.')
    } finally {
      setIsBanning(false)
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
          {isBanned && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-500/40 text-rose-300">Banned</span>
          )}
          <h2 className="text-lg font-bold text-white">{username}</h2>
        </div>

        {isLoading ? (
          <p className="text-sm text-slate-400">Loading player details…</p>
        ) : details ? (
          <>
            {/* Stats */}
            <div className="grid grid-cols-3 gap-2 mb-5">
              <div className="rounded-lg bg-slate-800/60 border border-slate-700/50 p-2 text-center">
                <p className="text-[10px] text-slate-400">Rating</p>
                <p className="text-base font-bold text-white">{Number(details.user?.rating ?? 0)}</p>
              </div>
              <div className="rounded-lg bg-slate-800/60 border border-slate-700/50 p-2 text-center">
                <p className="text-[10px] text-slate-400">Games</p>
                <p className="text-base font-bold text-white">{Number(details.stats?.total_games ?? 0)}</p>
              </div>
              <div className="rounded-lg bg-slate-800/60 border border-slate-700/50 p-2 text-center">
                <p className="text-[10px] text-slate-400">Reports</p>
                <p className="text-base font-bold text-rose-300">{Number(details.reports?.length ?? 0)}</p>
              </div>
            </div>

            {/* Reports against this player */}
            {details.reports?.length > 0 && (
              <section className="mb-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-rose-300 mb-2">
                  Reports against this player ({details.reports.length})
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

            {/* Recent messages */}
            {details.messages?.length > 0 && (
              <section className="mb-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  Recent Messages ({details.messages.length})
                </h3>
                <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                  {details.messages.map((m) => (
                    <div key={m.chat_id} className="rounded bg-slate-800/50 border border-slate-700/40 px-2 py-1 text-xs">
                      <div className="flex justify-between text-slate-500 mb-0.5">
                        <span className="capitalize">{m.chat_type} · game {m.game_id}</span>
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
          <p className="text-sm text-slate-400 mb-4">Could not load player details.</p>
        )}

        {/* Delete profile */}
        <div className="border-t border-slate-700/50 pt-4 mt-2 mb-3">
          <button
            type="button"
            disabled={isDeleting}
            onClick={async () => {
              if (!window.confirm(`Delete ${username}'s profile? This cannot be undone.`)) return
              setIsDeleting(true)
              setDeleteStatus('')
              try {
                const res = await fetch(`${apiBaseUrl}/users/${encodeURIComponent(userId)}`, {
                  method: 'DELETE',
                  headers: { Authorization: `Bearer ${accessToken}` },
                })
                const payload = await res.json().catch(() => null)
                if (res.ok && payload?.ok) {
                  onBanned?.(userId)
                  onClose()
                } else {
                  setDeleteStatus(typeof payload?.error === 'string' ? payload.error : 'Delete failed.')
                }
              } catch {
                setDeleteStatus('Delete failed.')
              } finally {
                setIsDeleting(false)
              }
            }}
            className="w-full rounded-lg py-2 text-xs font-semibold bg-slate-700/40 border border-slate-600/50 text-slate-300 hover:bg-slate-700/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isDeleting ? 'Deleting…' : 'Delete Profile'}
          </button>
          {deleteStatus && <p className="mt-1.5 text-xs text-rose-300">{deleteStatus}</p>}
        </div>

        {/* Ban section */}
        <div className="border-t border-slate-700/50 pt-4 mt-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-rose-300 mb-3">
            {isBanned ? 'Player is banned' : 'Ban Player'}
          </h3>
          {isBanned ? (
            <p className="text-xs text-slate-500">
              Ban reason: <span className="text-slate-300">{details?.user?.ban_reason ?? '—'}</span>
            </p>
          ) : (
            <form onSubmit={handleBan} className="flex flex-col gap-2">
              <textarea
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Reason for ban…"
                rows={3}
                disabled={isBanning}
                className="w-full rounded-lg border border-slate-600/50 bg-slate-800/70 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-rose-500/50 focus:ring-1 focus:ring-rose-500/30 resize-none disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={isBanning || !banReason.trim()}
                className="w-full rounded-lg py-2 text-xs font-semibold bg-rose-500/20 border border-rose-500/40 text-rose-300 hover:bg-rose-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isBanning ? 'Banning…' : 'Ban Player'}
              </button>
            </form>
          )}
          {banStatus && (
            <p className="mt-2 text-xs text-slate-300">{banStatus}</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminReportsPage() {
  const apiBaseUrl = getApiBaseUrl()
  const accessToken = getStoredAccessToken()
  const currentUser = getStoredUser()
  const isAdmin = Array.isArray(currentUser?.roles)
    ? currentUser.roles.includes('admin')
    : currentUser?.role === 'admin'

  const [reports, setReports] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedPlayer, setSelectedPlayer] = useState(null) // { userId, username }

  useEffect(() => {
    if (!isAdmin) return
    let alive = true

    async function load() {
      setIsLoading(true)
      setError('')
      try {
        const res = await fetch(`${apiBaseUrl}/admin/reports`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        const payload = await res.json().catch(() => null)
        if (!res.ok || !payload?.ok) throw new Error(payload?.error ?? 'Could not load reports')
        if (alive) setReports(payload.reports ?? [])
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load reports')
      } finally {
        if (alive) setIsLoading(false)
      }
    }

    load()
    return () => { alive = false }
  }, [apiBaseUrl, accessToken, isAdmin])

  const handleMarkRead = async (reportId) => {
    try {
      const res = await fetch(`${apiBaseUrl}/admin/reports/${reportId}/read`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const payload = await res.json().catch(() => null)
      if (res.ok && payload?.ok) {
        setReports((prev) =>
          prev.map((r) =>
            r.report_id === reportId ? { ...r, read_at: new Date().toISOString() } : r
          )
        )
      }
    } catch {
      // silently ignore
    }
  }

  const unreadCount = reports.filter((r) => !r.read_at).length

  if (!isAdmin) {
    return (
      <div className="h-dvh bg-slate-950 text-slate-100">
        <Navbar />
        <div className="flex h-[calc(100dvh-4rem)] items-center justify-center">
          <p className="text-rose-300 text-sm">Admin access required.</p>
        </div>
      </div>
    )
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
          className="relative z-10 w-full max-w-4xl rounded-2xl border border-slate-700/60 bg-slate-900/80 px-8 py-7 shadow-2xl shadow-black/50 max-h-[85vh] flex flex-col"
          style={{ backdropFilter: 'blur(16px)' }}
        >
          <div className="flex items-center justify-between mb-5 shrink-0">
            <h1 className="text-2xl font-extrabold uppercase tracking-widest text-white">
              Reports
            </h1>
            {unreadCount > 0 && (
              <span className="rounded-full bg-rose-500/20 border border-rose-500/40 px-3 py-0.5 text-xs font-semibold text-rose-300">
                {unreadCount} unread
              </span>
            )}
          </div>

          {isLoading ? (
            <p className="text-center text-sm text-slate-300">Loading reports...</p>
          ) : error ? (
            <p className="text-center text-sm text-rose-300">{error}</p>
          ) : reports.length === 0 ? (
            <p className="text-center text-sm text-slate-400">No reports yet.</p>
          ) : (
            <div className="overflow-y-auto flex-1 rounded-xl border border-slate-700/60">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-slate-800/80 text-slate-200 sticky top-0">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Reporter</th>
                    <th className="px-4 py-3 font-semibold">Reported</th>
                    <th className="px-4 py-3 font-semibold">Reason</th>
                    <th className="px-4 py-3 font-semibold whitespace-nowrap">Date</th>
                    <th className="px-4 py-3 font-semibold whitespace-nowrap">Read</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => {
                    const isRead = Boolean(r.read_at)
                    return (
                      <tr
                        key={r.report_id}
                        className={[
                          'border-t border-slate-700/40 transition-colors',
                          isRead ? 'bg-slate-900/30 text-slate-500' : 'bg-slate-900/70 text-slate-100',
                        ].join(' ')}
                      >
                        <td className="px-4 py-3 whitespace-nowrap font-medium">
                          {r.reporter_username ?? r.reporter_id}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setSelectedPlayer({ userId: r.reported_id, username: r.reported_username ?? r.reported_id })}
                            className={[
                              'font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity',
                              isRead ? 'text-slate-500' : 'text-rose-300',
                            ].join(' ')}
                          >
                            {r.reported_username ?? r.reported_id}
                          </button>
                        </td>
                        <td className="px-4 py-3 max-w-xs break-words">{r.reason}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs">
                          {formatDate(r.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          {isRead ? (
                            <span className="text-xs text-slate-600">Read</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleMarkRead(r.report_id)}
                              className="rounded px-2 py-1 text-xs font-semibold bg-rose-500/20 border border-rose-500/40 text-rose-300 hover:bg-rose-500/30 transition-colors"
                            >
                              Mark read
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {selectedPlayer && (
        <PlayerModal
          userId={selectedPlayer.userId}
          username={selectedPlayer.username}
          accessToken={accessToken}
          apiBaseUrl={apiBaseUrl}
          onClose={() => setSelectedPlayer(null)}
          onBanned={() => setSelectedPlayer(null)}
        />
      )}
    </div>
  )
}
