import { useCallback, useEffect, useRef, useState } from 'react'
import Navbar from '../components/Navbar.jsx'
import homeBackgroundImage from '../assets/images/2v2chess_home.png'
import { tryRefreshAccessToken } from '../authSession.js'

const DEFAULT_API_BASE_URL = 'http://localhost:3001'
const PLAY_NOW_PAYLOAD = {
  time_control: '5',
  increment: '0',
}

function getApiBaseUrl() {
  const configuredApiBaseUrl = typeof import.meta.env.VITE_API_BASE_URL === 'string'
    ? import.meta.env.VITE_API_BASE_URL.trim()
    : ''

  const resolvedApiBaseUrl = configuredApiBaseUrl || DEFAULT_API_BASE_URL
  return resolvedApiBaseUrl.endsWith('/') ? resolvedApiBaseUrl.slice(0, -1) : resolvedApiBaseUrl
}

function GuideIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 4h9a3 3 0 0 1 3 3v13H9a3 3 0 0 0-3 3V4z" />
      <path d="M6 4v16" />
    </svg>
  )
}

function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 text-sky-300" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M8 4h8v3a4 4 0 0 1-8 0V4z" />
      <path d="M6 5H4a2 2 0 0 0 2 2" />
      <path d="M18 5h2a2 2 0 0 1-2 2" />
      <path d="M12 11v4" />
      <path d="M9 20h6" />
    </svg>
  )
}

function CommunityIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M8 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
      <path d="M16.5 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
      <path d="M3.5 19a4.5 4.5 0 0 1 9 0" />
      <path d="M13.5 19a3.5 3.5 0 0 1 7 0" />
    </svg>
  )
}

function getStoredUser() {
  try {
    const raw = localStorage.getItem('authUser')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function WatchLiveOverlay({ apiBaseUrl, onCancel }) {
  const [liveGames, setLiveGames] = useState([])
  const [loading, setLoading] = useState(true)
  const cancelledRef = useRef(false)
  const timerRef = useRef(null)

  useEffect(() => {
    cancelledRef.current = false

    const poll = async () => {
      if (cancelledRef.current) return
      try {
        const res = await fetch(`${apiBaseUrl}/games/spectate`)
        const data = await res.json().catch(() => null)
        if (!cancelledRef.current && data?.ok && Array.isArray(data.games)) {
          setLiveGames(data.games)
          setLoading(false)
        }
      } catch {}
      if (!cancelledRef.current) {
        timerRef.current = window.setTimeout(poll, 5000)
      }
    }

    void poll()

    return () => {
      cancelledRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [apiBaseUrl])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-700/60 bg-slate-900 p-6 shadow-2xl">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="absolute right-4 top-4 text-slate-400 transition-colors hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <h2 className="mb-4 flex items-center gap-2 text-base font-bold text-white">
          <span className={`inline-block h-2 w-2 rounded-full ${liveGames.length > 0 ? 'bg-rose-500 animate-pulse' : 'bg-slate-600'}`} />
          Live Games
        </h2>

        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">Loading...</p>
        ) : liveGames.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">No live games right now. Check back soon!</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-700/60">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700/50 text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2.5 text-left font-medium">Game</th>
                  <th className="px-4 py-2.5 text-left font-medium">Team A</th>
                  <th className="px-4 py-2.5 text-center font-medium text-slate-500">vs</th>
                  <th className="px-4 py-2.5 text-left font-medium">Team B</th>
                  <th className="px-4 py-2.5 text-right font-medium">Watch</th>
                </tr>
              </thead>
              <tbody>
                {liveGames.map((game, idx) => {
                  const teams = Array.isArray(game.teams) ? game.teams : []
                  const teamA = teams[0] ?? { team_name: 'Team A', members: [] }
                  const teamB = teams[1] ?? { team_name: 'Team B', members: [] }
                  const renderTeam = (team) => (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-semibold text-slate-300">{team.team_name}</span>
                      {(Array.isArray(team.members) ? team.members : []).map((m, i) => (
                        <span key={i} className="text-xs text-slate-400">
                          {m.is_bot
                            ? <span className="text-indigo-400">🤖 {m.username}</span>
                            : <span>{m.username} <span className="text-slate-500">({m.rating})</span></span>}
                        </span>
                      ))}
                    </div>
                  )
                  return (
                    <tr
                      key={game.game_id}
                      className={`border-b border-slate-700/30 transition-colors hover:bg-slate-800/40 ${idx === liveGames.length - 1 ? 'border-b-0' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{game.game_name || 'Chess Room'}</div>
                        <div className="text-xs text-slate-500">{game.time_control}+{game.increment}</div>
                      </td>
                      <td className="px-4 py-3">{renderTeam(teamA)}</td>
                      <td className="px-4 py-3 text-center text-slate-600 font-bold">vs</td>
                      <td className="px-4 py-3">{renderTeam(teamB)}</td>
                      <td className="px-4 py-3 text-right">
                        <a
                          href={`/game/${encodeURIComponent(String(game.game_id))}`}
                          className="inline-flex items-center gap-1 rounded-lg bg-sky-600/30 border border-sky-500/40 px-3 py-1.5 text-xs font-semibold text-sky-300 transition-colors hover:bg-sky-600/50 hover:text-sky-200"
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                          Watch
                        </a>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <button
          type="button"
          onClick={onCancel}
          className="mt-4 w-full rounded-lg border border-slate-700 bg-slate-800 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-700"
        >
          Close
        </button>
      </div>
    </div>
  )
}

function QuickJoinOverlay({ apiBaseUrl, onCancel }) {
  const [stats, setStats] = useState({ active_games: null, open_lobbies: null })
  const [statusMsg, setStatusMsg] = useState('Searching for an open lobby...')
  const cancelledRef = useRef(false)
  const timerRef = useRef(null)

  useEffect(() => {
    cancelledRef.current = false

    const poll = async () => {
      if (cancelledRef.current) return

      try {
        const statsRes = await fetch(`${apiBaseUrl}/stats`)
        const statsData = await statsRes.json().catch(() => null)
        if (!cancelledRef.current && statsData?.ok) {
          setStats({ active_games: statsData.active_games, open_lobbies: statsData.open_lobbies })
        }
      } catch {}

      if (cancelledRef.current) return

      try {
        const accessToken = localStorage.getItem('accessToken')
        const res = await fetch(`${apiBaseUrl}/games/public`, {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        })
        const payload = await res.json().catch(() => null)
        if (!cancelledRef.current && res.ok && payload?.ok && Array.isArray(payload?.games) && payload.games.length > 0) {
          setStatusMsg('Found a lobby! Redirecting...')
          const game = payload.games[0]
          window.setTimeout(() => {
            window.location.assign(`/create?gameId=${encodeURIComponent(String(game.game_id))}`)
          }, 700)
          return
        }
      } catch {}

      if (!cancelledRef.current) {
        timerRef.current = window.setTimeout(poll, 1500)
      }
    }

    void poll()

    return () => {
      cancelledRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [apiBaseUrl])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div className="relative w-full max-w-sm rounded-2xl border border-slate-700/60 bg-slate-900 p-8 text-center shadow-2xl">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel search"
          className="absolute right-4 top-4 text-slate-400 transition-colors hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <div className="relative mx-auto mb-6 flex h-16 w-16 items-center justify-center">
          <div className="absolute h-16 w-16 animate-ping rounded-full bg-sky-500/30" />
          <div className="relative h-10 w-10 rounded-full bg-sky-500/20 flex items-center justify-center">
            <div className="h-5 w-5 rounded-full bg-sky-400" />
          </div>
        </div>

        <h2 className="text-lg font-bold text-white">{statusMsg}</h2>
        <p className="mt-1 text-xs text-slate-400">You'll be redirected automatically when a public lobby is available.</p>

        <div className="mt-6 flex items-center justify-center gap-8">
          <div className="text-center">
            <p className="text-2xl font-bold text-sky-400">
              {stats.active_games !== null ? stats.active_games : '—'}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">Active Games</p>
          </div>
          <div className="h-10 w-px bg-slate-700" />
          <div className="text-center">
            <p className="text-2xl font-bold text-emerald-400">
              {stats.open_lobbies !== null ? stats.open_lobbies : '—'}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">Open Lobbies</p>
          </div>
        </div>

        <button
          type="button"
          onClick={onCancel}
          className="mt-6 w-full rounded-lg border border-slate-700 bg-slate-800 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-700"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const apiBaseUrl = getApiBaseUrl()
  const [user] = useState(getStoredUser)
  const [isCreatingGame, setIsCreatingGame] = useState(false)
  const [showQuickJoinOverlay, setShowQuickJoinOverlay] = useState(false)
  const [showWatchLiveOverlay, setShowWatchLiveOverlay] = useState(false)
  const [playNowStatus, setPlayNowStatus] = useState({ tone: 'idle', message: '' })
  const [activeSession, setActiveSession] = useState(null)
  const [isLoadingActiveSession, setIsLoadingActiveSession] = useState(false)

  useEffect(() => {
    if (!user) {
      window.location.assign('/')
    }
  }, [user])

  const refreshAccessToken = useCallback(async () => {
    return tryRefreshAccessToken(apiBaseUrl, '/')
  }, [apiBaseUrl])

  const requestCreateGame = useCallback(async (accessToken) => {
    return fetch(`${apiBaseUrl}/games`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(PLAY_NOW_PAYLOAD),
    })
  }, [apiBaseUrl])

  const requestGetMyActiveGame = useCallback(async (accessToken) => {
    return fetch(`${apiBaseUrl}/games/active/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  }, [apiBaseUrl])

  useEffect(() => {
    if (!user) {
      return
    }

    let cancelled = false

    const loadActiveSession = async () => {
      const accessToken = localStorage.getItem('accessToken')

      if (!accessToken) {
        if (!cancelled) {
          setActiveSession(null)
        }
        return
      }

      setIsLoadingActiveSession(true)

      try {
        let response = await requestGetMyActiveGame(accessToken)
        let payload = await response.json().catch(() => null)

        if (response.status === 401) {
          const refreshedAccessToken = await refreshAccessToken()

          if (refreshedAccessToken) {
            response = await requestGetMyActiveGame(refreshedAccessToken)
            payload = await response.json().catch(() => null)
          }
        }

        if (!response.ok || payload?.ok !== true) {
          if (!cancelled) {
            setActiveSession(null)
          }
          return
        }

        const nextActiveGame = payload?.active_game && typeof payload.active_game === 'object'
          ? payload.active_game
          : null

        if (!cancelled) {
          setActiveSession(nextActiveGame)
        }
      } catch {
        if (!cancelled) {
          setActiveSession(null)
        }
      } finally {
        if (!cancelled) {
          setIsLoadingActiveSession(false)
        }
      }
    }

    void loadActiveSession()

    return () => {
      cancelled = true
    }
  }, [refreshAccessToken, requestGetMyActiveGame, user])

  const handleQuickJoin = () => {
    const accessToken = localStorage.getItem('accessToken')
    if (!accessToken) {
      setPlayNowStatus({ tone: 'error', message: 'Log in first to quick join.' })
      return
    }
    setPlayNowStatus({ tone: 'idle', message: '' })
    setShowQuickJoinOverlay(true)
  }

  const handlePlayNow = async () => {
    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setPlayNowStatus({ tone: 'error', message: 'Log in first to start a game.' })
      return
    }

    setIsCreatingGame(true)
    setPlayNowStatus({ tone: 'pending', message: 'Creating lobby...' })

    try {
      let response = await requestCreateGame(accessToken)
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken()

        if (refreshedAccessToken) {
          response = await requestCreateGame(refreshedAccessToken)
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok || payload?.ok !== true || !payload?.game) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not start a game')
      }

      const gameId = payload.game.game_id
      setPlayNowStatus({
        tone: 'success',
        message: Number.isInteger(gameId)
          ? `Game started (ID #${gameId}). Redirecting...`
          : 'Game started. Redirecting...',
      })

      window.setTimeout(() => {
        window.location.assign(Number.isInteger(gameId) ? `/create?gameId=${gameId}` : '/create')
      }, 200)
    } catch (error) {
      setPlayNowStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not start a game',
      })
    } finally {
      setIsCreatingGame(false)
    }
  }

  if (!user) return null

  return (
    <div className="min-h-dvh overflow-y-auto bg-slate-950 text-slate-100">
      {showQuickJoinOverlay && (
        <QuickJoinOverlay
          apiBaseUrl={apiBaseUrl}
          onCancel={() => setShowQuickJoinOverlay(false)}
        />
      )}
      {showWatchLiveOverlay && (
        <WatchLiveOverlay
          apiBaseUrl={apiBaseUrl}
          onCancel={() => setShowWatchLiveOverlay(false)}
        />
      )}
      <Navbar />

      <section
        className="relative min-h-[calc(100dvh-4rem)] overflow-hidden"
        style={{
          backgroundImage: `url(${homeBackgroundImage})`,
          backgroundPosition: 'center',
          backgroundSize: 'cover',
          backgroundRepeat: 'no-repeat',
        }}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/75 via-slate-950/70 to-slate-950/85" />
        <div className="pointer-events-none absolute -left-20 -top-24 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -right-16 h-80 w-80 rounded-full bg-violet-500/20 blur-3xl" />

        <div className="relative z-10 mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-6xl flex-col px-4 py-8 md:py-10">
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <h1 className="text-4xl font-extrabold uppercase tracking-[0.22em] text-white drop-shadow-[0_0_20px_rgba(148,163,184,0.28)] md:text-6xl">
              2V2 CHESS
            </h1>
            <p className="mt-4 max-w-xl text-sm text-slate-300 md:text-base">
              Two boards, one team. Play together and share your captured pieces.
            </p>

            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={handlePlayNow}
                disabled={isCreatingGame}
                className="rounded-lg bg-emerald-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/25 transition-all duration-150 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isCreatingGame ? 'Creating...' : 'Create Lobby'}
              </button>
              <button
                type="button"
                onClick={handleQuickJoin}
                disabled={isCreatingGame}
                className="rounded-lg bg-sky-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition-all duration-150 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-70"
              >
                Quick Join
              </button>
              {activeSession?.route ? (
                <a
                  href={activeSession.route}
                  className="rounded-lg bg-indigo-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-150 hover:bg-indigo-400"
                >
                  {activeSession.status === 'started' ? 'Continue Active Game' : 'Continue Active Lobby'}
                </a>
              ) : null}
              <button
                type="button"
                onClick={() => setShowWatchLiveOverlay(true)}
                className="rounded-lg bg-slate-300/90 px-6 py-2.5 text-sm font-semibold text-slate-900 transition-all duration-150 hover:bg-slate-200"
              >
                Watch Live
              </button>
            </div>

            {isLoadingActiveSession ? (
              <p className="mt-2 text-xs text-slate-400">Checking active session...</p>
            ) : null}

            {playNowStatus.message ? (
              <p
                className={`mt-3 text-xs ${
                  playNowStatus.tone === 'error'
                    ? 'text-rose-300'
                    : playNowStatus.tone === 'success'
                      ? 'text-emerald-300'
                      : 'text-slate-300'
                }`}
              >
                {playNowStatus.message}
              </p>
            ) : null}
          </div>

          <div className="grid w-full gap-4 pb-2 md:grid-cols-3">

            <div className="rounded-xl border border-slate-700/60 bg-slate-900/75 p-4 shadow-xl shadow-black/40">
              <div className="flex items-center gap-2">
                <GuideIcon />
                <h2 className="text-sm font-bold uppercase tracking-wide text-white">How to Play</h2>
              </div>
              <p className="mt-2 text-xs text-slate-300">
                Learn rules, piece drops, and team strategy before your first match.
              </p>
              <a
                href="/how-to-play"
                className="mt-4 inline-block rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-white transition-colors duration-150 hover:bg-emerald-400"
              >
                Learn
              </a>
            </div>

            <div className="rounded-xl border border-slate-700/60 bg-slate-900/75 p-4 shadow-xl shadow-black/40">
              <div className="flex items-center gap-2">
                <TrophyIcon />
                <h2 className="text-sm font-bold uppercase tracking-wide text-white">Top Players</h2>
              </div>
              <p className="mt-2 text-xs text-slate-300">
                See who dominates the ladder and track the highest ratings.
              </p>
              <a
                href="/leaderboards"
                className="mt-4 inline-block rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-white transition-colors duration-150 hover:bg-sky-400"
              >
                View
              </a>
            </div>

            <div className="rounded-xl border border-slate-700/60 bg-slate-900/75 p-4 shadow-xl shadow-black/40">
              <div className="flex items-center gap-2">
                <CommunityIcon />
                <h2 className="text-sm font-bold uppercase tracking-wide text-white">Join the Community</h2>
              </div>
              <p className="mt-2 text-xs text-slate-300">
                Connect with players, find teammates, and follow match discussions.
              </p>
              <a
                href="https://discord.gg/ec9wDt76kr"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-block rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-white transition-colors duration-150 hover:bg-emerald-400"
              >
                Join
              </a>
            </div>
          </div>

        </div>
      </section>
    </div>
  )
}
