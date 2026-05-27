export function clearAuthSession() {
  localStorage.removeItem('accessToken')
  localStorage.removeItem('refreshToken')
  localStorage.removeItem('authUser')
}

let refreshSessionPromise = null

export function logoutOnUnauthorized(redirectPath = '/') {
  clearAuthSession()

  if (typeof window !== 'undefined') {
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`

    if (currentPath !== redirectPath) {
      window.location.assign(redirectPath)
    }
  }

  return ''
}

export async function tryRefreshAccessToken(apiBaseUrl, redirectPath = '/') {
  const normalizedApiBaseUrl = typeof apiBaseUrl === 'string' ? apiBaseUrl.trim().replace(/\/+$/, '') : ''
  const refreshToken = localStorage.getItem('refreshToken')

  if (!normalizedApiBaseUrl || !refreshToken) {
    return logoutOnUnauthorized(redirectPath)
  }

  if (!refreshSessionPromise) {
    refreshSessionPromise = (async () => {
      try {
        const response = await fetch(`${normalizedApiBaseUrl}/sessions/refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refreshToken }),
        })

        const payload = await response.json().catch(() => null)

        if (!response.ok || payload?.ok !== true || typeof payload?.accessToken !== 'string' || !payload.accessToken.trim()) {
          return ''
        }

        localStorage.setItem('accessToken', payload.accessToken.trim())

        if (typeof payload?.refreshToken === 'string' && payload.refreshToken.trim()) {
          localStorage.setItem('refreshToken', payload.refreshToken.trim())
        }

        if (payload?.user && typeof payload.user === 'object') {
          localStorage.setItem('authUser', JSON.stringify(payload.user))
        }

        return payload.accessToken.trim()
      } catch {
        return ''
      } finally {
        refreshSessionPromise = null
      }
    })()
  }

  const refreshedAccessToken = await refreshSessionPromise
  return refreshedAccessToken || logoutOnUnauthorized(redirectPath)
}
