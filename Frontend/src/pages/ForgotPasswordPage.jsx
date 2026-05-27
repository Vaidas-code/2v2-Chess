import { useState } from 'react'
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

export default function ForgotPasswordPage() {
  const apiBaseUrl = getApiBaseUrl()
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState({ tone: 'idle', message: '' })
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()

    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
    if (!normalizedEmail) {
      setStatus({ tone: 'error', message: 'Email is required.' })
      return
    }

    setIsSubmitting(true)
    setStatus({ tone: 'pending', message: 'Sending reset link...' })

    try {
      const response = await fetch(`${apiBaseUrl}/password-resets/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: normalizedEmail }),
      })

      const payload = await response.json()
      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not request password reset')
      }

      setStatus({
        tone: 'success',
        message: typeof payload?.message === 'string'
          ? payload.message
          : 'If an account exists, a reset link has been sent.',
      })
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not request password reset',
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
          <h1 className="text-center text-xl font-extrabold uppercase tracking-widest text-white">Forgot Password</h1>
          <p className="mt-3 text-center text-sm text-slate-300">
            Enter your account email and we will send you a reset link.
          </p>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-400 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition-all duration-150 hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSubmitting ? 'Sending...' : 'Send Reset Link'}
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
