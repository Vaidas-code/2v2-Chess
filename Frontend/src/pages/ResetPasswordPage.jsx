import { useMemo, useState } from 'react'
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

function getResetTokenFromUrl() {
  const searchParams = new URLSearchParams(window.location.search)
  const token = searchParams.get('token')
  return typeof token === 'string' ? token.trim() : ''
}

function EyeIcon({ isVisible }) {
  if (isVisible) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.77 21.77 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.32 21.32 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

export default function ResetPasswordPage() {
  const apiBaseUrl = getApiBaseUrl()
  const resetToken = useMemo(() => getResetTokenFromUrl(), [])

  const [password, setPassword] = useState('')
  const [repeatPassword, setRepeatPassword] = useState('')
  const [isPasswordVisible, setIsPasswordVisible] = useState(false)
  const [isRepeatPasswordVisible, setIsRepeatPasswordVisible] = useState(false)
  const [status, setStatus] = useState({ tone: resetToken ? 'idle' : 'error', message: resetToken ? '' : 'Reset token is missing.' })
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()

    if (!resetToken) {
      setStatus({ tone: 'error', message: 'Reset token is missing.' })
      return
    }

    const normalizedPassword = typeof password === 'string' ? password.trim() : ''
    const normalizedRepeatPassword = typeof repeatPassword === 'string' ? repeatPassword.trim() : ''

    if (!normalizedPassword || !normalizedRepeatPassword) {
      setStatus({ tone: 'error', message: 'Both password fields are required.' })
      return
    }

    if (normalizedPassword !== normalizedRepeatPassword) {
      setStatus({ tone: 'error', message: 'Passwords do not match.' })
      return
    }

    if (normalizedPassword.length < 8) {
      setStatus({ tone: 'error', message: 'Password must be at least 8 characters long.' })
      return
    }

    setIsSubmitting(true)
    setStatus({ tone: 'pending', message: 'Resetting password...' })

    try {
      const response = await fetch(`${apiBaseUrl}/password-resets/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: resetToken,
          password: normalizedPassword,
          repeatPassword: normalizedRepeatPassword,
        }),
      })

      const payload = await response.json()
      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not reset password')
      }

      setStatus({ tone: 'success', message: 'Password updated successfully. Redirecting to login...' })
      window.setTimeout(() => {
        window.location.assign('/')
      }, 1200)
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not reset password',
      })
    } finally {
      setIsSubmitting(false)
    }
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
        <div className="absolute inset-0 bg-slate-950/70" />

        <div
          className="relative z-10 w-full max-w-md rounded-2xl border border-slate-700/50 bg-slate-900/80 px-7 py-8 shadow-2xl shadow-black/50"
          style={{ backdropFilter: 'blur(16px)' }}
        >
          <h1 className="text-center text-xl font-extrabold uppercase tracking-widest text-white">Reset Password</h1>
          <p className="mt-3 text-center text-sm text-slate-300">
            Enter your new password and confirm it.
          </p>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <div className="relative">
              <input
                type={isPasswordVisible ? 'text' : 'password'}
                placeholder="New password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 pr-10 text-sm text-slate-100 placeholder-slate-400 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="button"
                onClick={() => setIsPasswordVisible((currentValue) => !currentValue)}
                aria-label={isPasswordVisible ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-300 transition-colors hover:text-white"
              >
                <EyeIcon isVisible={isPasswordVisible} />
              </button>
            </div>

            <div className="relative">
              <input
                type={isRepeatPasswordVisible ? 'text' : 'password'}
                placeholder="Repeat password"
                value={repeatPassword}
                onChange={(event) => setRepeatPassword(event.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 pr-10 text-sm text-slate-100 placeholder-slate-400 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="button"
                onClick={() => setIsRepeatPasswordVisible((currentValue) => !currentValue)}
                aria-label={isRepeatPasswordVisible ? 'Hide repeated password' : 'Show repeated password'}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-300 transition-colors hover:text-white"
              >
                <EyeIcon isVisible={isRepeatPasswordVisible} />
              </button>
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !resetToken}
              className="w-full rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition-all duration-150 hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSubmitting ? 'Saving...' : 'Set New Password'}
            </button>
          </form>

          {status.message ? (
            <p
              className={`mt-4 text-center text-xs ${
                status.tone === 'error'
                  ? 'text-rose-300'
                  : status.tone === 'success'
                    ? 'text-emerald-300'
                    : 'text-slate-300'
              }`}
            >
              {status.message}
            </p>
          ) : null}

          <div className="mt-5 text-center">
            <a href="/" className="text-xs text-slate-300 transition-colors hover:text-white">
              Back to login
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
