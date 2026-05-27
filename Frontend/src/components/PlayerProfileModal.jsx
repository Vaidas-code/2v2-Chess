import { useCallback, useEffect, useState } from 'react'

const DEFAULT_API_BASE_URL = 'http://localhost:3001'

function getApiBaseUrl() {
  const configured = typeof import.meta.env.VITE_API_BASE_URL === 'string'
    ? import.meta.env.VITE_API_BASE_URL.trim()
    : ''
  const resolved = configured || DEFAULT_API_BASE_URL
  return resolved.endsWith('/') ? resolved.slice(0, -1) : resolved
}

export default function PlayerProfileModal({ userId, username, onClose, accessToken }) {
  const apiBaseUrl = getApiBaseUrl()
  const [stats, setStats] = useState(null)
  const [isLoadingStats, setIsLoadingStats] = useState(true)
  const [reportReason, setReportReason] = useState('')
  const [isReporting, setIsReporting] = useState(false)
  const [reportStatus, setReportStatus] = useState('')
  const [reportDone, setReportDone] = useState(false)

  const loadStats = useCallback(async () => {
    if (!userId || !accessToken) return
    setIsLoadingStats(true)
    try {
      const res = await fetch(`${apiBaseUrl}/users/${encodeURIComponent(userId)}/stats`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const payload = await res.json().catch(() => null)
      if (res.ok && payload?.ok) setStats(payload.stats)
    } catch {
      // silently ignore
    } finally {
      setIsLoadingStats(false)
    }
  }, [userId, accessToken, apiBaseUrl])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  const handleReport = async (e) => {
    e.preventDefault()
    if (!reportReason.trim() || isReporting) return
    setIsReporting(true)
    setReportStatus('')
    try {
      const res = await fetch(`${apiBaseUrl}/reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ reported_id: userId, reason: reportReason.trim() }),
      })
      const payload = await res.json().catch(() => null)
      if (res.ok && payload?.ok) {
        setReportDone(true)
        setReportStatus('Report submitted. Thank you.')
      } else {
        setReportStatus(typeof payload?.error === 'string' ? payload.error : 'Failed to submit report.')
      }
    } catch {
      setReportStatus('Failed to submit report.')
    } finally {
      setIsReporting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative w-full max-w-sm rounded-2xl border border-slate-700/60 bg-slate-900 p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-slate-400 hover:text-white text-lg leading-none"
          aria-label="Close"
        >
          ✕
        </button>

        <h2 className="text-lg font-bold text-white">{username}</h2>
        <p className="text-xs text-slate-400 mb-4 truncate">{userId}</p>

        {isLoadingStats ? (
          <p className="text-sm text-slate-400">Loading stats…</p>
        ) : stats ? (
          <div className="grid grid-cols-2 gap-3 mb-5">
            <StatCard label="Rating" value={Number(stats.rating ?? 0)} />
            <StatCard label="Total Games" value={Number(stats.total_games ?? 0)} />
            <StatCard label="Finished" value={Number(stats.finished_games ?? 0)} />
            <StatCard label="Active" value={Number(stats.active_games ?? 0)} />
          </div>
        ) : (
          <p className="text-sm text-slate-400 mb-4">Could not load stats.</p>
        )}

        <div className="border-t border-slate-700/50 pt-4">
          <h3 className="text-sm font-semibold text-slate-200 mb-2">Report Player</h3>
          {reportDone ? (
            <p className="text-xs text-emerald-300">{reportStatus}</p>
          ) : (
            <form onSubmit={handleReport} className="flex flex-col gap-2">
              <textarea
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                disabled={isReporting}
                placeholder="Describe the reason for reporting…"
                rows={3}
                maxLength={1000}
                className="w-full resize-none rounded-lg bg-slate-800/70 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 border border-slate-600/50 focus:border-rose-500/50 focus:outline-none disabled:opacity-50"
              />
              {reportStatus && (
                <p className="text-xs text-rose-300">{reportStatus}</p>
              )}
              <button
                type="submit"
                disabled={isReporting || !reportReason.trim()}
                className="rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-300 border border-rose-500/40 hover:bg-rose-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isReporting ? 'Submitting…' : 'Submit Report'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-lg bg-slate-800/60 border border-slate-700/50 p-3 text-center">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-lg font-bold text-white">{value}</p>
    </div>
  )
}
