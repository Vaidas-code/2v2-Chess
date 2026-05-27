import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
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

function normalizePositiveInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }

  if (typeof value !== 'string') {
    return null
  }

  const normalizedValue = value.trim()
  if (!normalizedValue) {
    return null
  }

  const parsedValue = Number(normalizedValue)
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null
}

async function requestInvitedGame(apiBaseUrl, accessToken, inviteToken) {
  return fetch(`${apiBaseUrl}/invite/${encodeURIComponent(inviteToken)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

export default function InviteRedirectPage() {
  const apiBaseUrl = getApiBaseUrl()
  const navigate = useNavigate()
  const { inviteToken: rawInviteToken } = useParams()
  const inviteToken = useMemo(() => (typeof rawInviteToken === 'string' ? rawInviteToken.trim() : ''), [rawInviteToken])
  const [status, setStatus] = useState({ tone: 'pending', message: 'Opening invite...' })

  useEffect(() => {
    const returnPath = `${window.location.pathname}${window.location.search}`

    if (!inviteToken) {
      setStatus({ tone: 'error', message: 'Invite link is invalid.' })
      return
    }

    const resolveInvite = async () => {
      const accessToken = localStorage.getItem('accessToken')
      const redirectToLogin = () => {
        const encodedReturnPath = encodeURIComponent(returnPath)
        window.location.assign(`/?redirect=${encodedReturnPath}`)
      }

      const redirectByAuthState = () => {
        const hasActiveAccessToken = typeof localStorage.getItem('accessToken') === 'string' && localStorage.getItem('accessToken').trim() !== ''
        const hasStoredAuthUser = typeof localStorage.getItem('authUser') === 'string' && localStorage.getItem('authUser').trim() !== ''

        if (hasActiveAccessToken && hasStoredAuthUser) {
          window.location.assign('/home')
          return
        }

        redirectToLogin()
      }

      if (!accessToken) {
        redirectToLogin()
        return
      }

      try {
        let activeToken = accessToken
        let response = await requestInvitedGame(apiBaseUrl, activeToken, inviteToken)
        let payload = await response.json().catch(() => null)

        if (response.status === 401) {
          const refreshedAccessToken = await tryRefreshAccessToken(apiBaseUrl, '/')

          if (refreshedAccessToken) {
            activeToken = refreshedAccessToken
            response = await requestInvitedGame(apiBaseUrl, activeToken, inviteToken)
            payload = await response.json().catch(() => null)
          }
        }

        if (response.status === 401) {
          redirectToLogin()
          return
        }

        if (response.status === 403 || response.status === 404) {
          redirectByAuthState()
          return
        }

        if (!response.ok || payload?.ok !== true || !payload?.game) {
          throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not open invite link')
        }

        const gameId = normalizePositiveInteger(payload.game.game_id)
        const gameStatus = typeof payload.game?.status === 'string' ? payload.game.status.trim().toLowerCase() : ''

        if (!gameId) {
          throw new Error('Invite did not return a valid game')
        }

        if (gameStatus === 'started') {
          setStatus({ tone: 'success', message: 'Invite accepted. Redirecting to game...' })
          window.setTimeout(() => {
            navigate(`/game/${encodeURIComponent(String(gameId))}`, { replace: true })
          }, 120)
          return
        }

        setStatus({ tone: 'success', message: 'Invite accepted. Redirecting to lobby...' })
        window.setTimeout(() => {
          navigate(`/create?gameId=${encodeURIComponent(String(gameId))}`, { replace: true })
        }, 200)
      } catch (error) {
        setStatus({
          tone: 'error',
          message: error instanceof Error ? error.message : 'Could not open invite link',
        })
      }
    }

    void resolveInvite()
  }, [apiBaseUrl, inviteToken, navigate])

  const accentClassName = status.tone === 'error'
    ? 'from-rose-500 to-orange-500'
    : status.tone === 'success'
      ? 'from-emerald-500 to-teal-500'
      : 'from-indigo-500 to-violet-500'

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
        <div className="absolute inset-0 bg-slate-950/70" />

        <div
          className="relative z-10 w-full max-w-lg rounded-2xl border border-slate-700/50 bg-slate-900/75 px-8 py-10 text-center shadow-2xl shadow-black/50"
          style={{ backdropFilter: 'blur(16px)' }}
        >
          <div className={`mx-auto mb-5 h-2 w-24 rounded-full bg-gradient-to-r ${accentClassName}`} />
          <h1 className="text-2xl font-extrabold tracking-wide text-white">Invite</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-300">{status.message}</p>

          {status.tone === 'error' ? (
            <button
              type="button"
              onClick={() => navigate('/home', { replace: true })}
              className="mt-6 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition-all duration-150 hover:from-indigo-500 hover:to-violet-500"
            >
              Back to Home
            </button>
          ) : null}
        </div>
      </section>
    </div>
  )
}
