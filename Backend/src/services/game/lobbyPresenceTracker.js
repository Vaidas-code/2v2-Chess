const STALE_THRESHOLD_MS = 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 1000;

const lobbyPresence = new Map();

function normalizeGameId(value) {
	if (value === null || value === undefined) return null;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) return null;
	return parsed;
}

function normalizeUserId(value) {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return normalized.length > 0 ? normalized : null;
}

export function heartbeatLobbyPresence({ game_id, user_id, now = Date.now() }) {
	const normalizedGameId = normalizeGameId(game_id);
	const normalizedUserId = normalizeUserId(user_id);

	if (normalizedGameId == null || normalizedUserId == null) {
		return { game_id: null, active_count: 0 };
	}

	let users = lobbyPresence.get(normalizedGameId);
	if (!users) {
		users = new Map();
		lobbyPresence.set(normalizedGameId, users);
	}

	users.set(normalizedUserId, now);

	return {
		game_id: normalizedGameId,
		active_count: users.size,
	};
}

export function removeLobbyPresence({ game_id, user_id }) {
	const normalizedGameId = normalizeGameId(game_id);
	const normalizedUserId = normalizeUserId(user_id);

	if (normalizedGameId == null || normalizedUserId == null) {
		return { game_id: null, active_count: 0 };
	}

	const users = lobbyPresence.get(normalizedGameId);
	if (!users) {
		return { game_id: normalizedGameId, active_count: 0 };
	}

	users.delete(normalizedUserId);

	if (users.size === 0) {
		lobbyPresence.delete(normalizedGameId);
		return { game_id: normalizedGameId, active_count: 0 };
	}

	return { game_id: normalizedGameId, active_count: users.size };
}

export function collectStaleEmptyLobbyGameIds({
	now = Date.now(),
	staleThresholdMs = STALE_THRESHOLD_MS,
} = {}) {
	const staleGameIds = [];

	for (const [gameId, users] of lobbyPresence.entries()) {
		for (const [userId, lastSeen] of users.entries()) {
			if (now - lastSeen >= staleThresholdMs) {
				users.delete(userId);
			}
		}

		if (users.size === 0) {
			staleGameIds.push(gameId);
			lobbyPresence.delete(gameId);
		}
	}

	return staleGameIds;
}

export function getLobbyPresenceCleanupConfig() {
	return {
		staleThresholdMs: STALE_THRESHOLD_MS,
		cleanupIntervalMs: CLEANUP_INTERVAL_MS,
	};
}
