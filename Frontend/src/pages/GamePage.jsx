import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { io } from 'socket.io-client'
import { Chess } from 'chess.js'
import { tryRefreshAccessToken } from '../authSession.js'
import Navbar from '../components/Navbar.jsx'
import ChatPanel from '../components/ChatPanel.jsx'
import PlayerProfileModal from '../components/PlayerProfileModal.jsx'

const DEFAULT_API_BASE_URL = 'http://localhost:3001'
const DROP_MOVE_PATTERN = /^@([pnbrq])([a-h][1-8])$/i
const FILES_WHITE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const FILES_BLACK = ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']
const RANKS_WHITE = ['8', '7', '6', '5', '4', '3', '2', '1']
const RANKS_BLACK = ['1', '2', '3', '4', '5', '6', '7', '8']

const PIECE_LABELS = {
  p: 'Pawn',
  n: 'Knight',
  b: 'Bishop',
  r: 'Rook',
  q: 'Queen',
}

const PIECE_ASSET_PATHS = {
  white: {
    p: '/chess/modern/w_pawn.svg',
    n: '/chess/modern/w_knight.svg',
    b: '/chess/modern/w_bishop.svg',
    r: '/chess/modern/w_rook.svg',
    q: '/chess/modern/w_queen.svg',
    k: '/chess/modern/w_king.svg',
  },
  black: {
    p: '/chess/modern/b_pawn.svg',
    n: '/chess/modern/b_knight.svg',
    b: '/chess/modern/b_bishop.svg',
    r: '/chess/modern/b_rook.svg',
    q: '/chess/modern/b_queen.svg',
    k: '/chess/modern/b_king.svg',
  },
}

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

function getStoredUser() {
  try {
    const raw = localStorage.getItem('authUser')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function formatClock(totalSeconds) {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = safeSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function getInitialSeconds(game) {
  const value = typeof game?.time_control === 'string' ? Number(game.time_control.trim()) : Number(game?.time_control)
  if (!Number.isFinite(value) || value <= 0) {
    return 300
  }

  return Math.max(1, Math.round(value * 60))
}

function memberName(member) {
  if (!member) {
    return 'Unknown'
  }

  if (typeof member.username === 'string' && member.username.trim()) {
    return member.username.trim()
  }

  if (member.is_bot) {
    return 'Bot'
  }

  return 'Player'
}

function getLastMoveSquares(moveUci) {
  const normalizedMove = typeof moveUci === 'string' ? moveUci.trim().toLowerCase() : ''
  if (!normalizedMove) {
    return { from: null, to: null }
  }

  const dropMatch = normalizedMove.match(DROP_MOVE_PATTERN)
  if (dropMatch) {
    return { from: null, to: dropMatch[2] }
  }

  if (normalizedMove.length < 4) {
    return { from: null, to: null }
  }

  return {
    from: normalizedMove.slice(0, 2),
    to: normalizedMove.slice(2, 4),
  }
}

function findKingSquare(chess, color) {
  const board = chess.board()

  for (let rankIndex = 0; rankIndex < board.length; rankIndex += 1) {
    for (let fileIndex = 0; fileIndex < board[rankIndex].length; fileIndex += 1) {
      const piece = board[rankIndex][fileIndex]
      if (!piece) {
        continue
      }

      if (piece.type === 'k' && piece.color === color) {
        const file = String.fromCharCode(97 + fileIndex)
        const rank = String(8 - rankIndex)
        return `${file}${rank}`
      }
    }
  }

  return null
}

function buildChessForBoard(moves, boardNumber) {
  const chess = new Chess()
  const sortedBoardMoves = [...moves]
    .filter((move) => Number(move.board_number) === Number(boardNumber))
    .sort((firstMove, secondMove) => {
      const firstMoveNumber = Number(firstMove.move_number) || 0
      const secondMoveNumber = Number(secondMove.move_number) || 0
      if (firstMoveNumber !== secondMoveNumber) {
        return firstMoveNumber - secondMoveNumber
      }

      return (Number(firstMove.move_id) || 0) - (Number(secondMove.move_id) || 0)
    })

  for (const move of sortedBoardMoves) {
    const uci = typeof move.move_uci === 'string' ? move.move_uci.trim().toLowerCase() : ''
    if (!uci) {
      continue
    }

    const dropMatch = uci.match(DROP_MOVE_PATTERN)

    if (dropMatch) {
      const pieceType = dropMatch[1]
      const targetSquare = dropMatch[2]
      const movingColor = chess.turn()

      let placed = false
      try {
        placed = chess.put({ type: pieceType, color: movingColor }, targetSquare)
      } catch {
        placed = false
      }

      if (!placed) {
        continue
      }

      try {
        const fenParts = chess.fen().split(' ')
        fenParts[1] = movingColor === 'w' ? 'b' : 'w'
        fenParts[3] = '-'
        fenParts[4] = String(Number(fenParts[4]) + 1)
        if (movingColor === 'b') {
          fenParts[5] = String(Number(fenParts[5]) + 1)
        }
        chess.load(fenParts.join(' '))
      } catch {
        continue
      }
      continue
    }

    try {
      chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length === 5 ? uci[4] : undefined,
      })
    } catch {
      continue
    }
  }

  return chess
}

function getSquareColorClass(square) {
  const fileCode = square.charCodeAt(0) - 96
  const rank = Number(square[1])
  const isLight = (fileCode + rank) % 2 === 1
  return isLight ? 'bg-slate-500/90' : 'bg-slate-700/95'
}

function getPieceAssetPath(pieceColor, pieceType) {
  const normalizedColor = pieceColor === 'w' || pieceColor === 'white' ? 'white' : 'black'
  const normalizedPieceType = typeof pieceType === 'string' ? pieceType.trim().toLowerCase() : ''

  if (!normalizedPieceType) {
    return ''
  }

  return PIECE_ASSET_PATHS[normalizedColor]?.[normalizedPieceType] ?? ''
}

function getCapturedPieceNameFromMove(simulatedMove) {
  const capturedType = typeof simulatedMove?.captured === 'string' ? simulatedMove.captured.toLowerCase() : ''

  if (!capturedType) {
    return ''
  }

  if (capturedType === 'p') return 'pawn'
  if (capturedType === 'n') return 'knight'
  if (capturedType === 'b') return 'bishop'
  if (capturedType === 'r') return 'rook'
  if (capturedType === 'q') return 'queen'

  return ''
}

function reserveListToMap(reserves) {
  const map = {}

  for (const reserveItem of reserves ?? []) {
    const pieceType = typeof reserveItem?.piece_type === 'string' ? reserveItem.piece_type.trim().toLowerCase() : ''
    const quantity = Number(reserveItem?.quantity)

    if (!pieceType || !Number.isFinite(quantity)) {
      continue
    }

    map[pieceType] = Math.max(0, Math.floor(quantity))
  }

  return map
}

function getBoardStructure(game) {
  const boards = {
    1: { w: null, b: null, members: [] },
    2: { w: null, b: null, members: [] },
  }

  const teams = Array.isArray(game?.teams) ? game.teams : []

  for (const team of teams) {
    const members = Array.isArray(team?.members) ? team.members : []

    for (const member of members) {
      const boardNumber = Number(member?.board_number)
      const color = typeof member?.piece_color === 'string' ? member.piece_color.trim().toLowerCase() : ''

      if ((boardNumber !== 1 && boardNumber !== 2) || (color !== 'white' && color !== 'black')) {
        continue
      }

      const colorKey = color === 'white' ? 'w' : 'b'
      const normalizedMember = {
        ...member,
        team_id: team.team_id,
        team_name: team.team_name,
      }

      boards[boardNumber][colorKey] = normalizedMember
      boards[boardNumber].members.push(normalizedMember)
    }
  }

  return boards
}

function getOrientationForBoard({ boardNumber, userMember, partnerMember }) {
  if (userMember && Number(userMember.board_number) === boardNumber) {
    return userMember.piece_color === 'black' ? 'black' : 'white'
  }

  if (partnerMember && Number(partnerMember.board_number) === boardNumber) {
    return partnerMember.piece_color === 'black' ? 'black' : 'white'
  }

  return 'white'
}

function getFilesByOrientation(orientation) {
  return orientation === 'black' ? FILES_BLACK : FILES_WHITE
}

function getRanksByOrientation(orientation) {
  return orientation === 'black' ? RANKS_BLACK : RANKS_WHITE
}

function getBoardRows(chess, orientation) {
  const files = getFilesByOrientation(orientation)
  const ranks = getRanksByOrientation(orientation)

  return ranks.map((rank) => (
    files.map((file) => {
      const square = `${file}${rank}`
      const piece = chess.get(square)
      return {
        square,
        piece,
      }
    })
  ))
}

function mergeGameKeepingKnownTimers(previousGame, nextGame, { preserveExistingTimers = false } = {}) {
  if (!nextGame || typeof nextGame !== 'object') {
    return nextGame
  }

  if (!previousGame || typeof previousGame !== 'object') {
    return nextGame
  }

  const previousTeams = Array.isArray(previousGame?.teams) ? previousGame.teams : []
  const nextTeams = Array.isArray(nextGame?.teams) ? nextGame.teams : []

  if (previousTeams.length === 0 || nextTeams.length === 0) {
    return nextGame
  }

  const previousTimerByMemberId = new Map()

  for (const team of previousTeams) {
    const members = Array.isArray(team?.members) ? team.members : []

    for (const member of members) {
      const memberId = normalizePositiveInteger(member?.team_member_id)
      const remainingSeconds = Number(member?.remaining_seconds)

      if (!memberId || !Number.isFinite(remainingSeconds)) {
        continue
      }

      previousTimerByMemberId.set(memberId, Math.max(0, Math.floor(remainingSeconds)))
    }
  }

  if (previousTimerByMemberId.size === 0) {
    return nextGame
  }

  if (!preserveExistingTimers) {
    const mergedTeams = nextTeams.map((team) => ({
      ...team,
      members: (Array.isArray(team?.members) ? team.members : []).map((member) => {
        const memberId = normalizePositiveInteger(member?.team_member_id)
        if (!memberId) return member

        const nextRemainingSeconds = Number(member?.remaining_seconds)
        if (Number.isFinite(nextRemainingSeconds)) {
          return { ...member, remaining_seconds: Math.max(0, Math.floor(nextRemainingSeconds)) }
        }

        const previousRemainingSeconds = previousTimerByMemberId.get(memberId)
        if (Number.isFinite(previousRemainingSeconds)) {
          return { ...member, remaining_seconds: previousRemainingSeconds }
        }

        return member
      }),
    }))

    return { ...nextGame, teams: mergedTeams }
  }

  // preserveExistingTimers: true
  // Snapshot the effective display value at this exact moment so the timer
  // does not reset when moves state updates and activeTurnMemberByBoard shifts.
  // Active members get their elapsed deducted; inactive members keep their base.
  // clock_last_synced_at is reset to now so the display formula stays correct.
  const nowMs = Date.now()
  const syncedAtMs = Date.parse(previousGame?.clock_last_synced_at)
  const elapsedSeconds = Number.isFinite(syncedAtMs)
    ? Math.max(0, Math.floor((nowMs - syncedAtMs) / 1000))
    : 0

  const prevActiveMemberIds = new Set([
    normalizePositiveInteger(previousGame?.active_board1_team_member_id),
    normalizePositiveInteger(previousGame?.active_board2_team_member_id),
  ].filter(Boolean))

  const mergedTeams = nextTeams.map((team) => ({
    ...team,
    members: (Array.isArray(team?.members) ? team.members : []).map((member) => {
      const memberId = normalizePositiveInteger(member?.team_member_id)
      if (!memberId) return member

      const previousRemainingSeconds = previousTimerByMemberId.get(memberId)
      if (!Number.isFinite(previousRemainingSeconds)) {
        const nextRemainingSeconds = Number(member?.remaining_seconds)
        if (Number.isFinite(nextRemainingSeconds)) {
          return { ...member, remaining_seconds: Math.max(0, Math.floor(nextRemainingSeconds)) }
        }
        return member
      }

      const isActive = prevActiveMemberIds.has(memberId)
      const effectiveRemaining = isActive
        ? Math.max(0, Math.floor(previousRemainingSeconds) - elapsedSeconds)
        : Math.floor(previousRemainingSeconds)

      return { ...member, remaining_seconds: effectiveRemaining }
    }),
  }))

  return {
    ...nextGame,
    teams: mergedTeams,
    clock_last_synced_at: new Date(nowMs).toISOString(),
  }
}

function resolveStateVersion(source) {
  if (!source || typeof source !== 'object') {
    return 0
  }

  const candidates = [
    source.state_version,
    source.game?.state_version,
    source.move_count,
    source.game?.move_count,
  ]

  let highestVersion = 0

  for (const candidate of candidates) {
    const numeric = Number(candidate)
    if (!Number.isFinite(numeric)) {
      continue
    }

    highestVersion = Math.max(highestVersion, Math.max(0, Math.floor(numeric)))
  }

  return highestVersion
}

function applyRealtimeGamePatch(previousGame, gamePatch) {
  if (!previousGame || typeof previousGame !== 'object') {
    return previousGame
  }

  if (!gamePatch || typeof gamePatch !== 'object') {
    return previousGame
  }

  const remainingByMember = gamePatch.remaining_seconds_by_member
  const hasRemainingByMember = remainingByMember && typeof remainingByMember === 'object'
  const previousTeams = Array.isArray(previousGame?.teams) ? previousGame.teams : []

  if (!hasRemainingByMember) {
    return {
      ...previousGame,
      ...gamePatch,
      // Preserve the client's clock anchor — the patch has no timer data so
      // spreading gamePatch.clock_last_synced_at would reset the reference to
      // an older server timestamp, causing the display formula to over-deduct.
      clock_last_synced_at: previousGame?.clock_last_synced_at,
      teams: previousTeams,
    }
  }

  const nowMs = Date.now()

  // How many whole seconds have elapsed since the server's sync point
  const serverSyncedAtMs = Date.parse(gamePatch.clock_last_synced_at)
  const elapsedSinceServerSync = Number.isFinite(serverSyncedAtMs)
    ? Math.max(0, Math.floor((nowMs - serverSyncedAtMs) / 1000))
    : 0

  // Members whose timers were ticking before this patch
  const prevActiveMemberIds = new Set([
    normalizePositiveInteger(previousGame?.active_board1_team_member_id),
    normalizePositiveInteger(previousGame?.active_board2_team_member_id),
  ].filter(Boolean))

  // Members whose timers will tick after this patch
  const nextActiveMemberIds = new Set([
    normalizePositiveInteger(gamePatch?.active_board1_team_member_id ?? previousGame?.active_board1_team_member_id),
    normalizePositiveInteger(gamePatch?.active_board2_team_member_id ?? previousGame?.active_board2_team_member_id),
  ].filter(Boolean))

  const nextTeams = previousTeams.map((team) => ({
    ...team,
    members: (Array.isArray(team?.members) ? team.members : []).map((member) => {
      const memberId = normalizePositiveInteger(member?.team_member_id)
      if (!memberId) {
        return member
      }

      const serverRemaining = Number(remainingByMember[memberId])
      if (!Number.isFinite(serverRemaining)) {
        return member
      }

      const wasActive = prevActiveMemberIds.has(memberId)
      const isNowActive = nextActiveMemberIds.has(memberId)

      if (wasActive && isNowActive) {
        // Still active: advance the server's frozen value to now by deducting
        // elapsed since the server's sync point.  We trust the server as the
        // authoritative source rather than clamping against the client estimate,
        // because clamping with Math.min caused 1-second downward jumps due to
        // double-floor arithmetic differences between the two estimates.
        const serverLiveValue = Math.max(0, Math.floor(serverRemaining) - elapsedSinceServerSync)
        return { ...member, remaining_seconds: serverLiveValue }
      }

      if (!wasActive && isNowActive) {
        // Newly active: the timer starts NOW from the server's frozen value.
        // Do NOT deduct elapsed-since-server-sync here — that would cause a
        // visible jump backwards when the socket event arrives with an older
        // clock_last_synced_at than what the client already has.
        return { ...member, remaining_seconds: Math.max(0, Math.floor(serverRemaining)) }
      }

      // Just moved or always inactive: use server value directly.
      return { ...member, remaining_seconds: Math.max(0, Math.floor(serverRemaining)) }
    }),
  }))

  return {
    ...previousGame,
    ...gamePatch,
    // Always anchor clock_last_synced_at to NOW so the display formula
    // (remaining - floor((clockTickMs - clock_last_synced_at) / 1000)) starts
    // from the already-adjusted member values above without any extra offset.
    // This prevents a jump when the server's sync point is older than the
    // client's current reference.
    clock_last_synced_at: new Date(nowMs).toISOString(),
    teams: nextTeams,
  }
}

function applyOptimisticClockAfterLocalMove(previousGame, {
  boardNumber,
  boardStructure,
  movingPieceColor,
}) {
  if (!previousGame || typeof previousGame !== 'object') {
    return previousGame
  }

  const normalizedBoardNumber = Number(boardNumber)
  const activeBoardKey = normalizedBoardNumber === 2
    ? 'active_board2_team_member_id'
    : normalizedBoardNumber === 1
      ? 'active_board1_team_member_id'
      : ''

  const normalizedMovingColor = typeof movingPieceColor === 'string' ? movingPieceColor.trim().toLowerCase() : ''
  const movingColorKey = normalizedMovingColor === 'white'
    ? 'w'
    : normalizedMovingColor === 'black'
      ? 'b'
      : normalizedMovingColor === 'w' || normalizedMovingColor === 'b'
        ? normalizedMovingColor
        : ''
  const oppositePieceColor = movingColorKey === 'w'
    ? 'b'
    : movingColorKey === 'b'
      ? 'w'
      : ''

  const nextActiveMemberId = activeBoardKey && oppositePieceColor
    ? normalizePositiveInteger(boardStructure?.[normalizedBoardNumber]?.[oppositePieceColor]?.team_member_id)
    : 0

  const nowMs = Date.now()
  const syncedAtMs = Date.parse(previousGame.clock_last_synced_at)
  const elapsedSeconds = Number.isFinite(syncedAtMs)
    ? Math.max(0, Math.floor((nowMs - syncedAtMs) / 1000))
    : 0

  const activeMemberIds = [
    normalizePositiveInteger(previousGame.active_board1_team_member_id),
    normalizePositiveInteger(previousGame.active_board2_team_member_id),
  ].filter(Boolean)

  const teams = Array.isArray(previousGame.teams) ? previousGame.teams : []
  const hasElapsedToApply = elapsedSeconds > 0 && activeMemberIds.length > 0

  const nextTeams = hasElapsedToApply
    ? teams.map((team) => ({
      ...team,
      members: (Array.isArray(team?.members) ? team.members : []).map((member) => {
        const memberId = normalizePositiveInteger(member?.team_member_id)
        if (!memberId || !activeMemberIds.includes(memberId)) {
          return member
        }

        const currentRemainingSeconds = Number(member?.remaining_seconds)
        if (!Number.isFinite(currentRemainingSeconds)) {
          return member
        }

        return {
          ...member,
          remaining_seconds: Math.max(0, Math.floor(currentRemainingSeconds) - elapsedSeconds),
        }
      }),
    }))
    : teams

  return {
    ...previousGame,
    ...(activeBoardKey && nextActiveMemberId ? { [activeBoardKey]: nextActiveMemberId } : {}),
    teams: nextTeams,
    clock_last_synced_at: new Date(nowMs).toISOString(),
  }
}

export default function GamePage() {
  const { gameId: rawGameId } = useParams()
  const gameId = useMemo(() => normalizePositiveInteger(rawGameId), [rawGameId])
  const apiBaseUrl = getApiBaseUrl()
  const [currentUser] = useState(getStoredUser)
  const [_status, setStatus] = useState({ tone: 'pending', message: 'Loading game...' })
  const [game, setGame] = useState(null)
  const [moves, setMoves] = useState([])
  const [reservesByMember, setReservesByMember] = useState({})
  const [selectedSquareByBoard, setSelectedSquareByBoard] = useState({ 1: '', 2: '' })
  const [legalTargetsByBoard, setLegalTargetsByBoard] = useState({ 1: [], 2: [] })
  const [selectedReserveByBoard, setSelectedReserveByBoard] = useState({ 1: '', 2: '' })
  const [isSendingMove, setIsSendingMove] = useState(false)
  const [clockTickMs, setClockTickMs] = useState(Date.now())
  const [isCreatingRematch, setIsCreatingRematch] = useState(false)
  const [mobileCenterOpen, setMobileCenterOpen] = useState(false)
  const [botThinkingByBoard, setBotThinkingByBoard] = useState({ 1: false, 2: false })
  const [botScheduleTick, setBotScheduleTick] = useState(0)
  const [isSubmittingDraw, setIsSubmittingDraw] = useState(false)
  const [isSubmittingForfeit, setIsSubmittingForfeit] = useState(false)
  const [viewingPlayer, setViewingPlayer] = useState(null)
  const botMoveInFlightByBoardRef = useRef({ 1: false, 2: false })
  const botMoveTimeoutIdByBoardRef = useRef({ 1: null, 2: null })
  const lastBotAttemptSignatureByBoardRef = useRef({ 1: '', 2: '' })
  const timeoutSyncInFlightRef = useRef(false)
  const pendingOptimisticMovesRef = useRef(new Map())
  const gameSocketRef = useRef(null)
  const latestStateVersionRef = useRef(0)

  const hasAccessToken = typeof window !== 'undefined' && Boolean(localStorage.getItem('accessToken'))
  const isAuthenticated = Boolean(currentUser) && hasAccessToken

  const requestJson = useCallback(async (path, options = {}) => {
    const runRequest = async (accessToken) => {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        ...options,
        headers: {
          ...(options.headers ?? {}),
          Authorization: `Bearer ${accessToken}`,
        },
      })

      const payload = await response.json().catch(() => null)
      return { response, payload }
    }

    const accessToken = localStorage.getItem('accessToken')
    if (!accessToken) {
      return { response: { ok: false, status: 401 }, payload: { ok: false, error: 'Authentication required' } }
    }

    let result = await runRequest(accessToken)

    if (result.response.status === 401) {
      const refreshedAccessToken = await tryRefreshAccessToken(apiBaseUrl, `/game/${encodeURIComponent(String(gameId ?? ''))}`)

      if (refreshedAccessToken) {
        result = await runRequest(refreshedAccessToken)
      }
    }

    return result
  }, [apiBaseUrl, gameId])

  const mergeServerMovesWithPending = useCallback((serverMoves) => {
    const pendingMap = pendingOptimisticMovesRef.current

    if (!(pendingMap instanceof Map) || pendingMap.size === 0) {
      return serverMoves
    }

    const unresolvedPendingMoves = []

    for (const [optimisticMoveId, pendingMove] of pendingMap.entries()) {
      const pendingMoveUci = typeof pendingMove?.move_uci === 'string' ? pendingMove.move_uci.trim().toLowerCase() : ''
      const pendingTeamMemberId = normalizePositiveInteger(pendingMove?.team_member_id)

      const isConfirmed = serverMoves.some((move) => {
        const moveUci = typeof move?.move_uci === 'string' ? move.move_uci.trim().toLowerCase() : ''
        const moveTeamMemberId = normalizePositiveInteger(move?.team_member_id)

        return pendingMoveUci && pendingTeamMemberId && moveUci === pendingMoveUci && moveTeamMemberId === pendingTeamMemberId
      })

      if (isConfirmed) {
        pendingMap.delete(optimisticMoveId)
      } else {
        unresolvedPendingMoves.push(pendingMove)
      }
    }

    if (unresolvedPendingMoves.length === 0) {
      return serverMoves
    }

    return [...serverMoves, ...unresolvedPendingMoves].sort((firstMove, secondMove) => {
      const firstMoveNumber = Number(firstMove?.move_number) || 0
      const secondMoveNumber = Number(secondMove?.move_number) || 0
      if (firstMoveNumber !== secondMoveNumber) {
        return firstMoveNumber - secondMoveNumber
      }

      return (Number(firstMove?.move_id) || 0) - (Number(secondMove?.move_id) || 0)
    })
  }, [])

  const boardStructure = useMemo(() => getBoardStructure(game), [game])

  const hasBotPlayers = useMemo(() => {
    const teams = Array.isArray(game?.teams) ? game.teams : []

    for (const team of teams) {
      const members = Array.isArray(team?.members) ? team.members : []
      for (const member of members) {
        if (member?.is_bot === true) {
          return true
        }
      }
    }

    return false
  }, [game])

  const userMember = (() => {
    const userId = typeof currentUser?.id === 'string' ? currentUser.id.trim().toLowerCase() : ''

    if (!userId || !game) {
      return null
    }

    const teams = Array.isArray(game.teams) ? game.teams : []

    for (const team of teams) {
      const members = Array.isArray(team.members) ? team.members : []

      for (const member of members) {
        const memberUserId = typeof member?.user_id === 'string' ? member.user_id.trim().toLowerCase() : ''
        if (memberUserId && memberUserId === userId) {
          return {
            ...member,
            team_id: team.team_id,
            team_name: team.team_name,
          }
        }
      }
    }

    return null
  })()

  const isSpectator = game !== null && userMember === null && game?.status === 'started'

  const partnerMember = (() => {
    if (!userMember || !game) {
      return null
    }

    const teams = Array.isArray(game.teams) ? game.teams : []

    for (const team of teams) {
      if (Number(team.team_id) !== Number(userMember.team_id)) {
        continue
      }

      const members = Array.isArray(team.members) ? team.members : []
      return members.find((member) => Number(member.team_member_id) !== Number(userMember.team_member_id)) ?? null
    }

    return null
  })()

  const boardOrder = useMemo(() => {
    const primaryBoard = Number(userMember?.board_number)
    const partnerBoard = Number(partnerMember?.board_number)

    if ((primaryBoard === 1 || primaryBoard === 2) && (partnerBoard === 1 || partnerBoard === 2) && primaryBoard !== partnerBoard) {
      return [primaryBoard, partnerBoard]
    }

    if (primaryBoard === 1 || primaryBoard === 2) {
      return [primaryBoard, primaryBoard === 1 ? 2 : 1]
    }

    return [1, 2]
  }, [partnerMember, userMember])

  const boardStates = useMemo(() => {
    const entries = [1, 2].map((boardNumber) => {
      const chess = buildChessForBoard(moves, boardNumber)
      const boardMoves = moves
        .filter((move) => Number(move.board_number) === boardNumber)
        .sort((firstMove, secondMove) => {
          const firstMoveNumber = Number(firstMove.move_number) || 0
          const secondMoveNumber = Number(secondMove.move_number) || 0
          if (firstMoveNumber !== secondMoveNumber) {
            return firstMoveNumber - secondMoveNumber
          }

          return (Number(firstMove.move_id) || 0) - (Number(secondMove.move_id) || 0)
        })
      const latestMove = boardMoves[boardMoves.length - 1] ?? null

      return [boardNumber, {
        chess,
        latestMove,
        latestMoveSquares: getLastMoveSquares(latestMove?.move_uci),
      }]
    })

    return Object.fromEntries(entries)
  }, [moves])

  const activeTurnMemberByBoard = useMemo(() => {
    const map = { 1: null, 2: null }

    for (const boardNumber of [1, 2]) {
      const turn = boardStates[boardNumber]?.chess?.turn() === 'b' ? 'b' : 'w'
      map[boardNumber] = boardStructure[boardNumber]?.[turn] ?? null
    }

    return map
  }, [boardStates, boardStructure])

  const displayTimersByMember = useMemo(() => {
    const nextTimers = {}
    const initialSeconds = getInitialSeconds(game)
    const teams = Array.isArray(game?.teams) ? game.teams : []

    for (const team of teams) {
      const members = Array.isArray(team?.members) ? team.members : []

      for (const member of members) {
        const memberId = normalizePositiveInteger(member?.team_member_id)
        if (!memberId) {
          continue
        }

        const remainingSeconds = Number(member?.remaining_seconds)
        nextTimers[memberId] = Number.isFinite(remainingSeconds)
          ? Math.max(0, Math.floor(remainingSeconds))
          : initialSeconds
      }
    }

    const normalizedStatus = typeof game?.status === 'string' ? game.status.trim().toLowerCase() : ''
    if (normalizedStatus !== 'started') {
      return nextTimers
    }

    const syncedAtRaw = game?.clock_last_synced_at
    const syncedAtMs = syncedAtRaw ? Date.parse(syncedAtRaw) : NaN
    if (!Number.isFinite(syncedAtMs)) {
      return nextTimers
    }

    const elapsedSeconds = Math.max(0, Math.floor((clockTickMs - syncedAtMs) / 1000))
    if (elapsedSeconds <= 0) {
      return nextTimers
    }

    const derivedActiveIds = [
      normalizePositiveInteger(activeTurnMemberByBoard?.[1]?.team_member_id),
      normalizePositiveInteger(activeTurnMemberByBoard?.[2]?.team_member_id),
    ].filter(Boolean)

    const activeIds = (derivedActiveIds.length > 0
      ? derivedActiveIds
      : [
        normalizePositiveInteger(game?.active_board1_team_member_id),
        normalizePositiveInteger(game?.active_board2_team_member_id),
      ].filter(Boolean)
    )

    for (const memberId of activeIds) {
      if (!Number.isFinite(nextTimers[memberId])) {
        continue
      }

      nextTimers[memberId] = Math.max(0, nextTimers[memberId] - elapsedSeconds)
    }

    return nextTimers
  }, [activeTurnMemberByBoard, clockTickMs, game])

  const loadGameState = useCallback(async ({ silent = false, syncClock = false } = {}) => {
    if (!gameId) {
      setStatus({ tone: 'error', message: 'Invalid game id.' })
      return
    }

    if (!silent) {
      setStatus({ tone: 'pending', message: 'Loading game...' })
    }

    const syncSuffix = syncClock ? '?syncClock=1' : ''
    const gameResult = await requestJson(`/games/${encodeURIComponent(String(gameId))}${syncSuffix}`)

    if (gameResult.response.status === 401) {
      const returnPath = `${window.location.pathname}${window.location.search}`
      const encodedReturnPath = encodeURIComponent(returnPath)
      window.location.assign(`/?redirect=${encodedReturnPath}`)
      return
    }

    if (gameResult.response.status === 403 || gameResult.response.status === 404) {
      window.location.assign('/home')
      return
    }

    if (!gameResult.response.ok || gameResult.payload?.ok !== true || !gameResult.payload?.game) {
      setStatus({ tone: 'error', message: typeof gameResult.payload?.error === 'string' ? gameResult.payload.error : 'Could not load game.' })
      return
    }

    const loadedGame = gameResult.payload.game
    const loadedStateVersion = resolveStateVersion(loadedGame)

    if (loadedStateVersion > 0 && loadedStateVersion < latestStateVersionRef.current) {
      if (!silent) {
        setStatus({ tone: 'success', message: 'Ignored outdated game snapshot.' })
      }
      return
    }

    latestStateVersionRef.current = Math.max(latestStateVersionRef.current, loadedStateVersion)

    setGame((previousGame) => mergeGameKeepingKnownTimers(previousGame, loadedGame, {
      preserveExistingTimers: !syncClock,
    }))

    const normalizedStatus = typeof loadedGame?.status === 'string' ? loadedGame.status.trim().toLowerCase() : ''
    if (normalizedStatus !== 'started' && normalizedStatus !== 'finished') {
      window.location.assign(`/create?gameId=${encodeURIComponent(String(gameId))}`)
      return
    }

    const movesResult = await requestJson(`/games/${encodeURIComponent(String(gameId))}/moves`)

    if (!movesResult.response.ok || movesResult.payload?.ok !== true || !Array.isArray(movesResult.payload?.moves)) {
      setStatus({ tone: 'error', message: typeof movesResult.payload?.error === 'string' ? movesResult.payload.error : 'Could not load moves.' })
      return
    }

    const loadedMoves = movesResult.payload.moves
    setMoves(mergeServerMovesWithPending(loadedMoves))

    const allMembers = []
    const teams = Array.isArray(loadedGame?.teams) ? loadedGame.teams : []
    for (const team of teams) {
      const members = Array.isArray(team?.members) ? team.members : []
      for (const member of members) {
        const memberId = normalizePositiveInteger(member?.team_member_id)
        if (memberId) {
          allMembers.push(memberId)
        }
      }
    }

    const reserveEntries = await Promise.all(allMembers.map(async (teamMemberId) => {
      const reserveResult = await requestJson(`/team-members/${encodeURIComponent(String(teamMemberId))}/reserves`)

      if (!reserveResult.response.ok || reserveResult.payload?.ok !== true) {
        return [teamMemberId, {}]
      }

      return [teamMemberId, reserveListToMap(reserveResult.payload?.reserves)]
    }))

    setReservesByMember(Object.fromEntries(reserveEntries))

    setStatus({ tone: 'success', message: 'Game synchronized.' })
  }, [gameId, mergeServerMovesWithPending, requestJson])

  useEffect(() => {
    if (!isAuthenticated) {
      const returnPath = `${window.location.pathname}${window.location.search}`
      const encodedReturnPath = encodeURIComponent(returnPath)
      window.location.assign(`/?redirect=${encodedReturnPath}`)
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (!isAuthenticated) {
      return
    }

    queueMicrotask(() => {
      void loadGameState()
    })
  }, [isAuthenticated, loadGameState])

  useEffect(() => {
    if (!gameId) {
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
    gameSocketRef.current = socket

    socket.on('connect_error', (err) => {
      // Log handshake failures to help diagnose closed-before-open issues.
      console.warn('socket connect_error', {
        message: err?.message,
        code: err?.data?.code ?? err?.code,
        error: err?.data?.error ?? err?.description ?? null,
      })
    })

    socket.on('disconnect', (reason) => {
      console.info('socket disconnect', { reason })
    })

    socket.on('connect', () => {
      socket.emit('game:join', { gameId })
    })

    socket.on('game:move-created', (data) => {
      if (data?.move) {
        const moveStateVersion = resolveStateVersion({
          state_version: data.move?.state_version,
          move_count: data.move?.move_number,
        })

        if (moveStateVersion > 0 && moveStateVersion < latestStateVersionRef.current) {
          return
        }

        latestStateVersionRef.current = Math.max(latestStateVersionRef.current, moveStateVersion)

        setMoves((prevMoves) => {
          const incomingMoveUci = typeof data.move?.move_uci === 'string' ? data.move.move_uci.trim().toLowerCase() : ''
          const incomingTeamMemberId = normalizePositiveInteger(data.move?.team_member_id)
          const pendingMap = pendingOptimisticMovesRef.current

          for (const [optimisticMoveId, pendingMove] of pendingMap.entries()) {
            const pendingMoveUci = typeof pendingMove?.move_uci === 'string' ? pendingMove.move_uci.trim().toLowerCase() : ''
            const pendingTeamMemberId = normalizePositiveInteger(pendingMove?.team_member_id)

            if (incomingMoveUci && incomingTeamMemberId && pendingMoveUci === incomingMoveUci && pendingTeamMemberId === incomingTeamMemberId) {
              pendingMap.delete(optimisticMoveId)
            }
          }

          const withoutMatchingOptimistic = prevMoves.filter((move) => {
            const moveId = Number(move?.move_id)
            if (!(moveId < 0) || !incomingMoveUci || !incomingTeamMemberId) {
              return true
            }

            const optimisticMoveUci = typeof move?.move_uci === 'string' ? move.move_uci.trim().toLowerCase() : ''
            const optimisticTeamMemberId = normalizePositiveInteger(move?.team_member_id)
            return !(optimisticMoveUci === incomingMoveUci && optimisticTeamMemberId === incomingTeamMemberId)
          })

          const incomingMoveId = normalizePositiveInteger(data.move?.move_id)

          if (incomingMoveId) {
            const alreadyExists = withoutMatchingOptimistic.some((move) => normalizePositiveInteger(move?.move_id) === incomingMoveId)
            if (alreadyExists) {
              return withoutMatchingOptimistic
            }
          }

          return [...withoutMatchingOptimistic, data.move]
        })

        setGame((previousGame) => applyRealtimeGamePatch(previousGame, {
          ...(data.move?.game_patch && typeof data.move.game_patch === 'object' ? data.move.game_patch : {}),
          move_count: Number(data.move?.move_number) || Number(data.move?.game_patch?.move_count) || 0,
          state_version: moveStateVersion,
        }))
        setClockTickMs(Date.now())
      }
    })

    const statusUpdateHandler = (payload) => {
      const payloadStateVersion = resolveStateVersion(payload)
      if (payloadStateVersion > 0 && payloadStateVersion < latestStateVersionRef.current) {
        return
      }

      latestStateVersionRef.current = Math.max(latestStateVersionRef.current, payloadStateVersion)
      void loadGameState({ silent: true })
    }

    socket.on('game:snapshot', statusUpdateHandler)
    socket.on('game:reserve-updated', statusUpdateHandler)
    socket.on('game:status-updated', statusUpdateHandler)
    socket.on('game:offer-updated', statusUpdateHandler)
    socket.on('game:team-member-updated', statusUpdateHandler)

    return () => {
      if (socket.connected) {
        socket.emit('game:leave', { gameId })
      }

      if (socket.connected) {
        socket.disconnect()
      } else {
        socket.close()
      }

      gameSocketRef.current = null
    }
  }, [apiBaseUrl, gameId, loadGameState])

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClockTickMs(Date.now())
    }, 100)

    return () => {
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    const normalizedStatus = typeof game?.status === 'string' ? game.status.trim().toLowerCase() : ''
    if (normalizedStatus !== 'started' || timeoutSyncInFlightRef.current) {
      return
    }

    const activeMemberIds = [
      normalizePositiveInteger(game?.active_board1_team_member_id),
      normalizePositiveInteger(game?.active_board2_team_member_id),
    ].filter(Boolean)

    const hasExpiredTimer = activeMemberIds.some((memberId) => {
      const value = displayTimersByMember[memberId]
      return Number.isFinite(value) && value <= 0
    })

    if (!hasExpiredTimer) {
      return
    }

    timeoutSyncInFlightRef.current = true

    queueMicrotask(async () => {
      try {
        await requestJson(`/games/${encodeURIComponent(String(gameId))}/timeout`, { method: 'POST' })
        await loadGameState({ silent: true, syncClock: true })
      } finally {
        timeoutSyncInFlightRef.current = false
      }
    })
  }, [
    displayTimersByMember,
    game?.active_board1_team_member_id,
    game?.active_board2_team_member_id,
    game?.status,
    gameId,
    loadGameState,
    requestJson,
  ])

  useEffect(() => {
    const botMoveTimeoutIdByBoard = botMoveTimeoutIdByBoardRef.current
    const botMoveInFlightByBoard = botMoveInFlightByBoardRef.current
    const lastBotAttemptSignatureByBoard = lastBotAttemptSignatureByBoardRef.current

    const normalizedGameStatus = typeof game?.status === 'string' ? game.status.trim().toLowerCase() : ''

    if (normalizedGameStatus !== 'started') {
      return undefined
    }

    const scheduleBotMoveForBoard = (boardNumber) => {
      const activeMember = activeTurnMemberByBoard[boardNumber]
      const activeTeamMemberId = normalizePositiveInteger(activeMember?.team_member_id)
      const isActiveMemberBot = Boolean(activeMember?.is_bot === true)

      if (!isActiveMemberBot || !activeTeamMemberId) {
        lastBotAttemptSignatureByBoard[boardNumber] = ''

        const existingTimeoutId = botMoveTimeoutIdByBoard[boardNumber]
        if (existingTimeoutId) {
          window.clearTimeout(existingTimeoutId)
          botMoveTimeoutIdByBoard[boardNumber] = null
        }

        setBotThinkingByBoard((previousState) => ({
          ...previousState,
          [boardNumber]: false,
        }))
        return
      }

      if (botMoveInFlightByBoard[boardNumber] || botMoveTimeoutIdByBoard[boardNumber]) {
        return
      }

      const currentStateVersion = Math.max(0, Number(latestStateVersionRef.current) || 0)
      const attemptSignature = `${currentStateVersion}:${activeTeamMemberId}`

      if (lastBotAttemptSignatureByBoard[boardNumber] === attemptSignature) {
        return
      }

      lastBotAttemptSignatureByBoard[boardNumber] = attemptSignature

      const boardMembers = boardStructure[boardNumber] ?? { w: null, b: null }
      const whiteMember = boardMembers.w
      const blackMember = boardMembers.b
      const isBotVsBot = Boolean(whiteMember?.is_bot === true && blackMember?.is_bot === true)
      const delayMs = isBotVsBot ? 500 : 0

      const scheduledStateVersion = latestStateVersionRef.current

      const timeoutId = window.setTimeout(async () => {
        botMoveTimeoutIdByBoard[boardNumber] = null
        botMoveInFlightByBoard[boardNumber] = true

        // If state advanced after scheduling, skip this bot request to avoid TURN_MISMATCH 409.
        if (latestStateVersionRef.current > scheduledStateVersion) {
          botMoveInFlightByBoard[boardNumber] = false
          lastBotAttemptSignatureByBoard[boardNumber] = ''
          setBotThinkingByBoard((previousState) => ({
            ...previousState,
            [boardNumber]: false,
          }))
          setBotScheduleTick((v) => v + 1)
          return
        }

        setStatus({
          tone: 'pending',
          message: isBotVsBot ? `Board ${boardNumber}: bot is thinking (10s)...` : `Board ${boardNumber}: bot is calculating move...`,
        })

        try {
          const botMoveResult = await requestJson('/bot/moves', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              team_member_id: activeTeamMemberId,
            }),
          })

          if (botMoveResult.payload?.code === 'TURN_MISMATCH') {
            // Persistence may not have committed yet — clear signature so bot can retry next tick.
            lastBotAttemptSignatureByBoard[boardNumber] = ''
            await loadGameState({ silent: true, syncClock: true })
            return
          }

          if (!botMoveResult.response.ok || botMoveResult.payload?.ok !== true) {
            throw new Error(typeof botMoveResult.payload?.error === 'string' ? botMoveResult.payload.error : 'Bot move failed')
          }

          if (botMoveResult.payload?.bot_move?.waiting_for_reserve === true) {
            setStatus({
              tone: 'pending',
              message: `Board ${boardNumber}: bot is waiting for a reserve piece...`,
            })
            return
          }

          await loadGameState({ silent: true, syncClock: false })
          setStatus({ tone: 'success', message: `Board ${boardNumber}: bot moved.` })
        } catch (error) {
          setStatus({
            tone: 'error',
            message: error instanceof Error ? error.message : 'Bot move failed',
          })
        } finally {
          botMoveInFlightByBoard[boardNumber] = false
          setBotThinkingByBoard((previousState) => ({
            ...previousState,
            [boardNumber]: false,
          }))
          setBotScheduleTick((v) => v + 1)
        }
      }, delayMs)

      botMoveTimeoutIdByBoard[boardNumber] = timeoutId
      setBotThinkingByBoard((previousState) => ({
        ...previousState,
        [boardNumber]: true,
      }))
    }

    scheduleBotMoveForBoard(1)
    scheduleBotMoveForBoard(2)

    return () => {
      for (const boardNumber of [1, 2]) {
        const timeoutId = botMoveTimeoutIdByBoard[boardNumber]
        if (timeoutId) {
          window.clearTimeout(timeoutId)
          botMoveTimeoutIdByBoard[boardNumber] = null
        }
      }
    }
  }, [activeTurnMemberByBoard, boardStructure, game?.status, loadGameState, requestJson, botScheduleTick])

  useEffect(() => (
    () => {
      const botMoveTimeoutIdByBoard = botMoveTimeoutIdByBoardRef.current

      for (const boardNumber of [1, 2]) {
        const timeoutId = botMoveTimeoutIdByBoard[boardNumber]
        if (timeoutId) {
          window.clearTimeout(timeoutId)
          botMoveTimeoutIdByBoard[boardNumber] = null
        }
      }
    }
  ), [])

  const canControlBoard = useCallback((boardNumber) => {
    if (!userMember) {
      return false
    }

    return Number(userMember.board_number) === Number(boardNumber)
  }, [userMember])

  const canMoveOnBoard = useCallback((boardNumber) => {
    if (!userMember) {
      return false
    }

    const normalizedStatus = typeof game?.status === 'string' ? game.status.trim().toLowerCase() : ''
    if (normalizedStatus !== 'started') {
      return false
    }

    const activeMember = activeTurnMemberByBoard[boardNumber]
    if (!activeMember) {
      return false
    }

    return Number(activeMember.team_member_id) === Number(userMember.team_member_id)
  }, [activeTurnMemberByBoard, game?.status, userMember])

  const submitMove = useCallback(async ({ boardNumber, moveUci, capturedPiece }) => {
    if (!userMember) {
      return
    }

    const normalizedStatus = typeof game?.status === 'string' ? game.status.trim().toLowerCase() : ''
    if (normalizedStatus !== 'started') {
      setStatus({ tone: 'error', message: 'Game is already finished.' })
      return
    }

    setIsSendingMove(true)
    setStatus({ tone: 'pending', message: 'Submitting move...' })

    const optimisticMoveId = -(Date.now() + Math.floor(Math.random() * 1000))
    const highestKnownMoveNumber = moves.reduce((maxMoveNumber, move) => {
      const value = Number(move?.move_number)
      return Number.isFinite(value) ? Math.max(maxMoveNumber, value) : maxMoveNumber
    }, 0)
    const nextMoveNumber = Math.max(Number(game?.move_count) || 0, highestKnownMoveNumber) + 1

    const optimisticMove = {
      move_id: optimisticMoveId,
      move_number: nextMoveNumber,
      move_uci: moveUci,
      captured_piece: capturedPiece || null,
      team_member_id: userMember.team_member_id,
      board_number: boardNumber,
      piece_color: userMember.piece_color,
      is_bot: Boolean(userMember.is_bot),
      user_id: userMember.user_id ?? null,
    }

    setSelectedSquareByBoard((previousSelection) => ({ ...previousSelection, [boardNumber]: '' }))
    setLegalTargetsByBoard((previousTargets) => ({ ...previousTargets, [boardNumber]: [] }))
    setSelectedReserveByBoard((previousSelection) => ({ ...previousSelection, [boardNumber]: '' }))
    pendingOptimisticMovesRef.current.set(optimisticMoveId, optimisticMove)
    setMoves((prevMoves) => [...prevMoves, optimisticMove])
    setGame((previousGame) => applyOptimisticClockAfterLocalMove(previousGame, {
      boardNumber,
      boardStructure,
      movingPieceColor: typeof userMember?.piece_color === 'string' ? userMember.piece_color.trim().toLowerCase() : '',
    }))
    setClockTickMs(Date.now())

    const payload = {
      team_member_id: userMember.team_member_id,
      move_uci: moveUci,
    }

    if (capturedPiece) {
      payload.captured_piece = capturedPiece
    }

    try {
      let moveResult = null

      const activeSocket = gameSocketRef.current
      if (activeSocket?.connected && !hasBotPlayers) {
        moveResult = await new Promise((resolve) => {
          activeSocket.timeout(3000).emit('game:move', payload, (error, response) => {
            if (error) {
              resolve({ ok: false, error: 'Socket move request timed out' })
              return
            }

            resolve(response ?? { ok: false, error: 'No socket response' })
          })
        })
      }

      if (!moveResult || moveResult.ok !== true) {
        const httpFallback = await requestJson('/moves', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })

        moveResult = {
          ok: httpFallback.response.ok && httpFallback.payload?.ok === true,
          move: httpFallback.payload?.move,
          error: typeof httpFallback.payload?.error === 'string' ? httpFallback.payload.error : 'Move failed.',
        }
      }

      if (moveResult.ok !== true || !moveResult?.move) {
        pendingOptimisticMovesRef.current.delete(optimisticMoveId)
        setMoves((prevMoves) => prevMoves.filter((move) => Number(move?.move_id) !== optimisticMoveId))
        await loadGameState({ silent: true })
        setStatus({ tone: 'error', message: typeof moveResult?.error === 'string' ? moveResult.error : 'Move failed.' })
        return
      }

      if (moveResult.move?.timeout === true) {
        pendingOptimisticMovesRef.current.delete(optimisticMoveId)
        setMoves((prevMoves) => prevMoves.filter((move) => Number(move?.move_id) !== optimisticMoveId))
        await loadGameState({ silent: true, syncClock: true })
        return
      }

      const newMove = moveResult.move
      const moveStateVersion = resolveStateVersion({
        state_version: moveResult?.game_patch?.state_version ?? newMove?.state_version,
        move_count: moveResult?.game_patch?.move_count ?? newMove?.move_number,
      })
      latestStateVersionRef.current = Math.max(latestStateVersionRef.current, moveStateVersion)

      pendingOptimisticMovesRef.current.delete(optimisticMoveId)
      setMoves((prevMoves) => {
        const withoutOptimistic = prevMoves.filter((move) => Number(move?.move_id) !== optimisticMoveId)
        const incomingMoveId = normalizePositiveInteger(newMove?.move_id)

        if (incomingMoveId) {
          const alreadyExists = withoutOptimistic.some((move) => normalizePositiveInteger(move?.move_id) === incomingMoveId)
          if (alreadyExists) {
            return withoutOptimistic
          }
        }

        return [...withoutOptimistic, newMove]
      })

      if (moveResult?.game_patch && typeof moveResult.game_patch === 'object') {
        setGame((previousGame) => applyRealtimeGamePatch(previousGame, {
          ...moveResult.game_patch,
          state_version: moveStateVersion,
        }))
      } else {
        queueMicrotask(() => {
          void loadGameState({ silent: true, syncClock: false })
        })
      }

      setStatus({ tone: 'success', message: 'Move submitted.' })
    } catch (error) {
      pendingOptimisticMovesRef.current.delete(optimisticMoveId)
      setMoves((prevMoves) => prevMoves.filter((move) => Number(move?.move_id) !== optimisticMoveId))
      await loadGameState({ silent: true })
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Move failed.',
      })
    } finally {
      setIsSendingMove(false)
    }
  }, [boardStructure, game?.move_count, game?.status, hasBotPlayers, loadGameState, moves, requestJson, userMember])

  const handleSquareClick = useCallback(async ({ boardNumber, square }) => {
    const boardState = boardStates[boardNumber]
    if (!boardState) {
      return
    }

    const chess = boardState.chess
    const selectedReserve = selectedReserveByBoard[boardNumber]

    if (!canMoveOnBoard(boardNumber) || isSendingMove) {
      return
    }

    if (selectedReserve) {
      const targetPiece = chess.get(square)
      const rank = Number(square[1])

      if (targetPiece) {
        return
      }

      if (selectedReserve === 'p' && (rank === 1 || rank === 8)) {
        setStatus({ tone: 'error', message: 'Pawns cannot be dropped on the first or eighth rank.' })
        return
      }

      await submitMove({ boardNumber, moveUci: `@${selectedReserve}${square}` })
      return
    }

    const selectedSquare = selectedSquareByBoard[boardNumber]

    if (selectedSquare) {
      const legalTargets = legalTargetsByBoard[boardNumber] ?? []
      if (legalTargets.includes(square)) {
        const simulatedBoard = new Chess(chess.fen())
        const simulatedMove = simulatedBoard.move({
          from: selectedSquare,
          to: square,
          promotion: 'q',
        })

        if (!simulatedMove) {
          setSelectedSquareByBoard((previousSelection) => ({ ...previousSelection, [boardNumber]: '' }))
          setLegalTargetsByBoard((previousTargets) => ({ ...previousTargets, [boardNumber]: [] }))
          return
        }

        const capturedPiece = getCapturedPieceNameFromMove(simulatedMove)
        const moveUci = `${selectedSquare}${square}${simulatedMove.promotion ? simulatedMove.promotion : ''}`

        await submitMove({ boardNumber, moveUci, capturedPiece })
        return
      }

      setSelectedSquareByBoard((previousSelection) => ({ ...previousSelection, [boardNumber]: '' }))
      setLegalTargetsByBoard((previousTargets) => ({ ...previousTargets, [boardNumber]: [] }))
      return
    }

    const piece = chess.get(square)
    if (!piece) {
      return
    }

    const currentTurn = chess.turn()
    if (piece.color !== currentTurn) {
      return
    }

    const legalMoves = chess.moves({ square, verbose: true })
    if (!Array.isArray(legalMoves) || legalMoves.length === 0) {
      return
    }

    setSelectedSquareByBoard((previousSelection) => ({ ...previousSelection, [boardNumber]: square }))
    setLegalTargetsByBoard((previousTargets) => ({
      ...previousTargets,
      [boardNumber]: legalMoves.map((move) => move.to),
    }))
  }, [boardStates, canMoveOnBoard, isSendingMove, legalTargetsByBoard, selectedReserveByBoard, selectedSquareByBoard, submitMove])


  const handleCreateRematch = useCallback(async () => {
    if (!game || isCreatingRematch) {
      return
    }

    setIsCreatingRematch(true)
    setStatus({ tone: 'pending', message: 'Creating rematch lobby...' })

    const parsedTimeControl = typeof game?.time_control === 'string' ? game.time_control.trim() : String(game?.time_control ?? '').trim()
    const parsedIncrement = typeof game?.increment === 'string' ? game.increment.trim() : String(game?.increment ?? '').trim()
    const parsedGameName = typeof game?.game_name === 'string' && game.game_name.trim()
      ? game.game_name.trim()
      : 'Casual chess room'

    const createPayload = {
      time_control: parsedTimeControl || '5',
      increment: parsedIncrement || '0',
      game_name: `${parsedGameName} (Rematch)`,
      rated_game: Boolean(game?.rated_game),
      allow_spectators: typeof game?.allow_spectators === 'boolean' ? game.allow_spectators : true,
      public_game: typeof game?.public_game === 'boolean' ? game.public_game : false,
    }

    const createResult = await requestJson('/games', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createPayload),
    })

    if (!createResult.response.ok || createResult.payload?.ok !== true || !createResult.payload?.game) {
      setStatus({
        tone: 'error',
        message: typeof createResult.payload?.error === 'string'
          ? createResult.payload.error
          : 'Could not create rematch lobby.',
      })
      setIsCreatingRematch(false)
      return
    }

    const createdGameId = normalizePositiveInteger(createResult.payload.game?.game_id)

    if (!createdGameId) {
      setStatus({ tone: 'error', message: 'Rematch lobby created but missing game id.' })
      setIsCreatingRematch(false)
      return
    }

    // After getting createdGameId, call populate-rematch
    await requestJson(`/games/${createdGameId}/populate-rematch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_game_id: game.game_id }),
    }).catch(() => null) // non-critical, don't block redirect on failure

    window.location.assign(`/create?gameId=${encodeURIComponent(String(createdGameId))}`)
  }, [game, isCreatingRematch, requestJson])

  const handleDrawOffer = useCallback(async () => {
    if (!userMember?.team_member_id || isSubmittingDraw) return
    setIsSubmittingDraw(true)
    try {
      const result = await requestJson('/games/offers/draw', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_member_id: userMember.team_member_id }),
      })
      if (!result.response.ok) {
        setStatus({ tone: 'error', message: typeof result.payload?.error === 'string' ? result.payload.error : 'Draw offer failed.' })
      } else {
        void loadGameState({ silent: true })
      }
    } catch {
      setStatus({ tone: 'error', message: 'Draw offer failed.' })
    } finally {
      setIsSubmittingDraw(false)
    }
  }, [isSubmittingDraw, loadGameState, requestJson, userMember])

  const handleForfeitOffer = useCallback(async () => {
    if (!userMember?.team_member_id || isSubmittingForfeit) return
    setIsSubmittingForfeit(true)
    try {
      const result = await requestJson('/games/offers/forfeit', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_member_id: userMember.team_member_id }),
      })
      if (!result.response.ok) {
        setStatus({ tone: 'error', message: typeof result.payload?.error === 'string' ? result.payload.error : 'Forfeit failed.' })
      } else {
        void loadGameState({ silent: true })
      }
    } catch {
      setStatus({ tone: 'error', message: 'Forfeit failed.' })
    } finally {
      setIsSubmittingForfeit(false)
    }
  }, [isSubmittingForfeit, loadGameState, requestJson, userMember])

  const normalizedGameStatus = typeof game?.status === 'string' ? game.status.trim().toLowerCase() : ''
  const isGameFinished = normalizedGameStatus === 'finished'
  const isGameStarted = normalizedGameStatus === 'started'
  const allMembers = (Array.isArray(game?.teams) ? game.teams : []).flatMap((t) => Array.isArray(t.members) ? t.members : [])
  const humanMembers = allMembers.filter((m) => !m.is_bot)
  const drawAcceptedCount = humanMembers.filter((m) => m.draw_offer_accepted === true).length
  const drawTotalCount = humanMembers.length
  const userHasAcceptedDraw = Boolean(userMember?.draw_offer_accepted)
  const userTeam = Array.isArray(game?.teams) ? game.teams.find((t) => Number(t.team_id) === Number(userMember?.team_id)) : null
  const userTeamMembers = Array.isArray(userTeam?.members) ? userTeam.members : []
  const humanTeamMembers = userTeamMembers.filter((m) => !m.is_bot)
  const forfeitAcceptedCount = humanTeamMembers.filter((m) => m.forfeit_offer_accepted === true).length
  const forfeitTotalRequired = humanTeamMembers.length
  const userHasAcceptedForfeit = Boolean(userMember?.forfeit_offer_accepted)
  const winnerTeamId = normalizePositiveInteger(game?.winner_team_id)
  const winnerTeam = Array.isArray(game?.teams)
    ? game.teams.find((team) => Number(team?.team_id) === Number(winnerTeamId))
    : null
  const winnerTeamName = typeof winnerTeam?.team_name === 'string' && winnerTeam.team_name.trim()
    ? winnerTeam.team_name.trim()
    : winnerTeamId
      ? `Team ${winnerTeamId}`
      : 'No team'
  const finishReason = typeof game?.finish_reason === 'string' ? game.finish_reason.trim().toLowerCase() : ''
  const finishReasonLabel = finishReason === 'checkmate'
    ? 'Checkmate'
    : finishReason === 'timeout'
      ? 'Time out'
      : 'Game finished'

  if (!isAuthenticated) {
    return null
  }

  return (
    <div className="min-h-dvh bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <Navbar />
      {isSpectator && (
        <div className="flex items-center justify-center gap-2 bg-slate-800/80 border-b border-slate-700/50 px-4 py-2 text-sm text-slate-300">
          <svg viewBox="0 0 24 24" className="h-4 w-4 text-sky-400" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>You are spectating this game</span>
        </div>
      )}
      <div className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-[2200px] flex-col lg:grid lg:grid-cols-[2fr_1fr_2fr] lg:gap-3 lg:p-3 lg:overflow-hidden">
        <button
          type="button"
          onClick={() => setMobileCenterOpen((isOpen) => !isOpen)}
          className="m-2 rounded-lg border border-cyan-400/50 bg-slate-900/80 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-cyan-200 lg:hidden"
        >
          {mobileCenterOpen ? 'Hide Info Panel' : 'Show Info Panel'}
        </button>

        {boardOrder.map((boardNumber, index) => {
          const boardState = boardStates[boardNumber]
          const chess = boardState?.chess ?? new Chess()
          const orientation = getOrientationForBoard({ boardNumber, userMember, partnerMember })
          const rows = getBoardRows(chess, orientation)
          const boardMembers = boardStructure[boardNumber] ?? { w: null, b: null }
          const bottomMember = orientation === 'white' ? boardMembers.w : boardMembers.b
          const topMember = orientation === 'white' ? boardMembers.b : boardMembers.w
          const isBoardControllable = canControlBoard(boardNumber)
          const isBoardActive = canMoveOnBoard(boardNumber)
          const activeTurnMember = activeTurnMemberByBoard[boardNumber]
          const isPartnerThinking = Boolean(partnerMember && activeTurnMember && Number(partnerMember.team_member_id) === Number(activeTurnMember.team_member_id))
          const checkSquare = chess.inCheck() ? findKingSquare(chess, chess.turn()) : null
          const lastMoveSquares = boardState?.latestMoveSquares ?? { from: null, to: null }
          const selectedSquare = selectedSquareByBoard[boardNumber] || ''
          const legalTargets = legalTargetsByBoard[boardNumber] ?? []
          const selectedReserve = selectedReserveByBoard[boardNumber] || ''
          const reserveSourceMember = bottomMember
          const reserveSourceMemberId = normalizePositiveInteger(reserveSourceMember?.team_member_id)
          const reserve = reserveSourceMemberId ? (reservesByMember[reserveSourceMemberId] ?? {}) : {}

          const boardContainerClass = isBoardActive
            ? 'ring-2 ring-cyan-400/90 shadow-[0_0_40px_rgba(34,211,238,0.25)]'
            : isPartnerThinking
              ? 'ring-2 ring-emerald-400/70 shadow-[0_0_30px_rgba(52,211,153,0.2)]'
              : 'ring-1 ring-slate-700/60 opacity-95'

          const topTimerValue = formatClock(displayTimersByMember[normalizePositiveInteger(topMember?.team_member_id)] ?? getInitialSeconds(game))
          const bottomTimerValue = formatClock(displayTimersByMember[normalizePositiveInteger(bottomMember?.team_member_id)] ?? getInitialSeconds(game))
          const topIsActive = Boolean(activeTurnMember && topMember && Number(activeTurnMember.team_member_id) === Number(topMember.team_member_id))
          const bottomIsActive = Boolean(activeTurnMember && bottomMember && Number(activeTurnMember.team_member_id) === Number(bottomMember.team_member_id))
          const topRemaining = displayTimersByMember[normalizePositiveInteger(topMember?.team_member_id)] ?? getInitialSeconds(game)
          const bottomRemaining = displayTimersByMember[normalizePositiveInteger(bottomMember?.team_member_id)] ?? getInitialSeconds(game)
          const topLow = topRemaining <= 10
          const bottomLow = bottomRemaining <= 10

          return (
            <section key={boardNumber} className={`${index === 0 ? 'order-1' : 'order-3'} p-2 pb-3 lg:order-none lg:p-0`}>
              <div className="flex h-full flex-col rounded-2xl border border-slate-700/60 bg-slate-900/70 p-3 backdrop-blur">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <p className={`text-sm font-bold ${topMember && userMember && Number(topMember.team_id) === Number(userMember.team_id) ? 'text-cyan-300' : 'text-slate-200'}`}>
                      {memberName(topMember)}
                    </p>
                    <p className="text-xs text-slate-400">Board {boardNumber} • Opponent</p>
                  </div>
                  <p className={`font-mono text-2xl font-semibold ${topIsActive ? 'text-cyan-200' : 'text-slate-400'} ${topLow ? 'animate-pulse text-rose-400' : ''}`}>
                    {topTimerValue}
                  </p>
                </div>

                <div className="mb-2 rounded-xl border border-slate-700/70 bg-slate-800/70 p-2">
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">Reserve</p>
                  <div className="flex flex-wrap gap-1.5">
                    {['p', 'n', 'b', 'r', 'q'].map((pieceType) => {
                      const quantity = Number(reserve[pieceType] ?? 0)
                      const reservePieceAssetPath = getPieceAssetPath(orientation === 'white' ? 'white' : 'black', pieceType)
                      const canUsePiece = isBoardActive && isBoardControllable && quantity > 0

                      return (
                        <button
                          key={`${boardNumber}-${pieceType}`}
                          type="button"
                          onClick={() => {
                            if (!canUsePiece || isSendingMove) {
                              return
                            }

                            setSelectedSquareByBoard((previousSelection) => ({ ...previousSelection, [boardNumber]: '' }))
                            setLegalTargetsByBoard((previousTargets) => ({ ...previousTargets, [boardNumber]: [] }))
                            setSelectedReserveByBoard((previousSelection) => ({
                              ...previousSelection,
                              [boardNumber]: previousSelection[boardNumber] === pieceType ? '' : pieceType,
                            }))
                          }}
                          disabled={!canUsePiece || isSendingMove}
                          title={`${PIECE_LABELS[pieceType]} (${quantity})`}
                          className={`relative flex h-9 w-9 items-center justify-center rounded-md border text-lg transition ${
                            selectedReserve === pieceType
                              ? 'border-cyan-300 bg-cyan-500/25 text-cyan-100'
                              : 'border-slate-600 bg-slate-900/75 text-slate-100 hover:border-cyan-500/70'
                          } disabled:cursor-not-allowed disabled:opacity-40`}
                        >
                          {reservePieceAssetPath ? (
                            <img
                              src={reservePieceAssetPath}
                              alt={PIECE_LABELS[pieceType] ?? 'Reserve piece'}
                              className="h-6 w-6 object-contain"
                            />
                          ) : (
                            <span>{pieceType.toUpperCase()}</span>
                          )}
                          {quantity > 1 ? (
                            <span className="absolute -bottom-1.5 -right-1.5 rounded-full bg-cyan-500 px-1 text-[10px] font-bold text-slate-950">
                              {quantity}
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className={`relative mx-auto w-full max-w-[min(86vh,86vw)] overflow-hidden rounded-xl border border-slate-600/80 ${boardContainerClass}`}>
                  <div className="aspect-square w-full">
                    <div className="grid h-full w-full grid-cols-8 grid-rows-8">
                      {rows.map((row, rowIndex) => row.map((cell, cellIndex) => {
                        const squareClass = getSquareColorClass(cell.square)
                        const pieceAssetPath = cell.piece ? getPieceAssetPath(cell.piece.color, cell.piece.type) : ''
                        const isSelected = selectedSquare === cell.square
                        const isLegalTarget = legalTargets.includes(cell.square)
                        const isLastMoveFrom = lastMoveSquares.from === cell.square
                        const isLastMoveTo = lastMoveSquares.to === cell.square
                        const isCheckSquare = checkSquare === cell.square
                        const showBoardCoordinates = boardNumber === 1
                        const showRankLabel = showBoardCoordinates && cellIndex === 0
                        const showFileLabel = showBoardCoordinates && rowIndex === 7
                        const fileLabel = cell.square[0]
                        const rankLabel = cell.square[1]

                        return (
                          <button
                            key={`${boardNumber}-${cell.square}`}
                            type="button"
                            onClick={() => {
                              void handleSquareClick({ boardNumber, square: cell.square })
                            }}
                            className={`relative flex items-center justify-center text-[clamp(1.1rem,2.8vw,2rem)] ${squareClass} ${
                              isBoardControllable ? 'cursor-pointer hover:brightness-110' : 'cursor-default'
                            } ${isSelected ? 'ring-2 ring-cyan-300' : ''}`}
                            disabled={!isBoardControllable || isSendingMove}
                          >
                            {isLastMoveFrom || isLastMoveTo ? <span className="pointer-events-none absolute inset-0 bg-yellow-300/25" /> : null}
                            {isCheckSquare ? <span className="pointer-events-none absolute inset-0 bg-rose-500/45" /> : null}
                            {isLegalTarget ? <span className="pointer-events-none absolute h-3 w-3 rounded-full bg-cyan-200/85" /> : null}
                            {showRankLabel ? (
                              <span className="pointer-events-none absolute left-1 top-0.5 z-20 text-[10px] font-semibold uppercase tracking-wide text-slate-100/85">
                                {rankLabel}
                              </span>
                            ) : null}
                            {showFileLabel ? (
                              <span className="pointer-events-none absolute bottom-0.5 right-1 z-20 text-[10px] font-semibold uppercase tracking-wide text-slate-100/85">
                                {fileLabel}
                              </span>
                            ) : null}
                            {pieceAssetPath ? (
                              <img
                                src={pieceAssetPath}
                                alt={cell.piece ? `${cell.piece.color === 'w' ? 'White' : 'Black'} ${PIECE_LABELS[cell.piece.type] ?? 'piece'}` : 'Piece'}
                                className="relative z-10 h-[72%] w-[72%] object-contain"
                                draggable={false}
                              />
                            ) : (
                              <span className="relative z-10 leading-none">{cell.piece ? cell.piece.type.toUpperCase() : ''}</span>
                            )}
                          </button>
                        )
                      }))}
                    </div>
                  </div>
                </div>

                <div className="mt-2 flex items-start justify-between gap-2">
                  <div>
                    <p className={`text-sm font-bold ${bottomMember && userMember && Number(bottomMember.team_id) === Number(userMember.team_id) ? 'text-cyan-300' : 'text-slate-200'}`}>
                      {memberName(bottomMember)}
                    </p>
                    <p className="text-xs text-slate-400">{isBoardControllable ? 'Your board' : 'Partner board'}</p>
                  </div>
                  <p className={`font-mono text-2xl font-semibold ${bottomIsActive ? 'text-cyan-200' : 'text-slate-400'} ${bottomLow ? 'animate-pulse text-rose-400' : ''}`}>
                    {bottomTimerValue}
                  </p>
                </div>

                {isPartnerThinking ? (
                  <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-emerald-300">Partner is thinking…</p>
                ) : null}
                {botThinkingByBoard[boardNumber] ? (
                  <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-cyan-300">Bot is thinking…</p>
                ) : null}
              </div>
            </section>
          )
        })}

        <section className={`order-2 p-2 pb-3 lg:order-none lg:p-0 ${mobileCenterOpen ? 'block' : 'hidden lg:block'}`}>
          <div className="flex h-full flex-col rounded-2xl border border-slate-700/60 bg-slate-900/65 p-4 backdrop-blur">
            <div className="rounded-xl border border-slate-700/70 bg-slate-800/70 p-3">
              <h2 className="text-sm font-bold uppercase tracking-wide text-white">Teams</h2>
              <div className="mt-3 space-y-3">
                {(Array.isArray(game?.teams) ? game.teams : []).map((team) => {
                  const isUserTeam = Boolean(userMember && Number(team.team_id) === Number(userMember.team_id))
                  return (
                    <div key={team.team_id} className={`rounded-lg border p-2 ${isUserTeam ? 'border-cyan-500/50 bg-cyan-500/10' : 'border-slate-700/70 bg-slate-900/50'}`}>
                      <p className={`text-xs font-semibold uppercase tracking-wide ${isUserTeam ? 'text-cyan-200' : 'text-slate-300'}`}>
                        {team.team_name || `Team ${team.team_id}`}
                      </p>
                      <ul className="mt-1 space-y-1 text-sm text-slate-200">
                        {(Array.isArray(team.members) ? team.members : []).map((member) => (
                          <li key={member.team_member_id} className="flex items-center justify-between gap-2">
                            <span className="truncate">{memberName(member)}</span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="text-xs text-slate-400">Board {member.board_number}</span>
                              {!member.is_bot && member.user_id && (
                                <button
                                  type="button"
                                  onClick={() => setViewingPlayer({ userId: member.user_id, username: memberName(member) })}
                                  className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-700/60 border border-slate-600/50 text-slate-300 hover:bg-slate-600/60 hover:text-white transition-colors"
                                >
                                  View
                                </button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </div>
              <button
                type="button"
                onClick={() => window.location.assign('/home')}
                className="mt-2 w-full rounded-lg border border-slate-500 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-slate-300 hover:text-white"
              >
                Back to Main Menu
              </button>
            </div>

            {isGameStarted && userMember ? (
              <div className="mt-3 rounded-xl border border-slate-700/70 bg-slate-800/70 p-3">
                <h2 className="text-sm font-bold uppercase tracking-wide text-white">Game Actions</h2>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={handleDrawOffer}
                      disabled={isSubmittingDraw || userHasAcceptedDraw}
                      className={['w-full rounded-lg border px-2 py-2 text-xs font-semibold transition',
                        userHasAcceptedDraw
                          ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200 cursor-default'
                          : 'border-slate-600 bg-slate-900/50 text-slate-200 hover:border-emerald-400/50 hover:bg-emerald-500/10',
                        'disabled:opacity-60'].join(' ')}
                    >
                      {isSubmittingDraw ? 'Proposing…' : userHasAcceptedDraw ? 'Draw ✓' : 'Offer Draw'}
                    </button>
                    <div className="flex items-center gap-1.5">
                      <div className="flex-1 overflow-hidden rounded-full bg-slate-700" style={{ height: '6px' }}>
                        <div
                          className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                          style={{ width: drawTotalCount > 0 ? (Math.round((drawAcceptedCount / drawTotalCount) * 100) + '%') : '0%' }}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">{drawAcceptedCount}/{drawTotalCount}</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={handleForfeitOffer}
                      disabled={isSubmittingForfeit || userHasAcceptedForfeit}
                      className={['w-full rounded-lg border px-2 py-2 text-xs font-semibold transition',
                        userHasAcceptedForfeit
                          ? 'border-rose-400/60 bg-rose-500/20 text-rose-200 cursor-default'
                          : 'border-slate-600 bg-slate-900/50 text-slate-200 hover:border-rose-400/50 hover:bg-rose-500/10',
                        'disabled:opacity-60'].join(' ')}
                    >
                      {isSubmittingForfeit ? 'Forfeiting…' : userHasAcceptedForfeit ? 'Forfeit ✓' : 'Forfeit'}
                    </button>
                    <div className="flex items-center gap-1.5">
                      <div className="flex-1 overflow-hidden rounded-full bg-slate-700" style={{ height: '6px' }}>
                        <div
                          className="h-full rounded-full bg-rose-500 transition-all duration-300"
                          style={{ width: forfeitTotalRequired > 0 ? (Math.round((forfeitAcceptedCount / forfeitTotalRequired) * 100) + '%') : '0%' }}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">{forfeitAcceptedCount}/{forfeitTotalRequired}</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}


            <div className="mt-3 flex min-h-0 flex-1 flex-col">
              <ChatPanel
                gameId={gameId}
                userTeamId={userMember?.team_id ?? null}
                userTeamMemberId={userMember?.team_member_id ?? null}
                accessToken={typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null}
                socket={gameSocketRef.current}
                fillHeight
              />
            </div>
          </div>
        </section>
      </div>

      {isGameFinished ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 px-4">
          <div className="w-full max-w-md rounded-2xl border border-cyan-400/40 bg-slate-900/95 p-5 shadow-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Game Over</p>
            <h2 className="mt-2 text-2xl font-bold text-white">{winnerTeamId ? `${winnerTeamName} wins` : 'Draw'}</h2>
            <p className="mt-1 text-sm text-slate-300">Reason: {finishReasonLabel}</p>
            {typeof game?.result === 'string' && game.result.trim() ? (
              <p className="mt-2 text-sm text-slate-200">{game.result.trim()}</p>
            ) : null}

            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  void handleCreateRematch()
                }}
                disabled={isCreatingRematch}
                className="rounded-lg border border-cyan-400/60 bg-cyan-500/15 px-3 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCreatingRematch ? 'Creating…' : 'Rematch'}
              </button>
              <button
                type="button"
                onClick={() => window.location.assign('/home')}
                className="rounded-lg border border-slate-500 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-300 hover:text-white"
              >
                Go Home
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {viewingPlayer && (
        <PlayerProfileModal
          userId={viewingPlayer.userId}
          username={viewingPlayer.username}
          accessToken={typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null}
          onClose={() => setViewingPlayer(null)}
        />
      )}
    </div>
  )
}
