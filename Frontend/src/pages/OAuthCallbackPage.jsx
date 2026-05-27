import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router'
import Navbar from '../components/Navbar.jsx'
import homeBackgroundImage from '../assets/images/2v2chess_home.png'

function parseOAuthFragment() {
  const fragment = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
  return new URLSearchParams(fragment)
}

function normalizeRedirectPath(value) {
  const normalizedValue = typeof value === 'string' ? value.trim() : ''

  if (!normalizedValue || !normalizedValue.startsWith('/')) {
    return '/home'
  }

  if (normalizedValue.startsWith('//')) {
    return '/home'
  }

  return normalizedValue
}

function capitalizeProvider(provider) {
  if (typeof provider !== 'string' || provider.trim() === '') {
    return 'Social'
  }

  const normalized = provider.trim().toLowerCase()
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function persistSession({ accessToken, refreshToken, user }) {
  localStorage.setItem('accessToken', accessToken)
  localStorage.setItem('refreshToken', refreshToken)
  localStorage.setItem('authUser', JSON.stringify(user))
}

function getOAuthCallbackResult() {
  const params = parseOAuthFragment()
  const status = params.get('status')
  const provider = params.get('provider') || 'social'
  const providerName = capitalizeProvider(provider)
  const postLoginPath = normalizeRedirectPath(params.get('redirect'))

  if (status !== 'success') {
    return {
      provider,
      shouldPersistSession: false,
      sessionPayload: null,
      postLoginPath,
      viewState: {
        status: 'error',
        title: `${providerName} login failed`,
        message: params.get('error') || 'Could not complete your social login.',
      },
    }
  }

  const accessToken = params.get('accessToken')
  const refreshToken = params.get('refreshToken')

  if (!accessToken || !refreshToken) {
    return {
      provider,
      shouldPersistSession: false,
      sessionPayload: null,
      postLoginPath,
      viewState: {
        status: 'error',
        title: 'Login failed',
        message: 'OAuth tokens were not returned by the server.',
      },
    }
  }

  const user = {
    id: params.get('userId') || '',
    email: params.get('email') || '',
    username: params.get('username') || '',
    avatar: params.get('avatar') || null,
  }

  return {
    provider,
    shouldPersistSession: true,
    sessionPayload: { accessToken, refreshToken, user },
    postLoginPath,
    viewState: {
      status: 'success',
      title: `${providerName} login successful`,
      message: user.email ? `Signed in as ${user.email}. Redirecting...` : 'Redirecting...',
    },
  }
}

export default function OAuthCallbackPage() {
  const navigate = useNavigate()
  const callbackResult = useMemo(() => getOAuthCallbackResult(), [])
  const viewState = callbackResult.viewState

  useEffect(() => {
    if (callbackResult.shouldPersistSession && callbackResult.sessionPayload) {
      persistSession(callbackResult.sessionPayload)
    }

    window.history.replaceState(null, '', window.location.pathname)

    if (callbackResult.viewState.status === 'success') {
      const timeoutId = window.setTimeout(() => {
        navigate(callbackResult.postLoginPath || '/home', { replace: true })
      }, 1200)

      return () => {
        window.clearTimeout(timeoutId)
      }
    }

    return undefined
  }, [callbackResult, navigate])

  const accentClassName = viewState.status === 'error'
    ? 'from-rose-500 to-orange-500'
    : viewState.status === 'success'
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
          <h1 className="text-2xl font-extrabold tracking-wide text-white">{viewState.title}</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-300">{viewState.message}</p>

          {viewState.status === 'error' ? (
            <button
              type="button"
              onClick={() => navigate('/', { replace: true })}
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
