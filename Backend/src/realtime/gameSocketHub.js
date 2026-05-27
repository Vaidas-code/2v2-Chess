let ioInstance = null;

const GAME_ROOM_PREFIX = "game:";
const LOBBY_ROOM_NAME = "lobby:games";
const INBOX_ROOM_PREFIX = "inbox:user:";

function normalizePositiveInteger(value) {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}

	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	const parsed = Number(trimmed);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function registerSocketIo(io) {
	ioInstance = io ?? null;
}

export function getNormalizedGameId(value) {
	return normalizePositiveInteger(value);
}

export function getGameRoomName(gameId) {
	const normalizedGameId = normalizePositiveInteger(gameId);
	if (normalizedGameId === null) {
		return null;
	}

	return `${GAME_ROOM_PREFIX}${normalizedGameId}`;
}

export function getLobbyRoomName() {
	return LOBBY_ROOM_NAME;
}

export function getInboxRoomName(userId) {
	if (typeof userId !== "string") {
		return null;
	}

	const normalizedUserId = userId.trim().toLowerCase();
	if (!normalizedUserId) {
		return null;
	}

	return `${INBOX_ROOM_PREFIX}${normalizedUserId}`;
}

function emitToGameRoom(gameId, eventName, payload) {
	if (!ioInstance) {
		return;
	}

	const roomName = getGameRoomName(gameId);
	if (!roomName) {
		return;
	}

	ioInstance.to(roomName).emit(eventName, {
		...payload,
		game_id: Number(gameId),
		occurred_at: new Date().toISOString(),
	});
}

function emitToLobby(eventName, payload) {
	if (!ioInstance) {
		return;
	}

	ioInstance.to(LOBBY_ROOM_NAME).emit(eventName, {
		...payload,
		occurred_at: new Date().toISOString(),
	});
}

function emitToInboxUser(userId, eventName, payload) {
	if (!ioInstance) {
		return;
	}

	const roomName = getInboxRoomName(userId);
	if (!roomName) {
		return;
	}

	ioInstance.to(roomName).emit(eventName, {
		...payload,
		occurred_at: new Date().toISOString(),
	});
}

export function emitGameMoveCreated({ gameId, move }) {
	emitToGameRoom(gameId, "game:move-created", {
		move,
	});
}

export function emitGameReserveUpdated({ gameId, reserveUpdate }) {
	emitToGameRoom(gameId, "game:reserve-updated", {
		reserve_update: reserveUpdate,
	});
}

export function emitGameChatCreated({ gameId, chat }) {
	emitToGameRoom(gameId, "game:chat-created", {
		chat,
	});
}

export function emitGameStatusUpdated({ gameId, game }) {
	emitToGameRoom(gameId, "game:status-updated", {
		game,
	});
}

export function emitGameTeamMemberUpdated({ gameId, teamMember, action }) {
	emitToGameRoom(gameId, "game:team-member-updated", {
		action,
		team_member: teamMember,
	});
}

export function emitGameInviteUpdated({ gameId, action, invite }) {
	emitToGameRoom(gameId, "game:invite-updated", {
		action,
		invite,
	});
}

export function emitGameOfferUpdated({ gameId, offer }) {
	emitToGameRoom(gameId, "game:offer-updated", {
		offer,
	});
}

export function emitLobbyGameCreated({ game }) {
	emitToLobby("lobby:game-created", {
		game,
	});
}

export function emitLobbyGameUpdated({ game }) {
	emitToLobby("lobby:game-updated", {
		game,
	});
}

export function emitLobbyGameRemoved({ gameId, hostUserId, reason = "host-left" }) {
	emitToLobby("lobby:game-removed", {
		game_id: Number(gameId),
		host_user_id: hostUserId ?? null,
		reason,
	});
}

export function emitGameLobbyClosed({ gameId, hostUserId, kickedUserIds = [], reason = "host-left" }) {
	if (!ioInstance) {
		return;
	}

	const roomName = getGameRoomName(gameId);
	if (!roomName) {
		return;
	}

	ioInstance.to(roomName).emit("game:lobby-closed", {
		game_id: Number(gameId),
		host_user_id: hostUserId ?? null,
		kicked_user_ids: Array.isArray(kickedUserIds) ? kickedUserIds : [],
		reason,
		occurred_at: new Date().toISOString(),
	});

	ioInstance.in(roomName).socketsLeave(roomName);
}

export function emitInboxUpdated({ userId, reason = "updated", itemType = "game_invite" }) {
	emitToInboxUser(userId, "inbox:updated", {
		reason,
		item_type: itemType,
		user_id: userId ?? null,
	});
}
