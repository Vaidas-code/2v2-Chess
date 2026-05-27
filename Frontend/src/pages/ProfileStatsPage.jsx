import { useEffect, useState } from 'react'
import Navbar from '../components/Navbar.jsx'
import homeBackgroundImage from '../assets/images/2v2chess_home.png'
import { tryRefreshAccessToken } from '../authSession.js'

const DEFAULT_API_BASE_URL = 'http://localhost:3001'

function getApiBaseUrl() {
  const configuredApiBaseUrl = typeof import.meta.env.VITE_API_BASE_URL === 'string'
    ? import.meta.env.VITE_API_BASE_URL.trim()
    : ''

  const resolvedApiBaseUrl = configuredApiBaseUrl || DEFAULT_API_BASE_URL
  return resolvedApiBaseUrl.endsWith('/') ? resolvedApiBaseUrl.slice(0, -1) : resolvedApiBaseUrl
}

function getStoredUser() {
  try {
    const raw = localStorage.getItem('authUser')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/75 p-4 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-extrabold text-white">{value}</p>
    </div>
  )
}

export default function ProfileStatsPage() {
  const apiBaseUrl = getApiBaseUrl()
  const [user] = useState(getStoredUser)
  const [stats, setStats] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!user) {
      window.location.assign('/')
      return
    }

    let isMounted = true

    async function loadStats() {
      setIsLoading(true)
      setError('')

      try {
        const requestStats = (accessToken) => {
          const headers = {}

          if (accessToken) {
            headers.Authorization = `Bearer ${accessToken}`
          }

          return fetch(`${apiBaseUrl}/users/${encodeURIComponent(String(user.id))}/stats`, {
            headers,
          })
        }

        let response = await requestStats(localStorage.getItem('accessToken'))

        if (response.status === 401) {
          const refreshedAccessToken = await tryRefreshAccessToken(apiBaseUrl, '/')

          if (!refreshedAccessToken) {
            throw new Error('Session expired. Please log in again.')
          }

          response = await requestStats(refreshedAccessToken)
        }

        const payload = await response.json().catch(() => null)

        if (!response.ok || payload?.ok !== true || !payload?.stats) {
          if (response.status === 401) {
            throw new Error('Session expired. Please log in again.')
          }

          throw new Error(
            response.status === 401
              ? 'Session expired. Please log in again.'
              : typeof payload?.error === 'string'
                ? payload.error
                : 'Could not load profile statistics'
          )
        }

        if (!isMounted) return
        setStats(payload.stats)
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Could not load profile statistics')

        if (loadError instanceof Error && loadError.message === 'Session expired. Please log in again.') {
          window.setTimeout(() => {
            window.location.assign('/')
          }, 900)
        }
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    loadStats()

    return () => {
      isMounted = false
    }
  }, [apiBaseUrl, user])

  if (!user) return null

  return (
    <div className="min-h-dvh overflow-y-auto bg-slate-950 text-slate-100">
      <Navbar />

      <section
        className="relative flex min-h-[calc(100dvh-4rem)] items-center justify-center overflow-hidden px-4 py-6"
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
            Profile Statistics
          </h1>
          <p className="mt-1 text-center text-xs text-slate-400">
            {stats?.username ? `Player: ${stats.username}` : `Player: ${user.username ?? user.email ?? ''}`}
          </p>

          {isLoading ? (
            <p className="mt-6 text-center text-sm text-slate-300">Loading statistics...</p>
          ) : error ? (
            <p className="mt-6 text-center text-sm text-rose-300">{error}</p>
          ) : (
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <StatCard label="Rating" value={Number(stats?.rating ?? 0)} />
              <StatCard label="Total Games" value={Number(stats?.total_games ?? 0)} />
              <StatCard label="Finished Games" value={Number(stats?.finished_games ?? 0)} />
<StatCard label="Created Games" value={Number(stats?.created_games ?? 0)} />
              <StatCard label="Rated Games" value={Number(stats?.rated_games_played ?? 0)} />
              <StatCard label="Unrated Games" value={Number(stats?.unrated_games_played ?? 0)} />
            </div>
          )}

          <div className="mt-6 flex justify-center">
            <a
              href="/profile"
              className="rounded-lg border border-slate-600 bg-slate-800/70 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-200 transition-colors duration-150 hover:border-slate-400 hover:text-white"
            >
              Back to Profile
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
