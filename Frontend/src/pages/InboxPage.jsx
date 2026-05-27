import { useEffect, useMemo, useState } from 'react'
import { io } from 'socket.io-client'
import Navbar from '../components/Navbar.jsx'
import homeBackgroundImage from '../assets/images/2v2chess_home.png'
import { clearAuthSession } from '../authSession.js'

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

async function requestInboxItems(apiBaseUrl, accessToken) {
  return fetch(`${apiBaseUrl}/inbox/items?limit=100`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

async function requestAcceptInvite(apiBaseUrl, accessToken, inboxItemId) {
  return fetch(`${apiBaseUrl}/inbox/items/${encodeURIComponent(String(inboxItemId))}/accept`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

async function requestDeleteInboxItem(apiBaseUrl, accessToken, inboxItemId) {
  return fetch(`${apiBaseUrl}/inbox/items/${encodeURIComponent(String(inboxItemId))}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

function formatReceivedAt(value) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return 'Unknown time'
  }

  return date.toLocaleString()
}

export default function InboxPage() {
  const apiBaseUrl = getApiBaseUrl()
  const [user] = useState(getStoredUser)
  const [items, setItems] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [status, setStatus] = useState({ tone: 'idle', message: '' })
  const [isWorkingItemId, setIsWorkingItemId] = useState(null)

  useEffect(() => {
    if (!user) {
      window.location.assign('/')
      return
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      clearAuthSession()
      window.location.assign('/')
      return
    }

    let isDisposed = false

    const loadInbox = async ({ silent = false } = {}) => {
      if (!silent) {
        setIsLoading(true)
      }

      try {
        const response = await requestInboxItems(apiBaseUrl, accessToken)

        if (response.status === 401) {
          clearAuthSession()
          window.location.assign('/')
          return
        }

        const payload = await response.json().catch(() => null)

        if (!response.ok || payload?.ok !== true || !Array.isArray(payload?.items)) {
          throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not load inbox')
        }

        if (!isDisposed) {
          setItems(payload.items)
        }
      } catch (error) {
        if (!isDisposed) {
          setStatus({
            tone: 'error',
            message: error instanceof Error ? error.message : 'Could not load inbox',
          })
        }
      } finally {
        if (!isDisposed && !silent) {
          setIsLoading(false)
        }
      }
    }

    void loadInbox()
    const socketUrl = apiBaseUrl || window.location.origin
    const socket = io(socketUrl, {
      auth: { accessToken },
      transports: ['polling', 'websocket'],
    })

    socket.on('inbox:updated', () => {
      void loadInbox({ silent: true })
    })

    socket.on('connect', () => {
      void loadInbox({ silent: true })
    })

    return () => {
      isDisposed = true
      if (socket.connected) {
        socket.disconnect()
      } else {
        socket.close()
      }
    }
  }, [apiBaseUrl, user])

  const inviteItems = useMemo(
    () => items.filter((item) => item.item_type === 'game_invite'),
    [items]
  )

  const handleAcceptInvite = async (inboxItemId) => {
    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      clearAuthSession()
      window.location.assign('/')
      return
    }

    setIsWorkingItemId(inboxItemId)
    setStatus({ tone: 'pending', message: 'Accepting invite...' })

    try {
      const response = await requestAcceptInvite(apiBaseUrl, accessToken, inboxItemId)

      if (response.status === 401) {
        clearAuthSession()
        window.location.assign('/')
        return
      }

      const payload = await response.json().catch(() => null)

      if (!response.ok || payload?.ok !== true || !payload?.invite?.game_id) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not accept invite')
      }

      const gameId = Number(payload.invite.game_id)
      setStatus({ tone: 'success', message: 'Invite accepted. Redirecting...' })
      window.location.assign(Number.isInteger(gameId) ? `/create?gameId=${gameId}` : '/create')
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not accept invite',
      })
      setIsWorkingItemId(null)
    }
  }

  const handleDeleteInvite = async (inboxItemId) => {
    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      clearAuthSession()
      window.location.assign('/')
      return
    }

    setIsWorkingItemId(inboxItemId)

    try {
      const response = await requestDeleteInboxItem(apiBaseUrl, accessToken, inboxItemId)

      if (response.status === 401) {
        clearAuthSession()
        window.location.assign('/')
        return
      }

      const payload = await response.json().catch(() => null)

      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not delete invite')
      }

      setItems((previousItems) => previousItems.filter((item) => Number(item.inbox_item_id) !== Number(inboxItemId)))
      setStatus({ tone: 'success', message: 'Invite removed.' })
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not delete invite',
      })
    } finally {
      setIsWorkingItemId(null)
    }
  }

  if (!user) {
    return null
  }

  return (
    <div className="min-h-dvh overflow-y-auto bg-slate-950 text-slate-100">
      <Navbar />

      <section
        className="relative min-h-[calc(100dvh-4rem)] overflow-hidden px-4 py-8"
        style={{
          backgroundImage: `url(${homeBackgroundImage})`,
          backgroundPosition: 'center',
          backgroundSize: 'cover',
          backgroundRepeat: 'no-repeat',
        }}
      >
        <div className="absolute inset-0 bg-slate-950/65" />

        <div className="relative z-10 mx-auto w-full max-w-4xl rounded-2xl border border-slate-700/60 bg-slate-900/80 p-6 shadow-2xl shadow-black/50">
          <h1 className="text-2xl font-extrabold uppercase tracking-widest text-white">Inbox</h1>

          {isLoading ? (
            <p className="mt-4 text-sm text-slate-300">Loading inbox...</p>
          ) : inviteItems.length === 0 ? (
            <p className="mt-4 text-sm text-slate-300">No invitations yet.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {inviteItems.map((item) => {
                const inboxItemId = Number(item.inbox_item_id)
                const inviterName = typeof item.sender_username === 'string' && item.sender_username.trim()
                  ? item.sender_username.trim()
                  : 'Unknown user'
                const gameName = typeof item.game_name === 'string' && item.game_name.trim()
                  ? item.game_name.trim()
                  : 'Game room'
                const isWorking = isWorkingItemId === inboxItemId

                return (
                  <div
                    key={item.inbox_item_id}
                    className="rounded-lg border border-slate-700/60 bg-slate-800/70 p-4"
                  >
                    <p className="text-sm font-semibold text-white">{gameName}</p>
                    <p className="mt-1 text-xs text-slate-300">Invited by {inviterName}</p>
                    <p className="mt-1 text-[11px] text-slate-400">Received: {formatReceivedAt(item.received_at)}</p>

                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void handleAcceptInvite(inboxItemId)
                        }}
                        disabled={isWorking}
                        className="rounded-md border border-emerald-500/80 bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-100 transition-colors duration-150 hover:border-emerald-400 hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Accept
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          void handleDeleteInvite(inboxItemId)
                        }}
                        disabled={isWorking}
                        className="rounded-md border border-rose-500/80 bg-rose-500/20 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-rose-100 transition-colors duration-150 hover:border-rose-400 hover:bg-rose-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {status.message ? (
            <p
              className={`mt-4 text-xs ${
                status.tone === 'error'
                  ? 'text-rose-300'
                  : status.tone === 'success'
                    ? 'text-emerald-300'
                    : status.tone === 'pending'
                      ? 'text-slate-300'
                      : 'text-slate-300'
              }`}
            >
              {status.message}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
