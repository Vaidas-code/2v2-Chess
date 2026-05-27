import { useEffect, useState } from 'react'
import logoImage from '../assets/images/logo.png'
import avatar1 from '../assets/images/Avatars/Avatar1_NO_BG.png'
import avatar2 from '../assets/images/Avatars/Avatar2_NO_BG.png'
import avatar3 from '../assets/images/Avatars/Avatar3_NO_BG.png'
import avatar4 from '../assets/images/Avatars/Avatar4_NO_BG.png'
import avatar5 from '../assets/images/Avatars/Avatar5_NO_BG.png'
import avatar6 from '../assets/images/Avatars/Avatar6_NO_BG.png'
import avatar7 from '../assets/images/Avatars/Avatar7_NO_BG.png'
import avatar8 from '../assets/images/Avatars/Avatar_8_NO_BG.png'
import avatar9 from '../assets/images/Avatars/Avatar9_NO_BG.png'
import avatar10 from '../assets/images/Avatars/Avatar10_NO_BG.png'
import { clearAuthSession, tryRefreshAccessToken } from '../authSession.js'

const DEFAULT_API_BASE_URL = 'http://localhost:3001'

const AVATAR_MAP = {
  'Avatar1_NO_BG.png': avatar1,
  'Avatar2_NO_BG.png': avatar2,
  'Avatar3_NO_BG.png': avatar3,
  'Avatar4_NO_BG.png': avatar4,
  'Avatar5_NO_BG.png': avatar5,
  'Avatar6_NO_BG.png': avatar6,
  'Avatar7_NO_BG.png': avatar7,
  'Avatar_8_NO_BG.png': avatar8,
  'Avatar9_NO_BG.png': avatar9,
  'Avatar10_NO_BG.png': avatar10,
}

function getStoredUser() {
  try {
    const raw = localStorage.getItem('authUser')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function getAvatarSrc(user) {
  if (user?.avatar && AVATAR_MAP[user.avatar]) return AVATAR_MAP[user.avatar]
  if (user?.avatar_url) return user.avatar_url
  return null
}

function getApiBaseUrl() {
  const configuredApiBaseUrl = typeof import.meta.env.VITE_API_BASE_URL === 'string'
    ? import.meta.env.VITE_API_BASE_URL.trim()
    : ''

  const resolvedApiBaseUrl = configuredApiBaseUrl || DEFAULT_API_BASE_URL
  return resolvedApiBaseUrl.endsWith('/') ? resolvedApiBaseUrl.slice(0, -1) : resolvedApiBaseUrl
}

function AvatarFallbackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-300" fill="currentColor" aria-hidden="true">
      <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
    </svg>
  )
}

function InboxIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-200" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 6h16v12H4z" />
      <path d="M4 8l8 6 8-6" />
    </svg>
  )
}

export default function Navbar() {
  const apiBaseUrl = getApiBaseUrl()
  const user = getStoredUser()
  const avatarSrc = getAvatarSrc(user)
  const [notificationCount, setNotificationCount] = useState(0)
  const isAdmin = Array.isArray(user?.roles)
    ? user.roles.includes('admin')
    : user?.role === 'admin'
  const homeHref = user ? '/home' : '/'
  const navLinks = [
    { label: 'Home', href: homeHref },
    { label: 'How to Play', href: '/how-to-play' },
    { label: 'Leaderboards', href: '/leaderboards' },
    ...(isAdmin ? [{ label: 'Reports', href: '/admin/reports' }] : []),
  ]

  useEffect(() => {
    if (!user) {
      return undefined
    }

    let isDisposed = false

    const loadNavbarNotifications = async () => {
      try {
        const requestSummary = (accessToken) => fetch(`${apiBaseUrl}/inbox/summary`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        })

        const currentAccessToken = localStorage.getItem('accessToken')
        if (!currentAccessToken) {
          return
        }

        let response = await requestSummary(currentAccessToken)

        if (response.status === 401) {
          const refreshedAccessToken = await tryRefreshAccessToken(apiBaseUrl, '/')

          if (!refreshedAccessToken) {
            return
          }

          response = await requestSummary(refreshedAccessToken)
        }

        const payload = await response.json().catch(() => null)

        if (!response.ok || payload?.ok !== true || typeof payload?.summary !== 'object') {
          if (!isDisposed) {
            setNotificationCount(0)
          }
          return
        }

        const normalizedCount = Number(payload.summary.unread_count ?? 0)
        const resolvedCount = Number.isFinite(normalizedCount) && normalizedCount > 0
          ? Math.floor(normalizedCount)
          : 0

        if (!isDisposed) {
          setNotificationCount(resolvedCount)
        }
      } catch {
        if (!isDisposed) {
          setNotificationCount(0)
        }
      }
    }

    loadNavbarNotifications()

    return () => {
      isDisposed = true
    }
  }, [apiBaseUrl, user])

  const handleLogout = () => {
    clearAuthSession()
    window.location.assign('/')
  }

  return (
    <header className="w-full h-16 bg-slate-950/90 backdrop-blur border-b border-slate-700/50">
      <div className="flex h-full items-center justify-between px-6 lg:px-10">

        {/* Brand — left */}
        <a href={homeHref} className="flex items-center gap-2.5 shrink-0">
          <img src={logoImage} alt="2v2 Chess logo" className="h-9 w-9 rounded-lg object-cover" />
          <span className="text-base font-extrabold uppercase tracking-widest text-white">
            2v2 Chess
          </span>
        </a>

        {/* Nav links — center */}
        <nav className="hidden md:flex items-center gap-8 absolute left-1/2 -translate-x-1/2">
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="text-sm font-medium text-slate-300 hover:text-white transition-colors duration-150 hover:underline underline-offset-4"
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* Auth — right */}
        <div className="flex items-center gap-3 shrink-0">
          {user ? (
            <>
              <a
                href="/inbox"
                title="Inbox"
                className="relative flex h-9 w-9 items-center justify-center rounded-full border border-slate-600 bg-slate-800/80 shadow-sm transition-transform duration-150 hover:scale-105 hover:bg-slate-700/80"
              >
                <InboxIcon />

                {notificationCount > 0 ? (
                  <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white">
                    {notificationCount > 9 ? '!' : String(notificationCount)}
                  </span>
                ) : null}
              </a>

              {/* Profile avatar */}
              <a
                href="/profile"
                title={user.username || user.email || 'Profile'}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-600 bg-slate-800/80 shadow-sm transition-transform duration-150 hover:scale-105 hover:bg-slate-700/80 overflow-hidden"
              >
                {avatarSrc ? (
                  <img
                    src={avatarSrc}
                    alt="Profile avatar"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <AvatarFallbackIcon />
                )}
              </a>

              {/* Log out */}
              <button
                type="button"
                onClick={handleLogout}
                className="px-4 py-1.5 text-sm font-semibold text-slate-200 border border-slate-600 rounded-lg hover:border-slate-400 hover:text-white transition-colors duration-150"
              >
                Log Out
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="px-4 py-1.5 text-sm font-semibold text-slate-200 border border-slate-600 rounded-lg hover:border-slate-400 hover:text-white transition-colors duration-150"
              >
                Log In
              </button>
              <button
                type="button"
                className="px-4 py-1.5 text-sm font-semibold text-white rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 transition-all duration-150 shadow-md"
              >
                Sign Up
              </button>
            </>
          )}
        </div>

      </div>
    </header>
  )
}
