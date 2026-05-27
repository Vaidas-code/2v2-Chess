import { useEffect, useMemo, useState } from 'react'
import Navbar from '../components/Navbar.jsx'
import homeBackgroundImage from '../assets/images/2v2chess_home.png'
import { tryRefreshAccessToken } from '../authSession.js'
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

const DEFAULT_API_BASE_URL = 'http://localhost:3001'

const AVATAR_OPTIONS = [
  { filename: 'Avatar1_NO_BG.png', src: avatar1 },
  { filename: 'Avatar2_NO_BG.png', src: avatar2 },
  { filename: 'Avatar3_NO_BG.png', src: avatar3 },
  { filename: 'Avatar4_NO_BG.png', src: avatar4 },
  { filename: 'Avatar5_NO_BG.png', src: avatar5 },
  { filename: 'Avatar6_NO_BG.png', src: avatar6 },
  { filename: 'Avatar7_NO_BG.png', src: avatar7 },
  { filename: 'Avatar_8_NO_BG.png', src: avatar8 },
  { filename: 'Avatar9_NO_BG.png', src: avatar9 },
  { filename: 'Avatar10_NO_BG.png', src: avatar10 },
]

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

function normalizeStoredUser(updatedUser, fallbackUser, fallbackAvatar) {
  return {
    id: String(updatedUser?.user_id ?? updatedUser?.id ?? fallbackUser?.id ?? ''),
    email: updatedUser?.email ?? fallbackUser?.email ?? '',
    username: updatedUser?.username ?? fallbackUser?.username ?? '',
    avatar: updatedUser?.avatar ?? fallbackAvatar ?? fallbackUser?.avatar ?? null,
  }
}

function persistSession({ accessToken, refreshToken, user }) {
  if (typeof accessToken === 'string' && accessToken.trim()) {
    localStorage.setItem('accessToken', accessToken)
  }

  if (typeof refreshToken === 'string' && refreshToken.trim()) {
    localStorage.setItem('refreshToken', refreshToken)
  }

  if (user && typeof user === 'object') {
    localStorage.setItem('authUser', JSON.stringify(user))
  }
}

function AvatarFallbackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-12 w-12 text-slate-300" fill="currentColor" aria-hidden="true">
      <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
    </svg>
  )
}

export default function ProfilePage() {
  const apiBaseUrl = getApiBaseUrl()
  const [user, setUser] = useState(getStoredUser)
  const [username, setUsername] = useState(user?.username ?? '')
  const [isAvatarPickerOpen, setIsAvatarPickerOpen] = useState(false)
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [profileStatus, setProfileStatus] = useState({ tone: 'idle', message: '' })
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [repeatNewPassword, setRepeatNewPassword] = useState('')
  const [isSavingPassword, setIsSavingPassword] = useState(false)
  const [passwordStatus, setPasswordStatus] = useState({ tone: 'idle', message: '' })
  const [isDeletingProfile, setIsDeletingProfile] = useState(false)
  const [deleteStatus, setDeleteStatus] = useState({ tone: 'idle', message: '' })
  const [selectedAvatar, setSelectedAvatar] = useState(() => {
    const storedAvatar = typeof user?.avatar === 'string' ? user.avatar.trim() : ''
    return AVATAR_OPTIONS.some((option) => option.filename === storedAvatar)
      ? storedAvatar
      : ''
  })

  const selectedAvatarOption = useMemo(
    () => AVATAR_OPTIONS.find((option) => option.filename === selectedAvatar) ?? null,
    [selectedAvatar]
  )

  const availableAvatarOptions = useMemo(
    () => AVATAR_OPTIONS.filter((option) => option.filename !== selectedAvatar),
    [selectedAvatar]
  )

  useEffect(() => {
    if (!user) {
      window.location.assign('/')
    }
  }, [user])

  if (!user) return null

  const refreshAccessToken = async () => {
    return tryRefreshAccessToken(apiBaseUrl, '/')
  }

  const fetchWithAutoRefresh = async (url, options = {}) => {
    const baseHeaders = options?.headers && typeof options.headers === 'object' ? options.headers : {}
    const getHeadersWithToken = (token) => {
      if (!token) return baseHeaders
      return {
        ...baseHeaders,
        Authorization: `Bearer ${token}`,
      }
    }

    const accessToken = localStorage.getItem('accessToken')

    let response = await fetch(url, {
      ...options,
      headers: getHeadersWithToken(accessToken),
    })

    if (response.status !== 401) {
      return response
    }

    const refreshedAccessToken = await refreshAccessToken()

    if (!refreshedAccessToken) {
      return response
    }

    response = await fetch(url, {
      ...options,
      headers: getHeadersWithToken(refreshedAccessToken),
    })

    return response
  }

  const handleProfileSave = async (event) => {
    event.preventDefault()

    const normalizedUsername = typeof username === 'string' ? username.trim() : ''

    if (!normalizedUsername) {
      setProfileStatus({ tone: 'error', message: 'Username is required.' })
      return
    }

    if (!user?.id) {
      setProfileStatus({ tone: 'error', message: 'Session user id is missing.' })
      return
    }

    setIsSavingProfile(true)
    setProfileStatus({ tone: 'pending', message: 'Saving profile...' })

    try {
      const response = await fetchWithAutoRefresh(`${apiBaseUrl}/users/${encodeURIComponent(String(user.id))}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: normalizedUsername,
          ...(selectedAvatar ? { avatar: selectedAvatar } : {}),
        }),
      })

      const payload = await response.json().catch(() => null)

      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not update profile')
      }

      const normalizedUser = normalizeStoredUser(payload?.user, user, selectedAvatar)
      localStorage.setItem('authUser', JSON.stringify(normalizedUser))
      setUser(normalizedUser)
      setUsername(normalizedUser.username)
      setSelectedAvatar(normalizedUser.avatar)
      setProfileStatus({ tone: 'success', message: 'Profile updated successfully.' })
    } catch (error) {
      setProfileStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not update profile',
      })
    } finally {
      setIsSavingProfile(false)
    }
  }

  const handlePasswordSave = async (event) => {
    event.preventDefault()

    const normalizedCurrentPassword = typeof currentPassword === 'string' ? currentPassword.trim() : ''
    const normalizedNewPassword = typeof newPassword === 'string' ? newPassword.trim() : ''
    const normalizedRepeatNewPassword = typeof repeatNewPassword === 'string' ? repeatNewPassword.trim() : ''

    if (!normalizedCurrentPassword || !normalizedNewPassword || !normalizedRepeatNewPassword) {
      setPasswordStatus({ tone: 'error', message: 'All password fields are required.' })
      return
    }

    if (normalizedNewPassword !== normalizedRepeatNewPassword) {
      setPasswordStatus({ tone: 'error', message: 'New passwords do not match.' })
      return
    }

    if (normalizedNewPassword.length < 8) {
      setPasswordStatus({ tone: 'error', message: 'Password must be at least 8 characters long.' })
      return
    }

    if (!user?.id) {
      setPasswordStatus({ tone: 'error', message: 'Session user id is missing.' })
      return
    }

    setIsSavingPassword(true)
    setPasswordStatus({ tone: 'pending', message: 'Updating password...' })

    try {
      const response = await fetchWithAutoRefresh(`${apiBaseUrl}/users/${encodeURIComponent(String(user.id))}/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          currentPassword: normalizedCurrentPassword,
          newPassword: normalizedNewPassword,
          repeatNewPassword: normalizedRepeatNewPassword,
        }),
      })

      const payload = await response.json().catch(() => null)

      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not update password')
      }

      if (typeof payload?.accessToken === 'string' && typeof payload?.refreshToken === 'string') {
        const normalizedUserForSession = normalizeStoredUser(payload?.user, user, selectedAvatar)
        persistSession({
          accessToken: payload.accessToken,
          refreshToken: payload.refreshToken,
          user: normalizedUserForSession,
        })
      }

      if (payload?.user && typeof payload.user === 'object') {
        const normalizedUser = normalizeStoredUser(payload.user, user, selectedAvatar)
        localStorage.setItem('authUser', JSON.stringify(normalizedUser))
        setUser(normalizedUser)
      }

      setCurrentPassword('')
      setNewPassword('')
      setRepeatNewPassword('')
      setPasswordStatus({ tone: 'success', message: 'Password updated successfully.' })
    } catch (error) {
      setPasswordStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not update password',
      })
    } finally {
      setIsSavingPassword(false)
    }
  }

  const handleDeleteProfile = async () => {
    if (!user?.id) {
      setDeleteStatus({ tone: 'error', message: 'Session user id is missing.' })
      return
    }

    const confirmed = window.confirm('Delete your profile? This cannot be undone.')
    if (!confirmed) return

    setIsDeletingProfile(true)
    setDeleteStatus({ tone: 'pending', message: 'Deleting profile...' })

    try {
      const response = await fetchWithAutoRefresh(`${apiBaseUrl}/users/${encodeURIComponent(String(user.id))}`, {
        method: 'DELETE',
      })

      const payload = await response.json().catch(() => null)

      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not delete profile')
      }

      localStorage.removeItem('accessToken')
      localStorage.removeItem('refreshToken')
      localStorage.removeItem('authUser')
      setDeleteStatus({ tone: 'success', message: 'Profile deleted.' })
      setUser(null)
      window.location.assign('/')
    } catch (error) {
      setDeleteStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not delete profile',
      })
    } finally {
      setIsDeletingProfile(false)
    }
  }

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
          className="relative z-10 w-full max-w-2xl rounded-2xl border border-slate-700/60 bg-slate-900/80 px-8 py-7 shadow-2xl shadow-black/50"
          style={{ backdropFilter: 'blur(16px)' }}
        >
          <h1 className="text-center text-2xl font-extrabold uppercase tracking-widest text-white">
            Profile Settings
          </h1>

          <div className="mt-4 flex justify-center">
            <a
              href="/profile/stats"
              className="rounded-lg border border-slate-600 bg-slate-800/70 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-200 transition-colors duration-150 hover:border-slate-400 hover:text-white"
            >
              View My Statistics
            </a>
          </div>

          <form className="mt-6 space-y-5" onSubmit={handleProfileSave}>
            <div className="flex flex-col items-center">
              <button
                type="button"
                onClick={() => setIsAvatarPickerOpen((open) => !open)}
                className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border border-slate-600 bg-slate-800/80 shadow-md transition-transform duration-150 hover:scale-105"
                title="Change avatar"
                aria-label="Change avatar"
              >
                {selectedAvatarOption ? (
                  <img src={selectedAvatarOption.src} alt="Selected avatar" className="h-full w-full object-cover" />
                ) : (
                  <AvatarFallbackIcon />
                )}
              </button>
              <p className="mt-2 text-xs text-slate-400">Click avatar to change</p>
            </div>

            {isAvatarPickerOpen ? (
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Choose avatar</p>
                <div className="grid grid-cols-5 gap-2">
                  {availableAvatarOptions.map((option) => (
                    <button
                      key={option.filename}
                      type="button"
                      onClick={() => {
                        setSelectedAvatar(option.filename)
                        setIsAvatarPickerOpen(false)
                      }}
                      className="overflow-hidden rounded-full border border-slate-600 bg-slate-800/80 transition-transform duration-150 hover:scale-105"
                      title={option.filename}
                      aria-label={`Select ${option.filename}`}
                    >
                      <img src={option.src} alt="Avatar option" className="h-12 w-12 object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300" htmlFor="profile-username">
                Username
              </label>
              <input
                id="profile-username"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-400 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300" htmlFor="profile-email">
                Email
              </label>
              <input
                id="profile-email"
                type="email"
                value={user.email ?? ''}
                readOnly
                className="w-full cursor-not-allowed rounded-lg border border-slate-700 bg-slate-800/40 px-4 py-2.5 text-sm text-slate-400"
              />
            </div>

            <button
              type="submit"
              disabled={isSavingProfile}
              className="w-full rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSavingProfile ? 'Saving...' : 'Save Changes'}
            </button>

            {profileStatus.message ? (
              <p
                className={`text-center text-xs ${
                  profileStatus.tone === 'error'
                    ? 'text-rose-300'
                    : profileStatus.tone === 'success'
                      ? 'text-emerald-300'
                      : 'text-slate-300'
                }`}
              >
                {profileStatus.message}
              </p>
            ) : null}
          </form>

          <div className="my-6 h-px bg-slate-700/60" />

          <form className="space-y-4" onSubmit={handlePasswordSave}>
            <h2 className="text-center text-sm font-bold uppercase tracking-wide text-white">Change Password</h2>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300" htmlFor="current-password">
                Current Password
              </label>
              <input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-400 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300" htmlFor="new-password">
                New Password
              </label>
              <input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-400 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300" htmlFor="repeat-new-password">
                Repeat New Password
              </label>
              <input
                id="repeat-new-password"
                type="password"
                value={repeatNewPassword}
                onChange={(event) => setRepeatNewPassword(event.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-400 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <button
              type="submit"
              disabled={isSavingPassword}
              className="w-full rounded-lg border border-slate-500 bg-slate-800/70 px-5 py-2.5 text-sm font-semibold text-slate-100 transition-colors duration-150 hover:border-slate-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSavingPassword ? 'Updating...' : 'Change Password'}
            </button>

            {passwordStatus.message ? (
              <p
                className={`text-center text-xs ${
                  passwordStatus.tone === 'error'
                    ? 'text-rose-300'
                    : passwordStatus.tone === 'success'
                      ? 'text-emerald-300'
                      : 'text-slate-300'
                }`}
              >
                {passwordStatus.message}
              </p>
            ) : null}
          </form>

          <div className="my-6 h-px bg-slate-700/60" />

          <div className="space-y-3">
            <h2 className="text-center text-sm font-bold uppercase tracking-wide text-rose-200">Delete Profile</h2>
            <button
              type="button"
              onClick={handleDeleteProfile}
              disabled={isDeletingProfile}
              className="w-full rounded-lg border border-rose-500/50 bg-rose-500/15 px-5 py-2.5 text-sm font-semibold text-rose-200 transition-colors duration-150 hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isDeletingProfile ? 'Deleting...' : 'Delete Profile'}
            </button>

            {deleteStatus.message ? (
              <p
                className={`text-center text-xs ${
                  deleteStatus.tone === 'error'
                    ? 'text-rose-300'
                    : deleteStatus.tone === 'success'
                      ? 'text-emerald-300'
                      : 'text-slate-300'
                }`}
              >
                {deleteStatus.message}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  )
}
