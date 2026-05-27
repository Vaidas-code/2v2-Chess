import { useEffect, useMemo, useState } from 'react'
import { io } from 'socket.io-client'
import Navbar from '../components/Navbar.jsx'
import ChatPanel from '../components/ChatPanel.jsx'
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

const EMPTY_SLOTS = {
  teamAWhite: null,
  teamABlack: null,
  teamBWhite: null,
  teamBBlack: null,
}

const SLOT_META = {
  teamAWhite: { teamKey: 'teamA', roleLabel: '♔ White' },
  teamABlack: { teamKey: 'teamA', roleLabel: '♚ Black' },
  teamBWhite: { teamKey: 'teamB', roleLabel: '♔ White' },
  teamBBlack: { teamKey: 'teamB', roleLabel: '♚ Black' },
}

const TEAM_SLOT_ORDER = {
  teamA: ['teamAWhite', 'teamABlack'],
  teamB: ['teamBWhite', 'teamBBlack'],
}

const TIME_CONTROL_PRESETS = [
  { label: '3+2 Blitz', time_control: '3', increment: '2' },
  { label: '5+0 Blitz', time_control: '5', increment: '0' },
  { label: '10+0 Rapid', time_control: '10', increment: '0' },
  { label: '15+10 Rapid', time_control: '15', increment: '10' },
]

const DEFAULT_API_BASE_URL = 'http://localhost:3001'
const DEFAULT_GAME_NAME = 'Casual chess room'

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') {
    return ''
  }

  const normalizedValue = value.trim()

  if (!normalizedValue) {
    return ''
  }

  return normalizedValue.endsWith('/') ? normalizedValue.slice(0, -1) : normalizedValue
}

function isLocalhostBaseUrl(value) {
  if (typeof value !== 'string') {
    return false
  }

  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(value.trim())
}

function getPublicAppBaseUrl() {
  const configuredPublicUrl = normalizeBaseUrl(import.meta.env.VITE_PUBLIC_APP_URL)
  if (configuredPublicUrl) {
    return configuredPublicUrl
  }

  const configuredFrontendUrl = normalizeBaseUrl(import.meta.env.VITE_FRONTEND_URL)
  if (configuredFrontendUrl) {
    return configuredFrontendUrl
  }

  if (typeof window === 'undefined') {
    return ''
  }

  return normalizeBaseUrl(window.location.origin)
}

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

function getApiBaseUrl() {
  const configuredApiBaseUrl = typeof import.meta.env.VITE_API_BASE_URL === 'string'
    ? import.meta.env.VITE_API_BASE_URL.trim()
    : ''

  const resolvedApiBaseUrl = configuredApiBaseUrl || DEFAULT_API_BASE_URL
  return resolvedApiBaseUrl.endsWith('/') ? resolvedApiBaseUrl.slice(0, -1) : resolvedApiBaseUrl
}

function parseTimeControlPreset(value) {
  const normalizedValue = typeof value === 'string' ? value.trim() : ''

  if (!normalizedValue) {
    return { time_control: '', increment: '' }
  }

  const matchingPreset = TIME_CONTROL_PRESETS.find((preset) => preset.label === normalizedValue)

  if (matchingPreset) {
    return {
      time_control: matchingPreset.time_control,
      increment: matchingPreset.increment,
    }
  }

  const [clockPart = ''] = normalizedValue.split(/\s+/)
  const [timeControl = '', increment = ''] = clockPart.split('+').map((part) => part.trim())

  return {
    time_control: timeControl,
    increment,
  }
}

function resolveTimeControlPresetLabel(timeControlValue, incrementValue, fallbackValue = '5+0 Blitz') {
  const normalizedTimeControl = typeof timeControlValue === 'string' ? timeControlValue.trim() : ''
  const normalizedIncrement = typeof incrementValue === 'string' ? incrementValue.trim() : ''

  const matchingPreset = TIME_CONTROL_PRESETS.find(
    (preset) => preset.time_control === normalizedTimeControl && preset.increment === normalizedIncrement
  )

  if (matchingPreset) {
    return matchingPreset.label
  }

  return fallbackValue
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

function getPlayerInitial(nameOrEmail) {
  if (typeof nameOrEmail !== 'string') return '?'
  const trimmedValue = nameOrEmail.trim()
  if (!trimmedValue) return '?'
  return trimmedValue.charAt(0).toUpperCase()
}

function resolveAvatarSrc(value) {
  if (typeof value !== 'string') {
    return ''
  }

  const normalizedValue = value.trim()

  if (!normalizedValue) {
    return ''
  }

  if (/^(https?:)?\/\//i.test(normalizedValue) || normalizedValue.startsWith('data:') || normalizedValue.startsWith('blob:') || normalizedValue.startsWith('/')) {
    return normalizedValue
  }

  return AVATAR_MAP[normalizedValue] ?? ''
}

function getStoredUser() {
  try {
    const raw = localStorage.getItem('authUser')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function refreshAccessToken(apiBaseUrl) {
  return tryRefreshAccessToken(apiBaseUrl, '/')
}

async function requestCreateGame(apiBaseUrl, accessToken, payload) {
  return fetch(`${apiBaseUrl}/games`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  })
}

async function requestDeleteLobbyGame(apiBaseUrl, accessToken, gameId) {
  return fetch(`${apiBaseUrl}/games/${encodeURIComponent(String(gameId))}/lobby`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

async function requestHeartbeatLobbyPresence(apiBaseUrl, accessToken, gameId) {
  return fetch(`${apiBaseUrl}/games/${encodeURIComponent(String(gameId))}/lobby/presence`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

async function requestLeaveLobbyPresence(apiBaseUrl, accessToken, gameId) {
  return fetch(`${apiBaseUrl}/games/${encodeURIComponent(String(gameId))}/lobby/presence`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    keepalive: true,
  })
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const abortController = new AbortController()
  const timeoutHandle = setTimeout(() => {
    abortController.abort()
  }, timeoutMs)

  try {
    return await fetch(url, {
      ...options,
      signal: abortController.signal,
    })
  } finally {
    clearTimeout(timeoutHandle)
  }
}

async function requestGetLobbyGame(apiBaseUrl, accessToken, gameId) {
  return fetchWithTimeout(`${apiBaseUrl}/games/${encodeURIComponent(String(gameId))}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, 10000)
}

async function requestUpdateLobbyGameName(apiBaseUrl, accessToken, gameId, gameName) {
  return fetch(`${apiBaseUrl}/games/${encodeURIComponent(String(gameId))}/name`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ game_name: gameName }),
  })
}

async function requestUpdateLobbyTeamName(apiBaseUrl, accessToken, gameId, teamId, teamName) {
  return fetch(`${apiBaseUrl}/games/${encodeURIComponent(String(gameId))}/teams/${encodeURIComponent(String(teamId))}/name`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ team_name: teamName }),
  })
}

async function requestUpdateLobbyGameSettings(apiBaseUrl, accessToken, gameId, payload) {
  return fetch(`${apiBaseUrl}/games/${encodeURIComponent(String(gameId))}/settings`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  })
}

async function requestJoinTeamMember(apiBaseUrl, accessToken, teamMemberId) {
  return fetchWithTimeout(`${apiBaseUrl}/team-members/${encodeURIComponent(String(teamMemberId))}/join`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, 10000)
}

async function requestJoinBotTeamMember(apiBaseUrl, accessToken, teamMemberId, username) {
  return fetchWithTimeout(`${apiBaseUrl}/team-members/${encodeURIComponent(String(teamMemberId))}/bot`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ username }),
  }, 10000)
}

async function requestLeaveTeamMember(apiBaseUrl, accessToken, teamMemberId) {
  return fetchWithTimeout(`${apiBaseUrl}/team-members/${encodeURIComponent(String(teamMemberId))}/leave`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, 10000)
}

async function requestRemoveBotTeamMember(apiBaseUrl, accessToken, teamMemberId) {
  return fetchWithTimeout(`${apiBaseUrl}/team-members/${encodeURIComponent(String(teamMemberId))}/remove-bot`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, 10000)
}

async function requestGetBotNames(apiBaseUrl, accessToken) {
  return fetchWithTimeout(`${apiBaseUrl}/bots/names`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, 10000)
}

async function requestSendInboxGameInvite(apiBaseUrl, accessToken, gameId, username) {
  return fetchWithTimeout(`${apiBaseUrl}/inbox/invites`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ game_id: gameId, username }),
  }, 10000)
}

async function requestGetGameInviteLink(apiBaseUrl, accessToken, gameId) {
  return fetchWithTimeout(`${apiBaseUrl}/games/${encodeURIComponent(String(gameId))}/invite-link`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, 10000)
}

async function requestStartLobbyGame(apiBaseUrl, accessToken, gameId) {
  return fetchWithTimeout(`${apiBaseUrl}/games/${encodeURIComponent(String(gameId))}/start`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, 10000)
}

export default function CreatePage() {
  const apiBaseUrl = getApiBaseUrl()
  const [gameName, setGameName] = useState(DEFAULT_GAME_NAME)
  const [gameMode, setGameMode] = useState('2v2')
  const [timeControl, setTimeControl] = useState('5+0 Blitz')
  const [teamAName, setTeamAName] = useState('Team A')
  const [teamBName, setTeamBName] = useState('Team B')
  const [allowSpectators, setAllowSpectators] = useState(true)
  const [publicRoom, setPublicRoom] = useState(false)
  const [ratedGame, setRatedGame] = useState(false)
  const [slots, setSlots] = useState(EMPTY_SLOTS)
  const [selectedSlotKey, setSelectedSlotKey] = useState('')
  const [inviteInput, setInviteInput] = useState('')
  const [invitedPlayers, setInvitedPlayers] = useState([])
  const [inviteLink, setInviteLink] = useState('')
  const [currentUser] = useState(getStoredUser)
  const [isCreatingRoom, setIsCreatingRoom] = useState(false)
  const [isStartingGame, setIsStartingGame] = useState(false)
  const [isLeavingLobby, setIsLeavingLobby] = useState(false)
  const [isJoiningSlotKey, setIsJoiningSlotKey] = useState('')
  const [isAddingBotSlotKey, setIsAddingBotSlotKey] = useState('')
  const [isLeavingTeamSlotKey, setIsLeavingTeamSlotKey] = useState('')
  const [isRemovingBotSlotKey, setIsRemovingBotSlotKey] = useState('')
  const [botPickerSlotKey, setBotPickerSlotKey] = useState('')
  const [selectedBotName, setSelectedBotName] = useState('')
  const [botNames, setBotNames] = useState([])
  const [hasLoadedBotNames, setHasLoadedBotNames] = useState(false)
  const [isLoadingBotNames, setIsLoadingBotNames] = useState(false)
  const [isUpdatingLobbySettings, setIsUpdatingLobbySettings] = useState(false)
  const [isConfirmingGameName, setIsConfirmingGameName] = useState(false)
  const [isConfirmingTeamKey, setIsConfirmingTeamKey] = useState('')
  const [activeLobbyGameId, setActiveLobbyGameId] = useState(() => {
    if (typeof window === 'undefined') {
      return null
    }

    const searchParams = new URLSearchParams(window.location.search)
    return normalizePositiveInteger(searchParams.get('gameId'))
  })
  const [teamAId, setTeamAId] = useState(null)
  const [teamBId, setTeamBId] = useState(null)
  const [defaultGameName, setDefaultGameName] = useState(DEFAULT_GAME_NAME)
  const [defaultTeamAName, setDefaultTeamAName] = useState('Team A')
  const [defaultTeamBName, setDefaultTeamBName] = useState('Team B')
  const [slotTeamMemberIds, setSlotTeamMemberIds] = useState({
    teamAWhite: null,
    teamABlack: null,
    teamBWhite: null,
    teamBBlack: null,
  })
  const [slotPlayersById, setSlotPlayersById] = useState({})
  const [isSyncingLobbyGame, setIsSyncingLobbyGame] = useState(false)
  const [status, setStatus] = useState({ tone: 'idle', message: '' })
  const [accessDenied, setAccessDenied] = useState(false)

  const hasAccessToken = typeof window !== 'undefined' && Boolean(localStorage.getItem('accessToken'))
  const isAuthenticated = Boolean(currentUser) && hasAccessToken

  useEffect(() => {
    if (!isAuthenticated) {
      const returnPath = `${window.location.pathname}${window.location.search}`
      const encodedReturnPath = encodeURIComponent(returnPath)
      window.location.assign(`/?redirect=${encodedReturnPath}`)
    }
  }, [isAuthenticated])

  const currentPlayerName = useMemo(() => {
    const username = typeof currentUser?.username === 'string' ? currentUser.username.trim() : ''
    if (username) return username

    const email = typeof currentUser?.email === 'string' ? currentUser.email.trim() : ''
    if (email) return email

    return 'You'
  }, [currentUser])

  const currentUserId = useMemo(() => {
    if (typeof currentUser?.id === 'string') {
      const normalizedUserId = currentUser.id.trim()
      if (normalizedUserId) {
        return normalizedUserId
      }
    }

    return ''
  }, [currentUser])

  const currentUserAvatar = useMemo(() => {
    const avatar = typeof currentUser?.avatar === 'string' ? currentUser.avatar.trim() : ''
    const avatarUrl = typeof currentUser?.avatar_url === 'string' ? currentUser.avatar_url.trim() : ''

    if (avatar) {
      return resolveAvatarSrc(avatar)
    }

    if (avatarUrl) {
      return resolveAvatarSrc(avatarUrl)
    }

    return ''
  }, [currentUser])

  const userTeamInfo = useMemo(() => {
    if (!currentUserId) {
      return { userTeamId: null, userTeamMemberId: null }
    }

    // Check if user is in teamA
    if (slots.teamAWhite === currentUserId) {
      return { userTeamId: teamAId, userTeamMemberId: slotTeamMemberIds.teamAWhite }
    }
    if (slots.teamABlack === currentUserId) {
      return { userTeamId: teamAId, userTeamMemberId: slotTeamMemberIds.teamABlack }
    }

    // Check if user is in teamB
    if (slots.teamBWhite === currentUserId) {
      return { userTeamId: teamBId, userTeamMemberId: slotTeamMemberIds.teamBWhite }
    }
    if (slots.teamBBlack === currentUserId) {
      return { userTeamId: teamBId, userTeamMemberId: slotTeamMemberIds.teamBBlack }
    }

    return { userTeamId: null, userTeamMemberId: null }
  }, [currentUserId, slots, teamAId, teamBId, slotTeamMemberIds])

  const applyGameTeams = (game) => {
    const normalizedGameId = normalizePositiveInteger(game?.game_id)
    const normalizedGameStatus = typeof game?.status === 'string' ? game.status.trim().toLowerCase() : ''

    if (normalizedGameId && normalizedGameStatus === 'started') {
      window.location.assign(`/game/${encodeURIComponent(String(normalizedGameId))}`)
      return
    }

    const normalizedGameName = typeof game?.game_name === 'string' ? game.game_name.trim() : ''
    const resolvedGameName = normalizedGameName || DEFAULT_GAME_NAME
    const resolvedTimeControl = resolveTimeControlPresetLabel(game?.time_control, game?.increment, '5+0 Blitz')
    const resolvedRatedGame = typeof game?.rated_game === 'boolean' ? game.rated_game : false
    const resolvedAllowSpectators = typeof game?.allow_spectators === 'boolean' ? game.allow_spectators : true
    const resolvedPublicGame = typeof game?.public_game === 'boolean' ? game.public_game : false

    setGameName(resolvedGameName)
    setDefaultGameName(resolvedGameName)
    setTimeControl(resolvedTimeControl)
    setRatedGame(resolvedRatedGame)
    setAllowSpectators(resolvedAllowSpectators)
    setPublicRoom(resolvedPublicGame)

    const teams = Array.isArray(game?.teams) ? [...game.teams] : []

    teams.sort((firstTeam, secondTeam) => {
      const firstTeamId = normalizePositiveInteger(firstTeam?.team_id) ?? Number.MAX_SAFE_INTEGER
      const secondTeamId = normalizePositiveInteger(secondTeam?.team_id) ?? Number.MAX_SAFE_INTEGER
      return firstTeamId - secondTeamId
    })

    const firstTeam = teams[0]
    const secondTeam = teams[1]

    const firstTeamId = normalizePositiveInteger(firstTeam?.team_id)
    const secondTeamId = normalizePositiveInteger(secondTeam?.team_id)

    setTeamAId(firstTeamId)
    setTeamBId(secondTeamId)

    if (firstTeam && typeof firstTeam.team_name === 'string' && firstTeam.team_name.trim()) {
      const normalizedTeamAName = firstTeam.team_name.trim()
      setTeamAName(normalizedTeamAName)
      setDefaultTeamAName(normalizedTeamAName)
    } else {
      setDefaultTeamAName('Team A')
    }

    if (secondTeam && typeof secondTeam.team_name === 'string' && secondTeam.team_name.trim()) {
      const normalizedTeamBName = secondTeam.team_name.trim()
      setTeamBName(normalizedTeamBName)
      setDefaultTeamBName(normalizedTeamBName)
    } else {
      setDefaultTeamBName('Team B')
    }

    const nextSlots = { ...EMPTY_SLOTS }
    const nextSlotTeamMemberIds = {
      teamAWhite: null,
      teamABlack: null,
      teamBWhite: null,
      teamBBlack: null,
    }
    const nextSlotPlayersById = {}

    const assignTeamMembersToSlots = (team, teamPrefix) => {
      const members = Array.isArray(team?.members) ? team.members : []

      for (const member of members) {
        const pieceColor = typeof member?.piece_color === 'string' ? member.piece_color.trim().toLowerCase() : ''
        const slotSuffix = pieceColor === 'white' ? 'White' : pieceColor === 'black' ? 'Black' : ''

        if (!slotSuffix) {
          continue
        }

        const slotKey = `${teamPrefix}${slotSuffix}`
        const teamMemberId = normalizePositiveInteger(member?.team_member_id)
        const userId = typeof member?.user_id === 'string' ? member.user_id.trim() : ''
        const username = typeof member?.username === 'string' ? member.username.trim() : ''
        const avatar = typeof member?.avatar === 'string' ? member.avatar.trim() : ''
        const resolvedAvatar = resolveAvatarSrc(avatar)

        if (teamMemberId) {
          nextSlotTeamMemberIds[slotKey] = teamMemberId
        }

        if (userId) {
          nextSlots[slotKey] = userId
          nextSlotPlayersById[userId] = {
            id: userId,
            name: username || userId,
            avatar: resolvedAvatar,
            isBot: member?.is_bot === true,
          }
        }
      }
    }

    assignTeamMembersToSlots(firstTeam, 'teamA')
    assignTeamMembersToSlots(secondTeam, 'teamB')

    setSlots(nextSlots)
    setSlotTeamMemberIds(nextSlotTeamMemberIds)
    setSlotPlayersById(nextSlotPlayersById)
  }

  useEffect(() => {
    if (!activeLobbyGameId) {
      return undefined
    }

    let isDisposed = false

    const sendPresenceHeartbeat = async () => {
      if (isDisposed) {
        return
      }

      const accessToken = localStorage.getItem('accessToken')
      if (!accessToken) {
        return
      }

      try {
        const response = await requestHeartbeatLobbyPresence(apiBaseUrl, accessToken, activeLobbyGameId)

        if (response.status === 401) {
          const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

          if (refreshedAccessToken) {
            await requestHeartbeatLobbyPresence(apiBaseUrl, refreshedAccessToken, activeLobbyGameId)
          }
        }
      } catch {
        // Silently ignore sync errors
      }
    }

    void sendPresenceHeartbeat()
    const heartbeatInterval = window.setInterval(() => {
      void sendPresenceHeartbeat()
    }, 20000)

    return () => {
      isDisposed = true
      window.clearInterval(heartbeatInterval)

      const accessToken = localStorage.getItem('accessToken')
      if (accessToken) {
        void requestLeaveLobbyPresence(apiBaseUrl, accessToken, activeLobbyGameId)
      }
    }
  }, [activeLobbyGameId, apiBaseUrl])

  useEffect(() => {
    if (!activeLobbyGameId) {
      return undefined
    }

    const accessToken = localStorage.getItem('accessToken')
    if (!accessToken) {
      return undefined
    }

    const socketUrl = apiBaseUrl || window.location.origin
    const socket = io(socketUrl, {
      auth: { accessToken },
      transports: ['polling', 'websocket'],
    })

    let isDisposed = false

    const syncLobbyGameInBackground = async () => {
      if (isDisposed) {
        return
      }

      try {
        let activeToken = localStorage.getItem('accessToken') || accessToken
        let response = await requestGetLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
        let payload = await response.json().catch(() => null)

        if (response.status === 401) {
          const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

          if (refreshedAccessToken) {
            activeToken = refreshedAccessToken
            response = await requestGetLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
            payload = await response.json().catch(() => null)
          }
        }

        if (!isDisposed && response.ok && payload?.ok === true && payload?.game) {
          applyGameTeams(payload.game)
        }
      } catch {
        // Silently ignore realtime sync errors
      }
    }

    const handleLobbyGameUpdated = (payload) => {
      const payloadGameId = normalizePositiveInteger(payload?.game?.game_id ?? payload?.game_id)
      if (payloadGameId === activeLobbyGameId) {
        void syncLobbyGameInBackground()
      }
    }

    const handleGameTeamMemberUpdated = (payload) => {
      const payloadGameId = normalizePositiveInteger(payload?.game_id)
      if (payloadGameId === activeLobbyGameId) {
        void syncLobbyGameInBackground()
      }
    }

    const handleGameStatusUpdated = (payload) => {
      const payloadGameId = normalizePositiveInteger(payload?.game_id)
      if (payloadGameId === activeLobbyGameId) {
        void syncLobbyGameInBackground()
      }
    }

    const handleGameInviteUpdated = (payload) => {
      const payloadGameId = normalizePositiveInteger(payload?.game_id)
      if (payloadGameId !== activeLobbyGameId) {
        return
      }

      const invite = payload?.invite ?? null
      const action = typeof payload?.action === 'string' ? payload.action.trim().toLowerCase() : ''
      const senderUserId = typeof invite?.sender_user_id === 'string' ? invite.sender_user_id.trim() : ''

      if (!senderUserId || senderUserId !== currentUserId) {
        return
      }

      const recipientUserId = typeof invite?.user_id === 'string' ? invite.user_id.trim() : ''
      const recipientUsername = typeof invite?.recipient_username === 'string' ? invite.recipient_username.trim() : ''

      if (action === 'sent') {
        if (!recipientUsername && !recipientUserId) {
          return
        }

        setInvitedPlayers((previousPlayers) => {
          const alreadyExists = previousPlayers.some((player) => {
            const matchesUserId = recipientUserId && player.recipientUserId === recipientUserId
            const matchesName = recipientUsername && player.name.toLowerCase() === recipientUsername.toLowerCase()
            return matchesUserId || matchesName
          })

          if (alreadyExists) {
            return previousPlayers
          }

          return [
            ...previousPlayers,
            {
              id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
              name: recipientUsername || 'Invited player',
              recipientUserId,
              status: 'pending',
              assignedSlotKey: '',
            },
          ]
        })

        return
      }

      if (action === 'accepted' || action === 'declined') {
        setInvitedPlayers((previousPlayers) => previousPlayers.filter((player) => {
          const matchesUserId = recipientUserId && player.recipientUserId === recipientUserId
          const matchesName = recipientUsername && player.name.toLowerCase() === recipientUsername.toLowerCase()
          return !(matchesUserId || matchesName)
        }))
      }
    }

    socket.on('connect', () => {
      socket.emit('lobby:join')
      socket.emit('game:join', { gameId: activeLobbyGameId })
    })

    socket.on('lobby:game-updated', handleLobbyGameUpdated)
    socket.on('game:team-member-updated', handleGameTeamMemberUpdated)
    socket.on('game:status-updated', handleGameStatusUpdated)
    socket.on('game:invite-updated', handleGameInviteUpdated)

    return () => {
      isDisposed = true

      if (socket.connected) {
        socket.emit('game:leave', { gameId: activeLobbyGameId })
        socket.emit('lobby:leave')
      }

      if (socket.connected) {
        socket.disconnect()
      } else {
        socket.close()
      }
    }
  }, [activeLobbyGameId, apiBaseUrl, currentUserId])

  const selectedSlotLabel = useMemo(() => {
    if (!selectedSlotKey || !SLOT_META[selectedSlotKey]) return 'No slot selected'

    const teamName = SLOT_META[selectedSlotKey].teamKey === 'teamA' ? teamAName : teamBName
    return `${teamName} • ${SLOT_META[selectedSlotKey].roleLabel}`
  }, [selectedSlotKey, teamAName, teamBName])

  const handleJoinSlot = async (slotKey) => {
    if (!slotKey || !SLOT_META[slotKey]) return

    if (!activeLobbyGameId) {
      setStatus({ tone: 'error', message: 'Create or open a lobby first.' })
      return
    }

    const teamMemberId = slotTeamMemberIds[slotKey]
    const slotTeamName = SLOT_META[slotKey].teamKey === 'teamA' ? teamAName : teamBName
    const slotLabel = `${slotTeamName} • ${SLOT_META[slotKey].roleLabel}`

    if (!teamMemberId) {
      setStatus({ tone: 'error', message: 'Slot is not available yet. Try again in a moment.' })
      return
    }

    const existingOccupantId = slots[slotKey]

    if (existingOccupantId && existingOccupantId === currentUserId) {
      setStatus({ tone: 'success', message: 'You are already in this slot.' })
      return
    }

    if (existingOccupantId) {
      setStatus({ tone: 'error', message: 'Selected slot is already occupied.' })
      return
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to join a slot.' })
      return
    }

    setBotPickerSlotKey('')
    setSelectedBotName('')
    setIsJoiningSlotKey(slotKey)
    setStatus({ tone: 'pending', message: `Joining ${slotLabel}...` })

    try {
      let activeToken = accessToken
      let joinResponse = await requestJoinTeamMember(apiBaseUrl, activeToken, teamMemberId)
      let joinPayload = await joinResponse.json().catch(() => null)

      if (joinResponse.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          activeToken = refreshedAccessToken
          joinResponse = await requestJoinTeamMember(apiBaseUrl, activeToken, teamMemberId)
          joinPayload = await joinResponse.json().catch(() => null)
        }
      }

      if (!joinResponse.ok || joinPayload?.ok !== true) {
        throw new Error(typeof joinPayload?.error === 'string' ? joinPayload.error : 'Could not join slot')
      }

      if (!currentUserId) {
        throw new Error('Session user id is missing.')
      }

      setSlots((previousSlots) => {
        const nextSlots = { ...previousSlots }

        for (const existingSlotKey of Object.keys(nextSlots)) {
          if (nextSlots[existingSlotKey] === currentUserId) {
            nextSlots[existingSlotKey] = null
          }
        }

        nextSlots[slotKey] = currentUserId
        return nextSlots
      })

      setSlotPlayersById((previousPlayersById) => ({
        ...previousPlayersById,
        [currentUserId]: {
          id: currentUserId,
          name: currentPlayerName,
          avatar: currentUserAvatar,
          isBot: false,
        },
      }))

      setSelectedSlotKey(slotKey)

      setStatus({
        tone: 'success',
        message: `${currentPlayerName} joined ${slotLabel}.`,
      })

      const syncLobbyInBackground = async () => {
        try {
          let gameResponse = await requestGetLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
          let gamePayload = await gameResponse.json().catch(() => null)

          if (gameResponse.status === 401) {
            const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

            if (refreshedAccessToken) {
              activeToken = refreshedAccessToken
              gameResponse = await requestGetLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
              gamePayload = await gameResponse.json().catch(() => null)
            }
          }

          if (gameResponse.ok && gamePayload?.ok === true && gamePayload?.game) {
            applyGameTeams(gamePayload.game)
          }
        } catch {
          // Silently ignore sync errors
        }
      }

      void syncLobbyInBackground()
    } catch (error) {
      const isTimeoutError = error instanceof Error && error.name === 'AbortError'

      setStatus({
        tone: 'error',
        message: isTimeoutError
          ? 'Join request timed out. Please try again.'
          : error instanceof Error
            ? error.message
            : 'Could not join slot',
      })
    } finally {
      setIsJoiningSlotKey('')
    }
  }

  const handleLeaveSlot = async (slotKey) => {
    if (!slotKey || !SLOT_META[slotKey]) return

    if (!activeLobbyGameId) {
      setStatus({ tone: 'error', message: 'Create or open a lobby first.' })
      return
    }

    const teamMemberId = slotTeamMemberIds[slotKey]
    const slotTeamName = SLOT_META[slotKey].teamKey === 'teamA' ? teamAName : teamBName
    const slotLabel = `${slotTeamName} • ${SLOT_META[slotKey].roleLabel}`

    if (!teamMemberId) {
      setStatus({ tone: 'error', message: 'Slot is not available yet. Try again in a moment.' })
      return
    }

    const existingOccupantId = slots[slotKey]

    if (!existingOccupantId || existingOccupantId !== currentUserId) {
      setStatus({ tone: 'error', message: 'You are not occupying this slot.' })
      return
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to leave a slot.' })
      return
    }

    setIsLeavingTeamSlotKey(slotKey)
    setStatus({ tone: 'pending', message: `Leaving ${slotLabel}...` })

    try {
      let activeToken = accessToken
      let leaveResponse = await requestLeaveTeamMember(apiBaseUrl, activeToken, teamMemberId)
      let leavePayload = await leaveResponse.json().catch(() => null)

      if (leaveResponse.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          activeToken = refreshedAccessToken
          leaveResponse = await requestLeaveTeamMember(apiBaseUrl, activeToken, teamMemberId)
          leavePayload = await leaveResponse.json().catch(() => null)
        }
      }

      if (!leaveResponse.ok || leavePayload?.ok !== true) {
        throw new Error(typeof leavePayload?.error === 'string' ? leavePayload.error : 'Could not leave slot')
      }

      setSlots((previousSlots) => ({
        ...previousSlots,
        [slotKey]: null,
      }))

      setStatus({
        tone: 'success',
        message: `You left ${slotLabel}.`,
      })

      const syncLobbyInBackground = async () => {
        try {
          let gameResponse = await requestGetLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
          let gamePayload = await gameResponse.json().catch(() => null)

          if (gameResponse.status === 401) {
            const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

            if (refreshedAccessToken) {
              activeToken = refreshedAccessToken
              gameResponse = await requestGetLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
              gamePayload = await gameResponse.json().catch(() => null)
            }
          }

          if (gameResponse.ok && gamePayload?.ok === true && gamePayload?.game) {
            applyGameTeams(gamePayload.game)
          }
        } catch {
          // Silently ignore sync errors
        }
      }

      void syncLobbyInBackground()
    } catch (error) {
      const isTimeoutError = error instanceof Error && error.name === 'AbortError'

      setStatus({
        tone: 'error',
        message: isTimeoutError
          ? 'Leave request timed out. Please try again.'
          : error instanceof Error
            ? error.message
            : 'Could not leave slot',
      })
    } finally {
      setIsLeavingTeamSlotKey('')
    }
  }

  const loadBotNames = async () => {
    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to load bot users.' })
      return []
    }

    setIsLoadingBotNames(true)

    try {
      let activeToken = accessToken
      let response = await requestGetBotNames(apiBaseUrl, activeToken)
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          activeToken = refreshedAccessToken
          response = await requestGetBotNames(apiBaseUrl, activeToken)
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok || payload?.ok !== true || !Array.isArray(payload?.bot_names)) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not load bot users')
      }

      const normalizedBotNames = payload.bot_names
        .map((botName) => (typeof botName === 'string' ? botName.trim() : ''))
        .filter((botName) => Boolean(botName))

      setBotNames(normalizedBotNames)
      setHasLoadedBotNames(true)
      return normalizedBotNames
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not load bot users',
      })
      return []
    } finally {
      setIsLoadingBotNames(false)
    }
  }

  const handleOpenAddBot = async (slotKey) => {
    if (!slotKey || !SLOT_META[slotKey]) return

    if (!activeLobbyGameId) {
      setStatus({ tone: 'error', message: 'Create or open a lobby first.' })
      return
    }

    const teamMemberId = slotTeamMemberIds[slotKey]

    if (!teamMemberId) {
      setStatus({ tone: 'error', message: 'Slot is not available yet. Try again in a moment.' })
      return
    }

    if (slots[slotKey]) {
      setStatus({ tone: 'error', message: 'Selected slot is already occupied.' })
      return
    }

    setSelectedSlotKey(slotKey)
    setBotPickerSlotKey(slotKey)

    const gameOccupiedBotNames = new Set(
      Object.values(slots)
        .map((occupantId) => {
          if (!occupantId) {
            return ''
          }

          const occupantName = slotPlayersById[occupantId]?.name
          return typeof occupantName === 'string' ? occupantName.trim() : ''
        })
        .filter((occupantName) => Boolean(occupantName) && occupantName.toUpperCase().endsWith('_BOT'))
        .map((occupantName) => occupantName.toLowerCase())
    )

    const sourceBotNames = hasLoadedBotNames ? botNames : await loadBotNames()
    const availableBotNames = sourceBotNames.filter(
      (botName) => !gameOccupiedBotNames.has(botName.toLowerCase())
    )

    if (availableBotNames.length !== botNames.length) {
      setBotNames(availableBotNames)
    }

    if (availableBotNames.length === 0) {
      setSelectedBotName('')
      return
    }

    const defaultBotName = availableBotNames[0]
    setSelectedBotName(defaultBotName)
  }

  const handleCancelAddBot = () => {
    setBotPickerSlotKey('')
    setSelectedBotName('')
  }

  const handleAddBotToSlot = async (slotKey) => {
    if (!slotKey || !SLOT_META[slotKey]) return

    if (!activeLobbyGameId) {
      setStatus({ tone: 'error', message: 'Create or open a lobby first.' })
      return
    }

    const teamMemberId = slotTeamMemberIds[slotKey]
    const normalizedBotName = typeof selectedBotName === 'string' ? selectedBotName.trim() : ''
    const slotTeamName = SLOT_META[slotKey].teamKey === 'teamA' ? teamAName : teamBName
    const slotLabel = `${slotTeamName} • ${SLOT_META[slotKey].roleLabel}`

    if (!teamMemberId) {
      setStatus({ tone: 'error', message: 'Slot is not available yet. Try again in a moment.' })
      return
    }

    if (slots[slotKey]) {
      setStatus({ tone: 'error', message: 'Selected slot is already occupied.' })
      return
    }

    if (!normalizedBotName) {
      setStatus({ tone: 'error', message: 'Select a bot user first.' })
      return
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to add a bot.' })
      return
    }

    setIsAddingBotSlotKey(slotKey)
    setStatus({ tone: 'pending', message: `Adding ${normalizedBotName} to ${slotLabel}...` })

    try {
      let activeToken = accessToken
      let response = await requestJoinBotTeamMember(apiBaseUrl, activeToken, teamMemberId, normalizedBotName)
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          activeToken = refreshedAccessToken
          response = await requestJoinBotTeamMember(apiBaseUrl, activeToken, teamMemberId, normalizedBotName)
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not add bot to slot')
      }

      const resolvedBotUserId = typeof payload?.team_member?.user_id === 'string'
        ? payload.team_member.user_id.trim()
        : ''

      if (!resolvedBotUserId) {
        throw new Error('Bot user id is missing from response.')
      }

      setSlots((previousSlots) => ({
        ...previousSlots,
        [slotKey]: resolvedBotUserId,
      }))

      setSlotPlayersById((previousPlayersById) => ({
        ...previousPlayersById,
        [resolvedBotUserId]: {
          id: resolvedBotUserId,
          name: normalizedBotName,
          avatar: '',
          isBot: true,
        },
      }))

      setBotNames((previousBotNames) => (
        previousBotNames.filter((botName) => botName.toLowerCase() !== normalizedBotName.toLowerCase())
      ))

      setBotPickerSlotKey('')
      setSelectedBotName('')

      setStatus({
        tone: 'success',
        message: `${normalizedBotName} joined ${slotLabel}.`,
      })

      const syncLobbyInBackground = async () => {
        try {
          let gameResponse = await requestGetLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
          let gamePayload = await gameResponse.json().catch(() => null)

          if (gameResponse.status === 401) {
            const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

            if (refreshedAccessToken) {
              activeToken = refreshedAccessToken
              gameResponse = await requestGetLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
              gamePayload = await gameResponse.json().catch(() => null)
            }
          }

          if (gameResponse.ok && gamePayload?.ok === true && gamePayload?.game) {
            applyGameTeams(gamePayload.game)
          }
        } catch {
          // Silently ignore sync errors
        }
      }

      void syncLobbyInBackground()
    } catch (error) {
      const isTimeoutError = error instanceof Error && error.name === 'AbortError'
      const normalizedMessage = error instanceof Error ? error.message : 'Could not add bot to slot'
      const normalizedMessageLower = normalizedMessage.toLowerCase()
      const isBotAlreadyInAnotherGameError =
        normalizedMessageLower.includes('already in another active game') ||
        normalizedMessageLower.includes('already in active game')

      if (isBotAlreadyInAnotherGameError) {
        const remainingBotNames = botNames.filter(
          (botName) => botName.toLowerCase() !== normalizedBotName.toLowerCase()
        )

        setBotNames(remainingBotNames)

        if (selectedBotName.toLowerCase() === normalizedBotName.toLowerCase()) {
          setSelectedBotName(remainingBotNames[0] ?? '')
        }
      }

      setStatus({
        tone: 'error',
        message: isTimeoutError
          ? 'Add bot request timed out. Please try again.'
          : isBotAlreadyInAnotherGameError
            ? 'This bot is unavailable and was removed from the list.'
            : error instanceof Error
              ? error.message
            : 'Could not add bot to slot',
      })
    } finally {
      setIsAddingBotSlotKey('')
    }
  }

  const handleSendInvite = async () => {
    const normalizedInviteInput = typeof inviteInput === 'string' ? inviteInput.trim() : ''

    if (!normalizedInviteInput) {
      setStatus({ tone: 'error', message: 'Enter username to invite.' })
      return
    }

    if (!activeLobbyGameId) {
      setStatus({ tone: 'error', message: 'Create or open a lobby first.' })
      return
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to invite a player.' })
      return
    }

    const alreadyInvited = invitedPlayers.some(
      (player) => player.name.toLowerCase() === normalizedInviteInput.toLowerCase()
    )

    if (alreadyInvited) {
      setStatus({ tone: 'error', message: 'This player is already invited.' })
      return
    }

    setStatus({ tone: 'pending', message: `Sending invite to ${normalizedInviteInput}...` })

    try {
      let activeToken = accessToken
      let response = await requestSendInboxGameInvite(apiBaseUrl, activeToken, activeLobbyGameId, normalizedInviteInput)
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          activeToken = refreshedAccessToken
          response = await requestSendInboxGameInvite(apiBaseUrl, activeToken, activeLobbyGameId, normalizedInviteInput)
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok || payload?.ok !== true || !payload?.invite) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not send invite')
      }

      const invitedPlayerId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const recipientName = typeof payload.invite.recipient_username === 'string' && payload.invite.recipient_username.trim()
        ? payload.invite.recipient_username.trim()
        : normalizedInviteInput
      const recipientUserId = typeof payload.invite.user_id === 'string' ? payload.invite.user_id.trim() : ''

      const newPlayer = {
        id: invitedPlayerId,
        name: recipientName,
        recipientUserId,
        status: 'pending',
        assignedSlotKey: '',
      }

      setInvitedPlayers((previousPlayers) => [...previousPlayers, newPlayer])
      setStatus({ tone: 'success', message: `Invite sent to ${recipientName}.` })
      setInviteInput('')
    } catch (error) {
      const isTimeoutError = error instanceof Error && error.name === 'AbortError'

      setStatus({
        tone: 'error',
        message: isTimeoutError
          ? 'Invite request timed out. Please try again.'
          : error instanceof Error
            ? error.message
            : 'Could not send invite',
      })
    }
  }

  const handleGenerateInviteLink = async () => {
    if (!activeLobbyGameId) {
      setStatus({ tone: 'error', message: 'Create or open a lobby first.' })
      return
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to generate invite link.' })
      return
    }

    setStatus({ tone: 'pending', message: 'Generating invite link...' })

    try {
      let activeToken = accessToken
      let response = await requestGetGameInviteLink(apiBaseUrl, activeToken, activeLobbyGameId)
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          activeToken = refreshedAccessToken
          response = await requestGetGameInviteLink(apiBaseUrl, activeToken, activeLobbyGameId)
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok || payload?.ok !== true || !payload?.invite) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not generate invite link')
      }

      const inviteUrlFromApi = normalizeBaseUrl(payload.invite.invite_url)
      const invitePathFromApi = typeof payload.invite.invite_path === 'string' ? payload.invite.invite_path.trim() : ''
      const fallbackInvitePath = typeof payload.invite.invite_token === 'string' && payload.invite.invite_token.trim()
        ? `/join/${encodeURIComponent(payload.invite.invite_token.trim())}`
        : ''

      const invitePath = invitePathFromApi || fallbackInvitePath
      const publicBaseUrl = getPublicAppBaseUrl()
      const shouldUseApiInviteUrl = inviteUrlFromApi && !isLocalhostBaseUrl(inviteUrlFromApi)
      const resolvedInviteUrl = shouldUseApiInviteUrl
        ? inviteUrlFromApi
        : invitePath
          ? `${publicBaseUrl}${invitePath}`
          : ''

      if (!resolvedInviteUrl) {
        throw new Error('Could not generate invite link')
      }

      setInviteLink(resolvedInviteUrl)
      setStatus({ tone: 'success', message: 'Invite link generated.' })
    } catch (error) {
      const isTimeoutError = error instanceof Error && error.name === 'AbortError'

      setStatus({
        tone: 'error',
        message: isTimeoutError
          ? 'Invite link request timed out. Please try again.'
          : error instanceof Error
            ? error.message
            : 'Could not generate invite link',
      })
    }
  }

  const handleCopyInviteLink = async () => {
    if (!inviteLink) {
      setStatus({ tone: 'error', message: 'Generate invite link first.' })
      return
    }

    const fallbackCopy = () => {
      const helperTextArea = document.createElement('textarea')
      helperTextArea.value = inviteLink
      helperTextArea.style.position = 'fixed'
      helperTextArea.style.opacity = '0'
      helperTextArea.style.pointerEvents = 'none'
      document.body.appendChild(helperTextArea)
      helperTextArea.focus()
      helperTextArea.select()
      document.execCommand('copy')
      document.body.removeChild(helperTextArea)
    }

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(inviteLink)
      } else {
        fallbackCopy()
      }

      setStatus({ tone: 'success', message: 'Invite link copied.' })
    } catch {
      setStatus({ tone: 'error', message: 'Could not copy invite link. Copy it manually.' })
    }
  }

  const handleRemoveBotFromSlot = async (slotKey) => {
    if (!slotKey || !SLOT_META[slotKey]) return

    if (!activeLobbyGameId) {
      setStatus({ tone: 'error', message: 'Create or open a lobby first.' })
      return
    }

    const teamMemberId = slotTeamMemberIds[slotKey]
    const occupantId = slots[slotKey]
    const occupant = occupantId ? slotPlayersById[occupantId] : null
    const slotTeamName = SLOT_META[slotKey].teamKey === 'teamA' ? teamAName : teamBName
    const slotLabel = `${slotTeamName} • ${SLOT_META[slotKey].roleLabel}`

    if (!teamMemberId) {
      setStatus({ tone: 'error', message: 'Slot is not available yet. Try again in a moment.' })
      return
    }

    if (!occupant || occupant.isBot !== true) {
      setStatus({ tone: 'error', message: 'This slot is not occupied by a bot.' })
      return
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to remove a bot.' })
      return
    }

    setIsRemovingBotSlotKey(slotKey)
    setStatus({ tone: 'pending', message: `Removing bot from ${slotLabel}...` })

    try {
      let activeToken = accessToken
      let response = await requestRemoveBotTeamMember(apiBaseUrl, activeToken, teamMemberId)
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          activeToken = refreshedAccessToken
          response = await requestRemoveBotTeamMember(apiBaseUrl, activeToken, teamMemberId)
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not remove bot from slot')
      }

      const removedBotName = typeof occupant?.name === 'string' ? occupant.name.trim() : ''

      setSlots((previousSlots) => ({
        ...previousSlots,
        [slotKey]: null,
      }))

      if (removedBotName) {
        setBotNames((previousBotNames) => {
          const alreadyExists = previousBotNames.some(
            (botName) => botName.toLowerCase() === removedBotName.toLowerCase()
          )

          if (alreadyExists) {
            return previousBotNames
          }

          return [...previousBotNames, removedBotName].sort((firstBotName, secondBotName) => (
            firstBotName.localeCompare(secondBotName)
          ))
        })
      }

      setStatus({
        tone: 'success',
        message: `Bot removed from ${slotLabel}.`,
      })

      const syncLobbyInBackground = async () => {
        try {
          let gameResponse = await requestGetLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
          let gamePayload = await gameResponse.json().catch(() => null)

          if (gameResponse.status === 401) {
            const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

            if (refreshedAccessToken) {
              activeToken = refreshedAccessToken
              gameResponse = await requestGetLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
              gamePayload = await gameResponse.json().catch(() => null)
            }
          }

          if (gameResponse.ok && gamePayload?.ok === true && gamePayload?.game) {
            applyGameTeams(gamePayload.game)
          }
        } catch {
          // Silently ignore sync errors
        }
      }

      void syncLobbyInBackground()
    } catch (error) {
      const isTimeoutError = error instanceof Error && error.name === 'AbortError'

      setStatus({
        tone: 'error',
        message: isTimeoutError
          ? 'Remove bot request timed out. Please try again.'
          : error instanceof Error
            ? error.message
            : 'Could not remove bot from slot',
      })
    } finally {
      setIsRemovingBotSlotKey('')
    }
  }

  useEffect(() => {
    if (!activeLobbyGameId) {
      setGameName(DEFAULT_GAME_NAME)
      setDefaultGameName(DEFAULT_GAME_NAME)
      setTimeControl('5+0 Blitz')
      setRatedGame(false)
      setAllowSpectators(true)
      setPublicRoom(true)
      setTeamAId(null)
      setTeamBId(null)
      setDefaultTeamAName('Team A')
      setDefaultTeamBName('Team B')
      setSlots({ ...EMPTY_SLOTS })
      setIsJoiningSlotKey('')
      setIsAddingBotSlotKey('')
      setIsLeavingTeamSlotKey('')
      setIsRemovingBotSlotKey('')
      setBotPickerSlotKey('')
      setSelectedBotName('')
      setSlotTeamMemberIds({
        teamAWhite: null,
        teamABlack: null,
        teamBWhite: null,
        teamBBlack: null,
      })
      setSlotPlayersById({})
      setBotNames([])
      setHasLoadedBotNames(false)
      setInviteLink('')
      return undefined
    }

    let isDisposed = false

    const loadLobbyGameDetails = async () => {
      const accessToken = localStorage.getItem('accessToken')

      if (!accessToken) {
        return
      }

      setIsSyncingLobbyGame(true)

      try {
        let response = await requestGetLobbyGame(apiBaseUrl, accessToken, activeLobbyGameId)
        let payload = await response.json().catch(() => null)

        if (response.status === 401) {
          const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

          if (refreshedAccessToken) {
            response = await requestGetLobbyGame(apiBaseUrl, refreshedAccessToken, activeLobbyGameId)
            payload = await response.json().catch(() => null)
          }
        }

        if (response.status === 403 || response.status === 404) {
          if (!isDisposed) {
            setAccessDenied(true)
          }
          return
        }

        if (!response.ok || payload?.ok !== true || !payload?.game) {
          throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not load lobby game data')
        }

        if (!isDisposed) {
          applyGameTeams(payload.game)
        }
      } catch (error) {
        if (!isDisposed) {
          setStatus({
            tone: 'error',
            message: error instanceof Error ? error.message : 'Could not load lobby game data',
          })
        }
      } finally {
        if (!isDisposed) {
          setIsSyncingLobbyGame(false)
        }
      }
    }

    loadLobbyGameDetails()

    return () => {
      isDisposed = true
    }
  }, [activeLobbyGameId, apiBaseUrl])

  const updateLobbySettingsInDatabase = async (settingsPayload, pendingMessage) => {
    if (!activeLobbyGameId) {
      return { ok: true }
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to update game settings.' })
      return { ok: false }
    }

    setIsUpdatingLobbySettings(true)
    setStatus({
      tone: 'pending',
      message: pendingMessage,
    })

    try {
      let activeToken = accessToken
      let response = await requestUpdateLobbyGameSettings(
        apiBaseUrl,
        activeToken,
        activeLobbyGameId,
        settingsPayload
      )
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          activeToken = refreshedAccessToken
          response = await requestUpdateLobbyGameSettings(
            apiBaseUrl,
            activeToken,
            activeLobbyGameId,
            settingsPayload
          )
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok || payload?.ok !== true || !payload?.game) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not update game settings')
      }

      applyGameTeams(payload.game)
      setStatus({ tone: 'success', message: 'Game settings updated in database.' })

      return { ok: true }
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not update game settings',
      })

      return { ok: false }
    } finally {
      setIsUpdatingLobbySettings(false)
    }
  }

  const handleTimeControlChange = async (event) => {
    const nextValue = typeof event?.target?.value === 'string' ? event.target.value : ''
    const previousValue = timeControl

    setTimeControl(nextValue)

    if (!activeLobbyGameId) {
      return
    }

    const parsedPreset = parseTimeControlPreset(nextValue)

    if (!parsedPreset.time_control || !parsedPreset.increment) {
      setTimeControl(previousValue)
      setStatus({ tone: 'error', message: 'Invalid time control selection.' })
      return
    }

    const updateResult = await updateLobbySettingsInDatabase(
      {
        time_control: parsedPreset.time_control,
        increment: parsedPreset.increment,
      },
      'Updating time control...'
    )

    if (!updateResult.ok) {
      setTimeControl(previousValue)
    }
  }

  const handleAllowSpectatorsChange = async (event) => {
    const nextValue = Boolean(event?.target?.checked)
    const previousValue = allowSpectators

    setAllowSpectators(nextValue)

    if (!activeLobbyGameId) {
      return
    }

    const updateResult = await updateLobbySettingsInDatabase(
      { allow_spectators: nextValue },
      'Updating spectators setting...'
    )

    if (!updateResult.ok) {
      setAllowSpectators(previousValue)
    }
  }

  const handlePublicRoomChange = async (event) => {
    const nextValue = Boolean(event?.target?.checked)
    const previousValue = publicRoom

    setPublicRoom(nextValue)

    if (!activeLobbyGameId) {
      return
    }

    const updateResult = await updateLobbySettingsInDatabase(
      { public_game: nextValue },
      'Updating room visibility...'
    )

    if (!updateResult.ok) {
      setPublicRoom(previousValue)
    }
  }

  const handleRatedGameChange = async (event) => {
    const nextValue = Boolean(event?.target?.checked)
    const previousValue = ratedGame

    setRatedGame(nextValue)

    if (!activeLobbyGameId) {
      return
    }

    const updateResult = await updateLobbySettingsInDatabase(
      { rated_game: nextValue },
      'Updating rated game setting...'
    )

    if (!updateResult.ok) {
      setRatedGame(previousValue)
    }
  }

  const handleConfirmGameName = async () => {
    if (!activeLobbyGameId) {
      setStatus({ tone: 'error', message: 'Create a lobby first to update game name.' })
      return
    }

    const normalizedInputGameName = typeof gameName === 'string' ? gameName.trim() : ''
    const normalizedDefaultGameName = typeof defaultGameName === 'string' ? defaultGameName.trim() : ''

    if (!normalizedInputGameName) {
      setStatus({ tone: 'error', message: 'Game name cannot be empty.' })
      return
    }

    if (normalizedInputGameName === normalizedDefaultGameName) {
      return
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to update game name.' })
      return
    }

    setIsConfirmingGameName(true)
    setStatus({
      tone: 'pending',
      message: 'Confirming game name...',
    })

    try {
      let activeToken = accessToken
      let response = await requestUpdateLobbyGameName(
        apiBaseUrl,
        activeToken,
        activeLobbyGameId,
        normalizedInputGameName
      )
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          activeToken = refreshedAccessToken
          response = await requestUpdateLobbyGameName(
            apiBaseUrl,
            activeToken,
            activeLobbyGameId,
            normalizedInputGameName
          )
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok || payload?.ok !== true || !payload?.game) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not update game name')
      }

      applyGameTeams(payload.game)
      setStatus({ tone: 'success', message: 'Game name updated in database.' })
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not update game name',
      })
    } finally {
      setIsConfirmingGameName(false)
    }
  }

  const handleConfirmTeamName = async (teamKey) => {
    if (!activeLobbyGameId) {
      setStatus({ tone: 'error', message: 'Create a lobby first to update team names.' })
      return
    }

    const targetTeamId = teamKey === 'teamA' ? teamAId : teamBId
    const inputTeamName = teamKey === 'teamA' ? teamAName : teamBName
    const defaultTeamName = teamKey === 'teamA' ? defaultTeamAName : defaultTeamBName

    const normalizedInputTeamName = typeof inputTeamName === 'string' ? inputTeamName.trim() : ''
    const normalizedDefaultTeamName = typeof defaultTeamName === 'string' ? defaultTeamName.trim() : ''

    if (!targetTeamId) {
      setStatus({ tone: 'error', message: 'Lobby team data is still loading. Try again in a moment.' })
      return
    }

    if (!normalizedInputTeamName) {
      setStatus({ tone: 'error', message: 'Team name cannot be empty.' })
      return
    }

    if (normalizedInputTeamName === normalizedDefaultTeamName) {
      return
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to update team name.' })
      return
    }

    setIsConfirmingTeamKey(teamKey)
    setStatus({
      tone: 'pending',
      message: `Confirming ${teamKey === 'teamA' ? 'Team A' : 'Team B'} name...`,
    })

    try {
      let activeToken = accessToken
      let response = await requestUpdateLobbyTeamName(
        apiBaseUrl,
        activeToken,
        activeLobbyGameId,
        targetTeamId,
        normalizedInputTeamName
      )
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          activeToken = refreshedAccessToken
          response = await requestUpdateLobbyTeamName(
            apiBaseUrl,
            activeToken,
            activeLobbyGameId,
            targetTeamId,
            normalizedInputTeamName
          )
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok || payload?.ok !== true || !payload?.game) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not update team name')
      }

      applyGameTeams(payload.game)
      setStatus({ tone: 'success', message: 'Team name updated in database.' })
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not update team name',
      })
    } finally {
      setIsConfirmingTeamKey('')
    }
  }

  const handleCancelLobby = async () => {
    if (!activeLobbyGameId) {
      window.location.assign('/home')
      return
    }

    const accessToken = localStorage.getItem('accessToken')
    if (!accessToken) {
      window.location.assign('/home')
      return
    }

    setIsLeavingLobby(true)
    setStatus({ tone: 'pending', message: 'Leaving lobby...' })

    try {
      let response = await requestDeleteLobbyGame(apiBaseUrl, accessToken, activeLobbyGameId)
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          response = await requestDeleteLobbyGame(apiBaseUrl, refreshedAccessToken, activeLobbyGameId)
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok && response.status !== 404) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not leave lobby')
      }

      setActiveLobbyGameId(null)
      setStatus({ tone: 'success', message: 'Lobby closed. Redirecting...' })
      window.setTimeout(() => {
        window.location.assign('/home')
      }, 180)
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not leave lobby',
      })
    } finally {
      setIsLeavingLobby(false)
    }
  }

  const handleCreateRoom = async (event) => {
    event.preventDefault()

    if (activeLobbyGameId) {
      setStatus({
        tone: 'success',
        message: `Lobby already active (ID #${activeLobbyGameId}).`,
      })
      return
    }

    if (!teamAName.trim() || !teamBName.trim()) {
      setStatus({ tone: 'error', message: 'Both team names are required.' })
      return
    }

    const createPayload = {
      ...parseTimeControlPreset(timeControl),
      game_name: typeof gameName === 'string' && gameName.trim() ? gameName.trim() : DEFAULT_GAME_NAME,
      rated_game: Boolean(ratedGame),
      allow_spectators: Boolean(allowSpectators),
      public_game: Boolean(publicRoom),
    }

    if (!createPayload.time_control || !createPayload.increment) {
      setStatus({ tone: 'error', message: 'Invalid time control selection.' })
      return
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to create a game.' })
      return
    }

    setIsCreatingRoom(true)
    setStatus({ tone: 'pending', message: 'Creating game room...' })

    try {
      let response = await requestCreateGame(apiBaseUrl, accessToken, createPayload)
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          response = await requestCreateGame(apiBaseUrl, refreshedAccessToken, createPayload)
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok || payload?.ok !== true || !payload?.game) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not create game room')
      }

      const gameId = payload.game.game_id
      const normalizedGameId = normalizePositiveInteger(gameId)
      const createdGameName =
        typeof payload.game.game_name === 'string' && payload.game.game_name.trim()
          ? payload.game.game_name.trim()
          : createPayload.game_name

      if (normalizedGameId) {
        setActiveLobbyGameId(normalizedGameId)
      }

      setGameName(createdGameName)
      setDefaultGameName(createdGameName)

      setTimeControl(resolveTimeControlPresetLabel(payload.game.time_control, payload.game.increment, timeControl))
      setRatedGame(typeof payload.game.rated_game === 'boolean' ? payload.game.rated_game : createPayload.rated_game)
      setAllowSpectators(
        typeof payload.game.allow_spectators === 'boolean'
          ? payload.game.allow_spectators
          : createPayload.allow_spectators
      )
      setPublicRoom(typeof payload.game.public_game === 'boolean' ? payload.game.public_game : createPayload.public_game)

      setStatus({
        tone: 'success',
        message: Number.isInteger(gameId)
          ? `Game created successfully (ID #${gameId}).`
          : 'Game created successfully.',
      })
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not create game room',
      })
    } finally {
      setIsCreatingRoom(false)
    }
  }

  const areAllPlayerSlotsFilled = useMemo(() => (
    Object.values(slots).every((slotUserId) => typeof slotUserId === 'string' && slotUserId.trim() !== '')
  ), [slots])

  const handleStartGame = async () => {
    if (!activeLobbyGameId) {
      setStatus({ tone: 'error', message: 'Create a lobby first.' })
      return
    }

    if (!areAllPlayerSlotsFilled) {
      setStatus({ tone: 'error', message: 'All 4 player slots must be filled before starting the game.' })
      return
    }

    const accessToken = localStorage.getItem('accessToken')

    if (!accessToken) {
      setStatus({ tone: 'error', message: 'Log in first to start the game.' })
      return
    }

    setIsStartingGame(true)
    setStatus({ tone: 'pending', message: 'Starting game...' })

    try {
      let activeToken = accessToken
      let response = await requestStartLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
      let payload = await response.json().catch(() => null)

      if (response.status === 401) {
        const refreshedAccessToken = await refreshAccessToken(apiBaseUrl)

        if (refreshedAccessToken) {
          activeToken = refreshedAccessToken
          response = await requestStartLobbyGame(apiBaseUrl, activeToken, activeLobbyGameId)
          payload = await response.json().catch(() => null)
        }
      }

      if (!response.ok || payload?.ok !== true || !payload?.game) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not start game')
      }

      const startedGameId = normalizePositiveInteger(payload.game.game_id) ?? activeLobbyGameId
      setStatus({ tone: 'success', message: 'Game started. Redirecting...' })
      window.setTimeout(() => {
        window.location.assign(`/game/${encodeURIComponent(String(startedGameId))}`)
      }, 120)
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not start game',
      })
    } finally {
      setIsStartingGame(false)
    }
  }

  const handleCreateOrStart = async (event) => {
    if (activeLobbyGameId) {
      event.preventDefault()
      await handleStartGame()
      return
    }

    await handleCreateRoom(event)
  }

  const normalizedGameNameForConfirm = typeof gameName === 'string' ? gameName.trim() : ''
  const normalizedDefaultGameNameForConfirm = typeof defaultGameName === 'string' ? defaultGameName.trim() : ''
  const hasGameNameChanges = Boolean(
    activeLobbyGameId &&
    normalizedGameNameForConfirm &&
    normalizedGameNameForConfirm !== normalizedDefaultGameNameForConfirm
  )

  const renderTeamCard = (teamKey, teamName, setTeamName) => {
    const slotKeys = TEAM_SLOT_ORDER[teamKey]
    const defaultTeamName = teamKey === 'teamA' ? defaultTeamAName : defaultTeamBName
    const normalizedTeamName = typeof teamName === 'string' ? teamName.trim() : ''
    const normalizedDefaultTeamName = typeof defaultTeamName === 'string' ? defaultTeamName.trim() : ''
    const hasNameChanges = Boolean(
      activeLobbyGameId &&
      normalizedTeamName &&
      normalizedTeamName !== normalizedDefaultTeamName
    )
    const isConfirmingThisTeam = isConfirmingTeamKey === teamKey

    return (
      <div className="rounded-xl border border-slate-700/60 bg-slate-900/75 p-4">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={teamName}
            onChange={(event) => setTeamName(event.target.value)}
            disabled={isSyncingLobbyGame || isLeavingLobby || isConfirmingTeamKey !== '' || isConfirmingGameName || isUpdatingLobbySettings}
            className="w-full flex-1 rounded-lg border border-slate-600 bg-slate-800/70 px-3 py-2 text-sm font-semibold text-white outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-70"
            placeholder="Team name"
          />

          {hasNameChanges ? (
            <button
              type="button"
              onClick={() => handleConfirmTeamName(teamKey)}
              disabled={isSyncingLobbyGame || isLeavingLobby || isConfirmingTeamKey !== '' || isConfirmingGameName || isUpdatingLobbySettings}
              className="rounded-md border border-indigo-500/80 bg-indigo-500/20 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-indigo-100 transition-colors duration-150 hover:border-indigo-400 hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isConfirmingThisTeam ? 'Confirming...' : 'Confirm'}
            </button>
          ) : null}
        </div>

        <div className="mt-3 space-y-2">
          {slotKeys.map((slotKey) => {
            const roleLabel = SLOT_META[slotKey].roleLabel
            const occupantId = slots[slotKey]
            const occupant = occupantId ? slotPlayersById[occupantId] : null
            const isSelected = selectedSlotKey === slotKey
            const isJoiningThisSlot = isJoiningSlotKey === slotKey
            const isAddingBotToThisSlot = isAddingBotSlotKey === slotKey
            const isLeavingThisSlot = isLeavingTeamSlotKey === slotKey
            const isRemovingBotFromThisSlot = isRemovingBotSlotKey === slotKey
            const isBotPickerOpen = botPickerSlotKey === slotKey
            const isJoiningOrAdding = isJoiningSlotKey !== '' || isAddingBotSlotKey !== '' || isLeavingTeamSlotKey !== '' || isRemovingBotSlotKey !== ''
            const areSlotActionsDisabled = isSyncingLobbyGame || isLeavingLobby || isJoiningOrAdding || !activeLobbyGameId

            return (
              <div
                key={slotKey}
                onClick={() => setSelectedSlotKey(slotKey)}
                className={`relative cursor-pointer rounded-lg border p-3 ${isSelected ? 'border-indigo-400 bg-slate-800/90' : 'border-slate-700/60 bg-slate-800/60'}`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-300">{roleLabel}</span>
                  {!occupant ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleJoinSlot(slotKey)}
                        disabled={areSlotActionsDisabled}
                        className="rounded-md border border-slate-500 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-200 transition-colors duration-150 hover:border-slate-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isJoiningThisSlot ? 'Joining...' : 'Join'}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          void handleOpenAddBot(slotKey)
                        }}
                        disabled={areSlotActionsDisabled || isLoadingBotNames}
                        className="rounded-md border border-indigo-500/70 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-indigo-200 transition-colors duration-150 hover:border-indigo-300 hover:text-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isAddingBotToThisSlot ? 'Adding...' : isLoadingBotNames && isBotPickerOpen ? 'Loading...' : 'Add Bot'}
                      </button>
                    </div>
                  ) : occupantId === currentUserId ? (
                    <div className="relative">
                      <span className="rounded-md border border-emerald-500/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-200">
                        You
                      </span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleLeaveSlot(slotKey)
                        }}
                        disabled={areSlotActionsDisabled || isLeavingThisSlot}
                        className="absolute right-0 top-full mt-2 rounded-md border border-rose-500/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-rose-200 transition-colors duration-150 hover:border-rose-400 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isLeavingThisSlot ? 'Leaving...' : 'Leave'}
                      </button>
                    </div>
                  ) : occupant?.isBot === true ? (
                    <div className="relative">
                      <span className="rounded-md border border-emerald-500/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-200">
                        Joined
                      </span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleRemoveBotFromSlot(slotKey)
                        }}
                        disabled={areSlotActionsDisabled || isRemovingBotFromThisSlot}
                        className="absolute right-0 top-full mt-2 rounded-md border border-rose-500/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-rose-200 transition-colors duration-150 hover:border-rose-400 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isRemovingBotFromThisSlot ? 'Removing...' : 'Remove'}
                      </button>
                    </div>
                  ) : (
                    <span className="rounded-md border border-emerald-500/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-200">
                      Joined
                    </span>
                  )}
                </div>

                {occupant ? (
                  <div className="flex items-center gap-2">
                      {occupant.avatar ? (
                        <img
                          src={occupant.avatar}
                          alt={`${occupant.name} avatar`}
                          className="h-8 w-8 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600/80 text-xs font-bold text-white">
                          {getPlayerInitial(occupant.name)}
                        </div>
                      )}
                    <span className="text-sm font-medium text-slate-100">{occupant.name}</span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-slate-400">Empty slot</p>

                    {isBotPickerOpen ? (
                      <div className="space-y-2 rounded-md border border-slate-700/80 bg-slate-900/70 p-2">
                        <select
                          value={selectedBotName}
                          onChange={(event) => setSelectedBotName(event.target.value)}
                          disabled={isAddingBotToThisSlot || isLoadingBotNames || botNames.length === 0}
                          className="w-full rounded-md border border-slate-600 bg-slate-800/90 px-2 py-1 text-xs text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {botNames.length === 0 ? <option value="">No bots available</option> : null}
                          {botNames.map((botName) => (
                            <option key={botName} value={botName}>{botName}</option>
                          ))}
                        </select>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              void handleAddBotToSlot(slotKey)
                            }}
                            disabled={isAddingBotToThisSlot || isLoadingBotNames || !selectedBotName}
                            className="rounded-md border border-indigo-500/80 bg-indigo-500/20 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-indigo-100 transition-colors duration-150 hover:border-indigo-400 hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isAddingBotToThisSlot ? 'Adding...' : 'Confirm Bot'}
                          </button>

                          <button
                            type="button"
                            onClick={handleCancelAddBot}
                            disabled={isAddingBotToThisSlot}
                            className="rounded-md border border-slate-500 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-300 transition-colors duration-150 hover:border-slate-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Cancel
                          </button>
                        </div>

                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const handleGoToMainMenu = () => {
    window.location.assign('/home')
  }

  return isAuthenticated ? (
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

        <div className="relative z-10 mx-auto w-full">
          {accessDenied ? (
            <div className="mx-auto w-full max-w-2xl">
              <div className="rounded-2xl border border-rose-700/60 bg-slate-900/80 px-8 py-16 text-center shadow-2xl shadow-black/50" style={{ backdropFilter: 'blur(16px)' }}>
                <div className="mb-4 text-6xl">🔒</div>
                <h1 className="text-3xl font-extrabold text-white">Access Denied</h1>
                <p className="mt-4 text-slate-300">
                  You don't have access to this game.
                </p>
                <div className="mt-8 space-y-3 rounded-lg border border-slate-700/40 bg-slate-800/50 p-4">
                  <p className="text-sm text-slate-200">
                    To join this game, the game creator can:
                  </p>
                  <ul className="space-y-2 text-left text-sm text-slate-300">
                    <li className="flex items-start gap-3">
                      <span className="mt-1 text-indigo-400">•</span>
                      <span>Add you by your username in the game lobby</span>
                    </li>
                    <li className="flex items-start gap-3">
                      <span className="mt-1 text-indigo-400">•</span>
                      <span>Send you a shareable invite link</span>
                    </li>
                  </ul>
                </div>
                <button
                  type="button"
                  onClick={handleGoToMainMenu}
                  className="mt-8 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-8 py-3 text-base font-semibold text-white transition-all duration-150 hover:from-indigo-500 hover:to-violet-500"
                >
                  Go to Main Menu
                </button>
              </div>
            </div>
          ) : null}
          <div className="w-full lg:grid lg:grid-cols-[1fr_minmax(0,42rem)_1fr] lg:items-start" style={{ display: accessDenied ? 'none' : 'grid' }}>
            <form
              onSubmit={handleCreateOrStart}
              className="rounded-2xl border border-slate-700/60 bg-slate-900/80 px-6 py-6 shadow-2xl shadow-black/50 md:px-8 md:py-8 w-full lg:col-start-2 lg:max-w-2xl"
              style={{ backdropFilter: 'blur(16px)' }}
            >
            <h1 className="text-center text-2xl font-extrabold uppercase tracking-widest text-white">
              Create Game Room
            </h1>

            <div className="mt-6 grid gap-4 md:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300" htmlFor="game-name">
                  Game Name
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="game-name"
                    type="text"
                    value={gameName}
                    onChange={(event) => setGameName(event.target.value)}
                    disabled={isSyncingLobbyGame || isLeavingLobby || isCreatingRoom || isConfirmingTeamKey !== '' || isConfirmingGameName || isUpdatingLobbySettings}
                    className="w-full flex-1 rounded-lg border border-slate-600 bg-slate-800/60 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-70"
                  />

                  {hasGameNameChanges ? (
                    <button
                      type="button"
                      onClick={handleConfirmGameName}
                      disabled={isSyncingLobbyGame || isLeavingLobby || isCreatingRoom || isConfirmingTeamKey !== '' || isConfirmingGameName || isUpdatingLobbySettings}
                      className="rounded-md border border-indigo-500/80 bg-indigo-500/20 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-indigo-100 transition-colors duration-150 hover:border-indigo-400 hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isConfirmingGameName ? 'Confirming...' : 'Confirm'}
                    </button>
                  ) : null}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300" htmlFor="game-mode">
                  Game Mode
                </label>
                <select
                  id="game-mode"
                  value={gameMode}
                  onChange={(event) => setGameMode(event.target.value)}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="2v2">2v2</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300" htmlFor="time-control">
                  Time Control
                </label>
                <select
                  id="time-control"
                  value={timeControl}
                  onChange={handleTimeControlChange}
                  disabled={isSyncingLobbyGame || isLeavingLobby || isCreatingRoom || isConfirmingTeamKey !== '' || isConfirmingGameName || isUpdatingLobbySettings}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800/60 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {TIME_CONTROL_PRESETS.map((preset) => (
                    <option key={preset.label} value={preset.label}>{preset.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {renderTeamCard('teamA', teamAName, setTeamAName)}
              {renderTeamCard('teamB', teamBName, setTeamBName)}
            </div>

            <div className="mt-6 rounded-xl border border-slate-700/60 bg-slate-900/75 p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-white">Invite Friends</h2>
              <p className="mt-1 text-xs text-slate-400">Selected slot: {selectedSlotLabel}</p>

              <div className="mt-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">Invite by link</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={inviteLink}
                    readOnly
                    placeholder="Generate a shareable invite link"
                    className="flex-1 rounded-lg border border-slate-600 bg-slate-800/60 px-3 py-2.5 text-sm text-slate-200 outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleGenerateInviteLink}
                    className="rounded-lg border border-indigo-500/80 bg-indigo-500/20 px-4 py-2.5 text-sm font-semibold text-indigo-100 transition-colors duration-150 hover:border-indigo-400 hover:bg-indigo-500/30"
                  >
                    Generate Link
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyInviteLink}
                    className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-indigo-500"
                  >
                    Copy Link
                  </button>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">Invite by username</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={inviteInput}
                    onChange={(event) => setInviteInput(event.target.value)}
                    placeholder="Username"
                    className="flex-1 rounded-lg border border-slate-600 bg-slate-800/60 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={handleSendInvite}
                    className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-indigo-500"
                  >
                    Send Invite
                  </button>
                </div>
              </div>

              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">Invited players</p>
                {invitedPlayers.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-400">No invites sent yet.</p>
                ) : (
                  <ul className="mt-2 max-h-40 space-y-2 overflow-y-auto pr-1">
                    {invitedPlayers.map((player) => (
                      <li
                        key={player.id}
                        className="flex items-center justify-between rounded-lg border border-slate-700/60 bg-slate-800/60 px-3 py-2"
                      >
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-600/80 text-[11px] font-bold text-white">
                            {getPlayerInitial(player.name)}
                          </div>
                          <div>
                            <p className="text-sm text-slate-100">{player.name}</p>
                            <p className="text-[11px] text-slate-400">Pending invite</p>
                          </div>
                        </div>

                        <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300">
                          pending
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="mt-6 rounded-xl border border-slate-700/60 bg-slate-900/75 p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-white">Game Settings</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <label className="flex items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={allowSpectators}
                    onChange={handleAllowSpectatorsChange}
                    disabled={isSyncingLobbyGame || isLeavingLobby || isCreatingRoom || isConfirmingTeamKey !== '' || isConfirmingGameName || isUpdatingLobbySettings}
                    className="h-4 w-4 rounded border-slate-500 bg-slate-800 text-indigo-500 focus:ring-indigo-500"
                  />
                  Allow spectators
                </label>

                <label className="flex items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={publicRoom}
                    onChange={handlePublicRoomChange}
                    disabled={isSyncingLobbyGame || isLeavingLobby || isCreatingRoom || isConfirmingTeamKey !== '' || isConfirmingGameName || isUpdatingLobbySettings}
                    className="h-4 w-4 rounded border-slate-500 bg-slate-800 text-indigo-500 focus:ring-indigo-500"
                  />
                  Public room
                </label>

                <label className="flex items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={ratedGame}
                    onChange={handleRatedGameChange}
                    disabled={isSyncingLobbyGame || isLeavingLobby || isCreatingRoom || isConfirmingTeamKey !== '' || isConfirmingGameName || isUpdatingLobbySettings}
                    className="h-4 w-4 rounded border-slate-500 bg-slate-800 text-indigo-500 focus:ring-indigo-500"
                  />
                  Rated game
                </label>
              </div>
            </div>

            <div className="mt-6 rounded-xl border border-slate-700/60 bg-slate-900/75 p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-white">Room Preview</h2>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-slate-700/60 bg-slate-800/60 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-400">{teamAName || 'Team A'}</p>
                  <p className="mt-2 text-sm text-slate-200">
                    ♔ White: {slotPlayersById[slots.teamAWhite]?.name || 'Open slot'}
                  </p>
                  <p className="mt-1 text-sm text-slate-200">
                    ♚ Black: {slotPlayersById[slots.teamABlack]?.name || 'Open slot'}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-700/60 bg-slate-800/60 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-400">{teamBName || 'Team B'}</p>
                  <p className="mt-2 text-sm text-slate-200">
                    ♔ White: {slotPlayersById[slots.teamBWhite]?.name || 'Open slot'}
                  </p>
                  <p className="mt-1 text-sm text-slate-200">
                    ♚ Black: {slotPlayersById[slots.teamBBlack]?.name || 'Open slot'}
                  </p>
                </div>
              </div>

              <div className="mt-3 grid gap-2 text-xs text-slate-300 sm:grid-cols-3">
                <p>Game: <span className="text-slate-100">{gameName || 'Untitled room'}</span></p>
                <p>Mode: <span className="text-slate-100">{gameMode}</span></p>
                <p>Time: <span className="text-slate-100">{timeControl}</span></p>
                <p>Spectators: <span className="text-slate-100">{allowSpectators ? 'Allowed' : 'Off'}</span></p>
                <p>Visibility: <span className="text-slate-100">{publicRoom ? 'Public' : 'Private'}</span></p>
                <p>Rated: <span className="text-slate-100">{ratedGame ? 'Yes' : 'No'}</span></p>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap justify-end gap-3 border-t border-slate-700/60 pt-4">
              <button
                type="button"
                onClick={handleCancelLobby}
                disabled={isCreatingRoom || isLeavingLobby}
                className="rounded-lg border border-slate-600 px-5 py-2.5 text-sm font-semibold text-slate-200 transition-colors duration-150 hover:border-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isLeavingLobby ? 'Leaving...' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={isCreatingRoom || isStartingGame || isLeavingLobby || (Boolean(activeLobbyGameId) && !areAllPlayerSlotsFilled)}
                className="rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {!activeLobbyGameId
                  ? (isCreatingRoom ? 'Creating Lobby...' : 'Create Lobby')
                  : (isStartingGame ? 'Starting...' : 'Game Start')}
              </button>
            </div>

            {activeLobbyGameId && !areAllPlayerSlotsFilled ? (
              <p className="mt-2 text-right text-xs text-amber-300">
                Fill all 4 player slots before starting the game.
              </p>
            ) : null}

            {status.message ? (
              <p
                className={`mt-3 text-right text-xs ${
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
            </form>

          {activeLobbyGameId && (
            <div className="mt-6 w-full lg:mt-0 lg:col-start-3 lg:ml-6 lg:w-80 lg:justify-self-start">
              <ChatPanel
                gameId={activeLobbyGameId}
                userTeamId={userTeamInfo.userTeamId}
                userTeamMemberId={userTeamInfo.userTeamMemberId}
                accessToken={localStorage.getItem('accessToken') || ''}
              />
            </div>
          )}
          </div>
        </div>
      </section>
    </div>
  ) : null
}
