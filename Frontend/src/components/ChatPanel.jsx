import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_API_BASE_URL = 'http://localhost:3001'

const PIECES = [
  { name: 'Pawn', symbol: '♙' },
  { name: 'Knight', symbol: '♞' },
  { name: 'Bishop', symbol: '♝' },
  { name: 'Rook', symbol: '♜' },
  { name: 'Queen', symbol: '♛' },
]

const GAMEPLAY_MESSAGES = [
  'Play slow! We have time!',
  'Hurry up!',
  'Wait!',
]

const GAME_QUICK_MESSAGES = [
  'Hi!',
  'Good game!',
  'Well played!',
  'Rematch?',
  'I had a great time!',
  'Goodbye!',
]

// API is source of truth; keep any socket-added messages not yet returned by the API
function mergeMessages(prev, apiMessages) {
  const apiMap = new Map(apiMessages.map((m) => [m.chat_id, m]))
  const socketOnly = prev.filter((m) => !apiMap.has(m.chat_id))
  const merged = [...apiMessages, ...socketOnly]
  merged.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  return merged
}

function getApiBaseUrl() {
  const configuredApiBaseUrl = typeof import.meta.env.VITE_API_BASE_URL === 'string'
    ? import.meta.env.VITE_API_BASE_URL.trim()
    : ''

  const resolvedApiBaseUrl = configuredApiBaseUrl || DEFAULT_API_BASE_URL
  return resolvedApiBaseUrl.endsWith('/') ? resolvedApiBaseUrl.slice(0, -1) : resolvedApiBaseUrl
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

export default function ChatPanel({
  gameId,
  userTeamId,
  userTeamMemberId,
  accessToken,
  socket = null,
  fillHeight = false,
}) {
  const apiBaseUrl = getApiBaseUrl()
  const [activeTab, setActiveTab] = useState('team')
  const [gameMessages, setGameMessages] = useState([])
  const [teamMessages, setTeamMessages] = useState([])
  const [messageInput, setMessageInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [status, setStatus] = useState('')
  const [isMinimized, setIsMinimized] = useState(false)
  const [selectedPiece, setSelectedPiece] = useState(null)
  const [showGameplay, setShowGameplay] = useState(false)
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [gameMessages, teamMessages, activeTab])

  const loadMessages = useCallback(async () => {
    if (!gameId || !accessToken) return

    try {
      const gameResponse = await fetch(
        `${apiBaseUrl}/games/${encodeURIComponent(String(gameId))}/chats?chat_type=game`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      )

      if (gameResponse.ok) {
        const gamePayload = await gameResponse.json()
        if (gamePayload?.ok && Array.isArray(gamePayload.messages)) {
          setGameMessages((prev) => mergeMessages(prev, gamePayload.messages))
        }
      }

      if (userTeamId) {
        const teamResponse = await fetch(
          `${apiBaseUrl}/teams/${encodeURIComponent(String(userTeamId))}/chats`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        )

        if (teamResponse.ok) {
          const teamPayload = await teamResponse.json()
          if (teamPayload?.ok && Array.isArray(teamPayload.messages)) {
            setTeamMessages((prev) => mergeMessages(prev, teamPayload.messages))
          }
        }
      }
    } catch (error) {
      console.error('Error loading chat messages:', error)
    }
  }, [gameId, userTeamId, accessToken, apiBaseUrl])

  useEffect(() => {
    loadMessages()
    const refreshInterval = setInterval(loadMessages, 3000)
    return () => clearInterval(refreshInterval)
  }, [loadMessages])

  useEffect(() => {
    if (!socket) return

    const handleChatCreated = (data) => {
      const chat = data?.chat
      if (!chat) return
      const isTeamChat = chat.chat_type === 'team'
      if (isTeamChat) {
        setTeamMessages((prev) =>
          prev.some((m) => m.chat_id === chat.chat_id) ? prev : [...prev, chat]
        )
      } else {
        setGameMessages((prev) =>
          prev.some((m) => m.chat_id === chat.chat_id) ? prev : [...prev, chat]
        )
      }
    }

    socket.on('game:chat-created', handleChatCreated)
    return () => socket.off('game:chat-created', handleChatCreated)
  }, [socket])

  const sendMessage = async (text, chatType = activeTab) => {
    if (!text.trim() || !accessToken) {
      setStatus('Cannot send message')
      return
    }

    if (!userTeamMemberId) {
      setStatus('Join a team slot to send messages')
      return
    }

    if (chatType === 'game' && !gameId) {
      setStatus('Game chat is not available right now')
      return
    }

    if (chatType === 'team' && !userTeamId) {
      setStatus('You must be in a team to send team messages')
      return
    }

    setIsSending(true)
    setStatus('')

    try {
      const response = await fetch(`${apiBaseUrl}/game-chats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          team_member_id: userTeamMemberId || undefined,
          game_id: gameId,
          message: text.trim(),
          chat_type: chatType,
        }),
      })

      if (response.status === 401) {
        setStatus('Session expired. Please refresh.')
        return
      }

      const payload = await response.json()

      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Failed to send message')
      }

      setStatus('Message sent')
      setTimeout(() => setStatus(''), 2000)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to send message')
    } finally {
      setIsSending(false)
    }
  }

  const handleSendMessage = async (e) => {
    e.preventDefault()
    await sendMessage(messageInput)
    setMessageInput('')
  }

  const handleQuickMessage = async (text) => {
    if (isSending) return
    await sendMessage(text, activeTab)
  }

  const messages = activeTab === 'game' ? gameMessages : teamMessages
  const canSendTeamChat = activeTab === 'team' && userTeamId && userTeamMemberId
  const canSendCurrentTab = Boolean(accessToken && userTeamMemberId) && (activeTab === 'game' ? Boolean(gameId) : Boolean(userTeamId))
  const showQuickMessages = fillHeight && Boolean(userTeamMemberId) && !isMinimized

  const containerStyle = fillHeight ? {} : { height: isMinimized ? '52px' : '640px' }
  const containerClass = [
    'flex flex-col overflow-hidden rounded-lg border border-slate-700/60 bg-slate-900/50 shadow-lg',
    fillHeight ? 'h-full' : 'transition-[height] duration-200',
  ].join(' ')

  return (
    <div className={containerClass} style={containerStyle}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-700/50 bg-slate-800/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <ChatIcon />
          <h3 className="font-semibold text-slate-200">Game Chat</h3>
        </div>
        <button
          onClick={() => setIsMinimized(!isMinimized)}
          className="text-lg font-bold text-slate-400 hover:text-slate-200 transition-colors w-6 h-6 flex items-center justify-center"
          title={isMinimized ? 'Expand' : 'Minimize'}
        >
          {isMinimized ? '+' : '−'}
        </button>
      </div>

      {!isMinimized && (
        <>
          {/* Tabs */}
          <div className="flex gap-2 border-b border-slate-700/50 bg-slate-900/30 px-3 py-2">
            <button
              onClick={() => setActiveTab('game')}
              className={`px-3 py-1 text-sm font-medium rounded transition-colors ${
                activeTab === 'game'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'text-slate-400 hover:text-slate-300'
              }`}
            >
              Game Chat
            </button>
            <button
              onClick={() => setActiveTab('team')}
              disabled={!userTeamId}
              className={`px-3 py-1 text-sm font-medium rounded transition-colors ${
                activeTab === 'team'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                  : userTeamId
                    ? 'text-slate-400 hover:text-slate-300'
                    : 'text-slate-600 cursor-not-allowed'
              }`}
              title={!userTeamId ? 'Join a team to use team chat' : ''}
            >
              Team Chat {!userTeamId && '(disabled)'}
            </button>
          </div>

          {/* Quick Messages */}
          {showQuickMessages && activeTab === 'game' && (
            <div className="border-b border-slate-700/50 bg-slate-900/30 px-3 py-2">
              <div className="flex items-center gap-1 flex-wrap">
                {GAME_QUICK_MESSAGES.map((msg) => (
                  <button
                    key={msg}
                    type="button"
                    onClick={() => { void handleQuickMessage(msg) }}
                    disabled={isSending || !canSendCurrentTab}
                    className="px-2 py-1 rounded-md text-xs border bg-slate-800/70 border-slate-600/40 text-slate-300 hover:bg-slate-700/70 hover:text-slate-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {msg}
                  </button>
                ))}
              </div>
            </div>
          )}

          {showQuickMessages && activeTab === 'team' && (
            <div className="border-b border-slate-700/50 bg-slate-900/30 px-3 py-2 space-y-2">

              {/* Pieces row */}
              <div className="flex items-center gap-1 flex-wrap">
                {PIECES.map((piece) => (
                  <button
                    key={piece.name}
                    type="button"
                    onClick={() => { setSelectedPiece((p) => p === piece.name ? null : piece.name); setShowGameplay(false) }}
                    className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs border transition-colors ${
                      selectedPiece === piece.name
                        ? 'bg-indigo-600/40 border-indigo-500/50 text-indigo-200'
                        : 'bg-slate-800/70 border-slate-600/40 text-slate-300 hover:bg-slate-700/70 hover:text-slate-100'
                    }`}
                  >
                    <span className="text-sm leading-none">{piece.symbol}</span>
                    <span>{piece.name}</span>
                  </button>
                ))}
              </div>

              {/* Piece +/- actions */}
              {selectedPiece && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => { void handleQuickMessage(`Give me ${selectedPiece}!`); setSelectedPiece(null) }}
                    disabled={isSending || !canSendCurrentTab}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/35 hover:text-emerald-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <span className="text-sm font-bold leading-none">+</span>
                    Give me {selectedPiece}!
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleQuickMessage(`Protect your ${selectedPiece}!`); setSelectedPiece(null) }}
                    disabled={isSending || !canSendCurrentTab}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-rose-600/20 border border-rose-500/40 text-rose-300 hover:bg-rose-600/35 hover:text-rose-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <span className="text-sm font-bold leading-none">−</span>
                    Protect your {selectedPiece}!
                  </button>
                </div>
              )}

              {/* Gameplay row */}
              <div className="flex items-center gap-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => { setShowGameplay((v) => !v); setSelectedPiece(null) }}
                  className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs border transition-colors ${
                    showGameplay
                      ? 'bg-sky-600/40 border-sky-500/50 text-sky-200'
                      : 'bg-slate-800/70 border-slate-600/40 text-slate-300 hover:bg-slate-700/70 hover:text-slate-100'
                  }`}
                >
                  Gameplay
                  <svg viewBox="0 0 10 6" className="h-2.5 w-2.5 opacity-60" fill="currentColor" aria-hidden="true">
                    <path d={showGameplay ? 'M0 6 5 0 10 6z' : 'M0 0 5 6 10 0z'} />
                  </svg>
                </button>

                {showGameplay && GAMEPLAY_MESSAGES.map((msg) => (
                  <button
                    key={msg}
                    type="button"
                    onClick={() => { void handleQuickMessage(msg); setShowGameplay(false) }}
                    disabled={isSending || !canSendCurrentTab}
                    className="px-2 py-1 rounded-md text-xs border bg-slate-800/70 border-slate-600/40 text-slate-300 hover:bg-slate-700/70 hover:text-slate-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {msg}
                  </button>
                ))}
              </div>

            </div>
          )}

          {/* Messages Container */}
          <div
            className={['overflow-y-auto px-3 py-2 space-y-2', fillHeight ? 'flex-1 min-h-0' : ''].join(' ')}
            style={fillHeight ? undefined : { maxHeight: '480px' }}
          >
            {messages.length === 0 ? (
              <div className="flex items-center justify-center h-full text-slate-500 text-xs">
                No messages yet
              </div>
            ) : (
              <>
                {messages.map((msg, idx) => (
                  <div key={msg.chat_id || idx} className="flex flex-col gap-0.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-200">{msg.username || 'Unknown'}</span>
                      <span className="text-slate-500 text-[10px]">
                        {new Date(msg.created_at).toLocaleTimeString('en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <div className="text-slate-300 break-words pl-2 border-l border-slate-600/30 text-xs">
                      {msg.message}
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Input */}
          <div className="border-t border-slate-700/50 bg-slate-800/50 p-2">
            {!userTeamMemberId ? (
              <div className="text-xs text-slate-400 text-center py-1">
                Join a team slot to send messages
              </div>
            ) : !canSendTeamChat && activeTab === 'team' ? (
              <div className="text-xs text-slate-400 text-center py-1">
                Join a team to send team messages
              </div>
            ) : (
              <form onSubmit={handleSendMessage} className="flex flex-col gap-1">
                <input
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  disabled={isSending || !canSendCurrentTab}
                  placeholder={activeTab === 'game' ? 'Send game message...' : 'Send team message...'}
                  className="w-full rounded-lg bg-slate-700/50 px-2 py-1 text-xs text-slate-100 placeholder-slate-500 border border-slate-600/50 focus:border-emerald-500/50 focus:outline-none disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={isSending || !canSendCurrentTab || !messageInput.trim() || (activeTab === 'team' && !userTeamId)}
                  className="rounded-lg bg-emerald-500/20 px-2 py-1 text-xs font-semibold text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSending ? 'Sending...' : 'Send'}
                </button>
                {status && (
                  <div className={`text-xs ${
                    status.includes('Error') || status.includes('Cannot') ? 'text-rose-300' : 'text-emerald-300'
                  }`}>
                    {status}
                  </div>
                )}
              </form>
            )}
          </div>
        </>
      )}
    </div>
  )
}
