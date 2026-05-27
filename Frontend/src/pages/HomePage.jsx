import { useEffect, useRef, useState } from 'react'
import { GoogleLogin } from '@react-oauth/google'
import Navbar from '../components/Navbar.jsx'
import homeBackgroundImage from '../assets/images/2v2chess_home.png'

const DEFAULT_API_BASE_URL = 'http://localhost:3001'

function getApiBaseUrl() {
  const configuredApiBaseUrl = typeof import.meta.env.VITE_API_BASE_URL === 'string'
    ? import.meta.env.VITE_API_BASE_URL.trim()
    : ''

  const resolvedApiBaseUrl = configuredApiBaseUrl || DEFAULT_API_BASE_URL
  return resolvedApiBaseUrl.endsWith('/') ? resolvedApiBaseUrl.slice(0, -1) : resolvedApiBaseUrl
}

function getGoogleClientId() {
  return typeof import.meta.env.VITE_GOOGLE_CLIENT_ID === 'string'
    ? import.meta.env.VITE_GOOGLE_CLIENT_ID.trim()
    : ''
}

function resolvePostLoginPath() {
  if (typeof window === 'undefined') {
    return '/home'
  }

  const searchParams = new URLSearchParams(window.location.search)
  const requestedRedirect = searchParams.get('redirect')
  const normalizedRedirect = typeof requestedRedirect === 'string' ? requestedRedirect.trim() : ''

  if (normalizedRedirect.startsWith('/')) {
    return normalizedRedirect
  }

  return '/home'
}

function resolveRequestedRedirectPath() {
  if (typeof window === 'undefined') {
    return ''
  }

  const searchParams = new URLSearchParams(window.location.search)
  const requestedRedirect = searchParams.get('redirect')
  const normalizedRedirect = typeof requestedRedirect === 'string' ? requestedRedirect.trim() : ''

  if (normalizedRedirect.startsWith('/') && !normalizedRedirect.startsWith('//')) {
    return normalizedRedirect
  }

  return ''
}

function persistSession({ accessToken, refreshToken, user }) {
  localStorage.setItem('accessToken', accessToken)
  localStorage.setItem('refreshToken', refreshToken)
  localStorage.setItem('authUser', JSON.stringify(user))
}

function SocialButton({ label, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-600 bg-slate-800/80 shadow-sm transition-transform duration-150 hover:scale-105 hover:bg-slate-700/80"
    >
      {children}
    </button>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.44a5.5 5.5 0 0 1-2.39 3.61v2.99h3.87c2.26-2.08 3.57-5.15 3.57-8.84z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.95-2.91l-3.87-2.99c-1.08.72-2.45 1.16-4.08 1.16-3.13 0-5.78-2.11-6.73-4.96H1.27v3.12A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.3A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.3V6.58H1.27A12 12 0 0 0 0 12c0 1.94.46 3.78 1.27 5.42l4-3.12z"
      />
      <path
        fill="#EA4335"
        d="M12 4.74c1.76 0 3.34.61 4.58 1.82l3.43-3.43C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.58l4 3.12c.95-2.85 3.6-4.96 6.73-4.96z"
      />
    </svg>
  )
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#1877F2"
        d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073c0 6.027 4.388 11.02 10.125 11.927v-8.43H7.078v-3.497h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.497h-2.796v8.43C19.612 23.093 24 18.1 24 12.073z"
      />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
      <path d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12 18 18.75 12 18.75 2.25 12 2.25 12z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
      <path d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12 18 18.75 12 18.75 2.25 12 2.25 12z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
      <path d="M4 20 20 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
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

export default function HomePage() {
  const apiBaseUrl = getApiBaseUrl()
  const [authMode, setAuthMode] = useState('login')
  const [showWatchLive, setShowWatchLive] = useState(false)
  const googleClientId = getGoogleClientId()
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [showLoginPassword, setShowLoginPassword] = useState(false)
  const [loginStatus, setLoginStatus] = useState({ tone: 'idle', message: '' })
  const [isLoginSubmitting, setIsLoginSubmitting] = useState(false)
  const [registerUsername, setRegisterUsername] = useState('')
  const [registerEmail, setRegisterEmail] = useState('')
  const [registerPassword, setRegisterPassword] = useState('')
  const [registerRepeatPassword, setRegisterRepeatPassword] = useState('')
  const [showRegisterPassword, setShowRegisterPassword] = useState(false)
  const [showRegisterRepeatPassword, setShowRegisterRepeatPassword] = useState(false)
  const [registerStatus, setRegisterStatus] = useState({ tone: 'idle', message: '' })
  const [isRegisterSubmitting, setIsRegisterSubmitting] = useState(false)
  const [socialStatus, setSocialStatus] = useState({ tone: 'idle', message: '' })

  const startSocialLogin = (provider) => {
    const requestedRedirect = resolveRequestedRedirectPath()
    const socialLoginUrl = new URL(`${apiBaseUrl}/auth/${provider}`)

    if (requestedRedirect) {
      socialLoginUrl.searchParams.set('redirect', requestedRedirect)
    }

    window.location.assign(socialLoginUrl.toString())
  }

  const handleLoginSubmit = async (event) => {
    event.preventDefault()

    const normalizedEmail = typeof loginEmail === 'string' ? loginEmail.trim().toLowerCase() : ''
    const normalizedPassword = typeof loginPassword === 'string' ? loginPassword.trim() : ''

    if (!normalizedEmail || !normalizedPassword) {
      setLoginStatus({ tone: 'error', message: 'Email and password are required.' })
      return
    }

    setIsLoginSubmitting(true)
    setLoginStatus({ tone: 'pending', message: 'Logging in...' })

    try {
      const response = await fetch(`${apiBaseUrl}/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: normalizedEmail,
          password: normalizedPassword,
        }),
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not log in')
      }

      persistSession({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        user: payload.user,
      })

      setLoginStatus({ tone: 'success', message: 'Login successful.' })
      const postLoginPath = resolvePostLoginPath()
      window.setTimeout(() => {
        window.location.assign(postLoginPath)
      }, 600)
    } catch (error) {
      setLoginStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not log in',
      })
    } finally {
      setIsLoginSubmitting(false)
    }
  }

  const handleRegisterSubmit = async (event) => {
    event.preventDefault()

    const normalizedUsername = typeof registerUsername === 'string' ? registerUsername.trim() : ''
    const normalizedEmail = typeof registerEmail === 'string' ? registerEmail.trim().toLowerCase() : ''
    const normalizedPassword = typeof registerPassword === 'string' ? registerPassword.trim() : ''
    const normalizedRepeatPassword = typeof registerRepeatPassword === 'string' ? registerRepeatPassword.trim() : ''

    if (!normalizedUsername || !normalizedEmail || !normalizedPassword || !normalizedRepeatPassword) {
      setRegisterStatus({ tone: 'error', message: 'Username, email and password are required.' })
      return
    }

    if (normalizedPassword !== normalizedRepeatPassword) {
      setRegisterStatus({ tone: 'error', message: 'Passwords do not match.' })
      return
    }

    setIsRegisterSubmitting(true)
    setRegisterStatus({ tone: 'pending', message: 'Creating account...' })

    try {
      const response = await fetch(`${apiBaseUrl}/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: normalizedUsername,
          email: normalizedEmail,
          password: normalizedPassword,
        }),
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not register')
      }

      setRegisterStatus({ tone: 'success', message: 'Account created. Check your email for verification, then log in.' })
      setLoginEmail(normalizedEmail)
      setLoginPassword('')
      setRegisterPassword('')
      setRegisterRepeatPassword('')
      window.setTimeout(() => {
        setAuthMode('login')
        setLoginStatus({ tone: 'success', message: 'Account created. Please verify email before login.' })
      }, 600)
    } catch (error) {
      setRegisterStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not register',
      })
    } finally {
      setIsRegisterSubmitting(false)
    }
  }

  const handleGoogleSuccess = async (credentialResponse) => {
    const idToken = typeof credentialResponse?.credential === 'string' ? credentialResponse.credential.trim() : ''

    if (!idToken) {
      setSocialStatus({ tone: 'error', message: 'Google login did not return a credential.' })
      return
    }

    setSocialStatus({ tone: 'pending', message: 'Signing in with Google...' })

    try {
      const response = await fetch(`${apiBaseUrl}/auth/google/id-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ idToken }),
      })

      const payload = await response.json()

      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Google login failed')
      }

      persistSession({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        user: payload.user,
      })

      setSocialStatus({ tone: 'success', message: 'Google login successful.' })
      const postLoginPath = resolvePostLoginPath()
      window.setTimeout(() => {
        window.location.assign(postLoginPath)
      }, 600)
    } catch (error) {
      setSocialStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Google login failed',
      })
    }
  }

  const handleGoogleError = () => {
    setSocialStatus({ tone: 'error', message: 'Google login was cancelled or failed.' })
  }

  return (
    <div className="h-dvh overflow-hidden bg-slate-950 text-slate-100">
      {showWatchLive && (
        <WatchLiveOverlay apiBaseUrl={apiBaseUrl} onCancel={() => setShowWatchLive(false)} />
      )}
      <Navbar />

      {/* Full-screen background */}
      <section
        className="relative flex h-[calc(100dvh-4rem)] items-center justify-center overflow-hidden"
        style={{
          backgroundImage: `url(${homeBackgroundImage})`,
          backgroundPosition: 'center',
          backgroundSize: 'cover',
          backgroundRepeat: 'no-repeat',
        }}
      >
        {/* Dark overlay */}
        <div className="absolute inset-0 bg-slate-950/65" />

        {/* Glass card */}
        <div className="relative z-10 flex w-full max-w-3xl overflow-hidden rounded-2xl shadow-2xl shadow-black/50"
             style={{ backdropFilter: 'blur(16px)' }}>

          {/* Left — welcome */}
          <div className="flex w-1/2 flex-col items-center justify-center gap-5 bg-slate-900/70 px-8 py-10 text-center border-r border-slate-700/50">
            <h1 className="text-2xl font-extrabold uppercase tracking-widest text-white">
              2v2 Chess
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed">
              Join thousands of players in 2v2 bughouse battles. Play with friends, drop captured pieces, and win together.
            </p>
            <button
              type="button"
              onClick={() => {
                setAuthMode('register')
                setRegisterStatus({ tone: 'idle', message: '' })
              }}
              className="w-full rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:from-indigo-500 hover:to-violet-500 transition-all duration-150 shadow-md"
            >
              Create Free Account
            </button>
            <button
              type="button"
              onClick={() => setShowWatchLive(true)}
              className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-5 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-700/60 transition-all duration-150"
            >
              Watch Live
            </button>
            <a
              href="/how-to-play"
              className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-5 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-700/60 transition-all duration-150 text-center"
            >
              How to Play
            </a>
          </div>

          {/* Right — login form */}
          <div className="flex w-1/2 flex-col gap-4 bg-slate-900/80 px-8 py-10">
            <h2 className="text-lg font-extrabold uppercase tracking-widest text-white text-center">
              {authMode === 'register' ? 'Register' : 'Login'}
            </h2>

            {authMode === 'register' ? (
              <form className="flex flex-col gap-3" onSubmit={handleRegisterSubmit}>
                <input
                  type="text"
                  placeholder="Username"
                  autoComplete="off"
                  value={registerUsername}
                  onChange={(event) => setRegisterUsername(event.target.value)}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                />
                <input
                  type="email"
                  placeholder="Email"
                  value={registerEmail}
                  onChange={(event) => setRegisterEmail(event.target.value)}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                />
                <div className="relative">
                  <input
                    type={showRegisterPassword ? 'text' : 'password'}
                    placeholder="Password"
                    value={registerPassword}
                    onChange={(event) => setRegisterPassword(event.target.value)}
                    className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 pr-11 text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                  />
                  <button
                    type="button"
                    onClick={() => setShowRegisterPassword((previousState) => !previousState)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-slate-600/80 bg-slate-900/80 p-1 text-slate-100 transition-colors hover:border-slate-400/80 hover:bg-slate-900/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70"
                    aria-label={showRegisterPassword ? 'Hide password' : 'Show password'}
                  >
                    {showRegisterPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showRegisterRepeatPassword ? 'text' : 'password'}
                    placeholder="Repeat password"
                    value={registerRepeatPassword}
                    onChange={(event) => setRegisterRepeatPassword(event.target.value)}
                    className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 pr-11 text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                  />
                  <button
                    type="button"
                    onClick={() => setShowRegisterRepeatPassword((previousState) => !previousState)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-slate-600/80 bg-slate-900/80 p-1 text-slate-100 transition-colors hover:border-slate-400/80 hover:bg-slate-900/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70"
                    aria-label={showRegisterRepeatPassword ? 'Hide repeated password' : 'Show repeated password'}
                  >
                    {showRegisterRepeatPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={isRegisterSubmitting}
                  className="w-full rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:from-indigo-500 hover:to-violet-500 transition-all duration-150 shadow-md disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isRegisterSubmitting ? 'Creating account...' : 'Create account'}
                </button>

                {registerStatus.message ? (
                  <p
                    className={`text-center text-xs ${
                      registerStatus.tone === 'error'
                        ? 'text-rose-300'
                        : registerStatus.tone === 'success'
                          ? 'text-emerald-300'
                          : 'text-slate-300'
                    }`}
                  >
                    {registerStatus.message}
                  </p>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('login')
                    setRegisterStatus({ tone: 'idle', message: '' })
                  }}
                  className="text-xs text-slate-400 transition-colors hover:text-slate-200"
                >
                  Already have an account?{' '}
                  <span className="font-bold text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
                    Log in
                  </span>
                </button>
              </form>
            ) : (
              <form className="flex flex-col gap-3" onSubmit={handleLoginSubmit}>
              <input
                type="email"
                placeholder="Email"
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
              />
              <div>
                <div className="relative">
                  <input
                    type={showLoginPassword ? 'text' : 'password'}
                    placeholder="Password"
                    value={loginPassword}
                    onChange={(event) => setLoginPassword(event.target.value)}
                    className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 pr-11 text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginPassword((previousState) => !previousState)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-slate-600/80 bg-slate-900/80 p-1 text-slate-100 transition-colors hover:border-slate-400/80 hover:bg-slate-900/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70"
                    aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                  >
                    {showLoginPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
                <div className="mt-1 text-right">
                  <a href="/forgot-password" className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
                    Forgot password?
                  </a>
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoginSubmitting}
                className="w-full rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:from-indigo-500 hover:to-violet-500 transition-all duration-150 shadow-md disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isLoginSubmitting ? 'Logging in...' : 'Log In'}
              </button>

              {loginStatus.message ? (
                <p
                  className={`text-center text-xs ${
                    loginStatus.tone === 'error'
                      ? 'text-rose-300'
                      : loginStatus.tone === 'success'
                        ? 'text-emerald-300'
                        : 'text-slate-300'
                  }`}
                >
                  {loginStatus.message}
                </p>
              ) : null}
              </form>
            )}

            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-slate-700" />
              <span className="text-xs text-slate-500 uppercase tracking-wide">or log in with</span>
              <div className="h-px flex-1 bg-slate-700" />
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3">
              {/* Google */}
              {googleClientId ? (
                <div className="relative h-9 w-9">
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-full border border-slate-600 bg-slate-800/80 shadow-sm">
                    <GoogleIcon />
                  </div>
                  <div className="absolute inset-0 overflow-hidden rounded-full opacity-0">
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={handleGoogleError}
                      type="icon"
                      theme="outline"
                      shape="circle"
                      size="medium"
                    />
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  Google client ID missing
                </div>
              )}
              {/* Facebook */}
              <SocialButton label="Sign in with Facebook" onClick={() => startSocialLogin('facebook')}>
                <FacebookIcon />
              </SocialButton>
            </div>

            {socialStatus.message ? (
              <p
                className={`text-center text-xs ${
                  socialStatus.tone === 'error'
                    ? 'text-rose-300'
                    : socialStatus.tone === 'success'
                      ? 'text-emerald-300'
                      : 'text-slate-300'
                }`}
              >
                {socialStatus.message}
              </p>
            ) : null}
          </div>

        </div>
      </section>
    </div>
  )
}
