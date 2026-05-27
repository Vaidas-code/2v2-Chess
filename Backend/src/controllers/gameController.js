import pool from "../config/db.js";
import { authenticateRefreshSession } from "../models/userModel.js";
import {
	assignRematchPlayers,
	createGame,
	deleteGameBySystem,
	deleteLobbyGameByHost,
	getGameByIdWithTeams,
	getGameByInviteToken,
	getGameInviteTokenByGameId,
	getPublicLobbyGames,
	getGameStats,
	getSpectatorGames,
	markGameFinished,
	markGameStarted,
	synchronizeGameClock,
	updateLobbyGameNameByHost,
	updateLobbyGameSettingsByHost,
	updateLobbyTeamNameByHost,
} from "../models/gameModel.js";
import { verifyRefreshToken } from "../security/tokenService.js";
import {
	emitGameLobbyClosed,
	emitGameStatusUpdated,
	emitLobbyGameCreated,
	emitLobbyGameRemoved,
	emitLobbyGameUpdated,
} from "../realtime/gameSocketHub.js";
import {
	collectStaleEmptyLobbyGameIds,
	getLobbyPresenceCleanupConfig,
	heartbeatLobbyPresence,
	removeLobbyPresence,
} from "../services/game/lobbyPresenceTracker.js";
import { findActiveGamesForUser } from "../models/gameParticipationModel.js";
import { getGameRealtimeSnapshot } from "../realtime/gameRealtimeSnapshot.js";

const REQUIRED_GAME_FIELDS = ["time_control", "increment"];

let lobbyInactivityCleanupInterval = null;
let lobbyInactivityCleanupRunning = false;

async function runLobbyInactivityCleanup() {
	if (lobbyInactivityCleanupRunning) {
		return;
	}

	lobbyInactivityCleanupRunning = true;

	try {
		const staleGameIds = collectStaleEmptyLobbyGameIds();

		for (const gameId of staleGameIds) {
			try {
				const game = await getGameByIdWithTeams(gameId);
				const normalizedGameStatus = String(game?.status ?? "").toLowerCase();

				if (normalizedGameStatus === "finished" || normalizedGameStatus === "started") {
					continue;
				}

				const cancellationResult = await deleteGameBySystem({ game_id: gameId });

				emitGameLobbyClosed({
					gameId: cancellationResult.game.game_id,
					hostUserId: cancellationResult.host_user_id,
					kickedUserIds: cancellationResult.kicked_user_ids,
					reason: "lobby-inactive",
				});

				emitLobbyGameRemoved({
					gameId: cancellationResult.game.game_id,
					hostUserId: cancellationResult.host_user_id,
					reason: "lobby-inactive",
				});
			} catch (error) {
				if (
					error?.code === "GAME_NOT_FOUND" ||
					error?.code === "GAME_ALREADY_FINISHED" ||
					error?.code === "GAME_NOT_IN_LOBBY"
				) {
					continue;
				}

				console.error("Error cleaning up inactive lobby:", error);
			}
		}
	} finally {
		lobbyInactivityCleanupRunning = false;
	}
}

export function startLobbyInactivityCleanup() {
	if (lobbyInactivityCleanupInterval) {
		return;
	}

	const { cleanupIntervalMs } = getLobbyPresenceCleanupConfig();
	lobbyInactivityCleanupInterval = setInterval(() => {
		void runLobbyInactivityCleanup();
	}, cleanupIntervalMs);
}

export function stopLobbyInactivityCleanup() {
	if (!lobbyInactivityCleanupInterval) {
		return;
	}

	clearInterval(lobbyInactivityCleanupInterval);
	lobbyInactivityCleanupInterval = null;
}

function normalizeStartGamePayload(body, authenticatedUserId) {
	const normalizedUserId = typeof authenticatedUserId === "string"
		? authenticatedUserId.trim()
		: String(authenticatedUserId ?? "").trim();
	const normalizedTimeControl = typeof body?.time_control === "string"
		? body.time_control.trim()
		: String(body?.time_control ?? "").trim();
	const normalizedIncrement = typeof body?.increment === "string"
		? body.increment.trim()
		: String(body?.increment ?? "").trim();
	const normalizedGameName = typeof body?.game_name === "string"
		? body.game_name.trim()
		: String(body?.game_name ?? "").trim();
	const ratedGame = body?.rated_game;
	const allowSpectators = body?.allow_spectators;
	const publicGame = body?.public_game;

	return {
		user_id: normalizedUserId,
		time_control: normalizedTimeControl,
		increment: normalizedIncrement,
		game_name: normalizedGameName,
		rated_game: ratedGame,
		allow_spectators: allowSpectators,
		public_game: publicGame,
	};
}

function getMissingGameFields(payload) {
	return REQUIRED_GAME_FIELDS.filter((field) => !payload[field]);
}

function getStartGameErrorResponse(error) {
	if (
		error?.code === "USER_ID_REQUIRED" ||
		error?.code === "INVALID_USER_ID" ||
		error?.code === "TIME_CONTROL_REQUIRED" ||
		error?.code === "INCREMENT_REQUIRED"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "USER_ALREADY_IN_ACTIVE_GAME") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "USER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getUpdateGameStatusErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "GAME_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "INVALID_GAME_ID") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "GAME_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getLeaveBeaconErrorResponse(error) {
	if (error?.code === "MISSING_REFRESH_TOKEN") {
		return { status: 400, error: "refreshToken is required" };
	}

	if (error?.code === "INVALID_REFRESH_TOKEN") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "GAME_HOST_REQUIRED" || error?.code === "GAME_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "INVALID_GAME_ID") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "GAME_NOT_IN_LOBBY") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "GAME_ALREADY_FINISHED") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "GAME_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (error?.code === "AUTH_CONFIGURATION_ERROR") {
		return { status: 500, error: "Authentication is not configured correctly" };
	}

	return { status: 500, error: "Internal server error" };
}

function parseLeaveBeaconRefreshToken(req) {
	if (typeof req.body === "string") {
		const rawBody = req.body.trim();

		if (rawBody) {
			try {
				const parsedBody = JSON.parse(rawBody);
				if (typeof parsedBody?.refreshToken === "string") {
					return parsedBody.refreshToken.trim();
				}
			} catch {
				const params = new URLSearchParams(rawBody);
				const token = params.get("refreshToken");
				if (typeof token === "string") {
					return token.trim();
				}
			}
		}
	}

	if (typeof req.body?.refreshToken === "string") {
		return req.body.refreshToken.trim();
	}

	return "";
}

function getCancelLobbyGameErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "INVALID_GAME_ID") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "GAME_HOST_REQUIRED" || error?.code === "GAME_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "GAME_NOT_IN_LOBBY") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "GAME_ALREADY_FINISHED") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "GAME_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getUpdateTeamNameErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (
		error?.code === "INVALID_GAME_ID" ||
		error?.code === "INVALID_TEAM_ID" ||
		error?.code === "TEAM_NAME_REQUIRED"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "GAME_HOST_REQUIRED" || error?.code === "GAME_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "GAME_NOT_IN_LOBBY") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "GAME_NOT_FOUND" || error?.code === "TEAM_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getUpdateGameNameErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "INVALID_GAME_ID" || error?.code === "GAME_NAME_REQUIRED") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "GAME_HOST_REQUIRED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "GAME_NOT_IN_LOBBY") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "GAME_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getUpdateGameSettingsErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (
		error?.code === "INVALID_GAME_ID" ||
		error?.code === "NO_SETTINGS_UPDATE_FIELDS" ||
		error?.code === "TIME_CONTROL_REQUIRED" ||
		error?.code === "INCREMENT_REQUIRED" ||
		error?.code === "TIME_CONTROL_AND_INCREMENT_REQUIRED" ||
		error?.code === "INVALID_RATED_GAME" ||
		error?.code === "INVALID_ALLOW_SPECTATORS" ||
		error?.code === "INVALID_PUBLIC_GAME"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "GAME_HOST_REQUIRED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "GAME_NOT_IN_LOBBY") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "GAME_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getInviteGameErrorResponse(error) {
	if (error?.code === "INVITE_TOKEN_REQUIRED") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "INVITE_TOKEN_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getGameInviteLinkErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "GAME_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "INVALID_GAME_ID") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "GAME_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function normalizeBaseUrl(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim().replace(/\/$/, "");
}

function getRequestOrigin(req) {
	if (typeof req?.get !== "function") {
		return "";
	}

	const originHeader = normalizeBaseUrl(String(req.get("origin") ?? ""));
	if (originHeader) {
		return originHeader;
	}

	const refererHeader = String(req.get("referer") ?? "").trim();
	if (refererHeader) {
		try {
			return normalizeBaseUrl(new URL(refererHeader).origin);
		} catch {
			return "";
		}
	}

	return "";
}

function getRequestHostBaseUrl(req) {
	if (typeof req?.get !== "function") {
		return "";
	}

	const forwardedHost = String(req.get("x-forwarded-host") ?? "").split(",")[0].trim();
	const forwardedProto = String(req.get("x-forwarded-proto") ?? "").split(",")[0].trim();

	if (forwardedHost) {
		const protocol = forwardedProto || req.protocol || "http";
		return `${protocol}://${forwardedHost}`;
	}

	const host = String(req.get("host") ?? "").trim();
	if (!host) {
		return "";
	}

	const protocol = req.protocol || "http";
	return `${protocol}://${host}`;
}

function resolveFrontendBaseUrl(req) {
	const configuredFrontendUrl = normalizeBaseUrl(process.env.FRONTEND_BASE_URL);
	if (configuredFrontendUrl) {
		return configuredFrontendUrl;
	}

	const configuredClientUrl = normalizeBaseUrl(process.env.CLIENT_BASE_URL);
	if (configuredClientUrl) {
		return configuredClientUrl;
	}

	const configuredAppUrl = normalizeBaseUrl(process.env.FRONTEND_URL);
	if (configuredAppUrl) {
		return configuredAppUrl;
	}

	const requestOrigin = getRequestOrigin(req);
	if (requestOrigin) {
		return requestOrigin;
	}

	const requestHostBaseUrl = getRequestHostBaseUrl(req);
	if (requestHostBaseUrl) {
		return requestHostBaseUrl;
	}

	const configuredApiUrl = normalizeBaseUrl(process.env.API_BASE_URL);
	if (configuredApiUrl) {
		return configuredApiUrl;
	}

	const frontendPort = Number(process.env.FRONTEND_PORT) || 5173;
	return `http://localhost:${frontendPort}`;
}

function buildInviteLinkPayload(inviteToken, req) {
	const normalizedToken = typeof inviteToken === "string" ? inviteToken.trim() : "";
	const encodedToken = encodeURIComponent(normalizedToken);
	const invitePath = `/join/${encodedToken}`;
	const frontendBaseUrl = resolveFrontendBaseUrl(req);

	return {
		invite_token: normalizedToken,
		invite_path: invitePath,
		invite_url: `${frontendBaseUrl}${invitePath}`,
	};
}

function normalizeUserId(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim().toLowerCase();
}

async function grantLobbyAccessFromInviteToken(game, actingUserId, queryExecutor = pool) {
	const normalizedActingUserId = normalizeUserId(actingUserId);
	const normalizedHostUserId = normalizeUserId(game?.user_id);
	const normalizedGameId = Number.parseInt(String(game?.game_id ?? ""), 10);

	if (!normalizedActingUserId || !Number.isInteger(normalizedGameId) || normalizedGameId <= 0) {
		return;
	}

	if (normalizedHostUserId && normalizedHostUserId === normalizedActingUserId) {
		return;
	}

	await queryExecutor.query(
		`INSERT INTO gameplay.inbox_items (
			user_id,
			item_type,
			source_id,
			message,
			received_at,
			is_read,
			read_at,
			sender_user_id
		)
		VALUES ($1::uuid, 'game_invite', $2, NULL, NOW(), FALSE, NULL, $3::uuid)
		ON CONFLICT (user_id, item_type, source_id)
		DO UPDATE SET
			sender_user_id = EXCLUDED.sender_user_id,
			received_at = NOW(),
			is_read = FALSE,
			read_at = NULL`,
		[actingUserId, normalizedGameId, game.user_id]
	);
}

async function ensureUserCanAccessGame(gameId, actingUserId, queryExecutor = pool) {
	const normalizedGameId = Number.parseInt(String(gameId ?? ""), 10);

	if (!Number.isInteger(normalizedGameId) || normalizedGameId <= 0) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	const normalizedActingUserId = normalizeUserId(actingUserId);

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const accessResult = await queryExecutor.query(
		`SELECT 1
		 FROM gameplay.games g
		 WHERE g.game_id = $1 AND LOWER(g.user_id::text) = $2

		 UNION

		 SELECT 1
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1 AND LOWER(tm.user_id::text) = $2

		 UNION

		 SELECT 1
		 FROM gameplay.inbox_items ii
		 WHERE ii.item_type = 'game_invite'
		   AND ii.source_id = $1
		   AND LOWER(ii.user_id::text) = $2

		 UNION

		 SELECT 1
		 FROM gameplay.games g
		 WHERE g.game_id = $1
		   AND g.status = 'in_progress'
		   AND g.public_game = TRUE

		 UNION

		 SELECT 1
		 FROM gameplay.games g
		 WHERE g.game_id = $1
		   AND g.status = 'started'
		   AND g.allow_spectators = TRUE

		 LIMIT 1`,
		[normalizedGameId, normalizedActingUserId]
	);

	if (accessResult.rowCount === 0) {
		const error = new Error("You do not have access to this game");
		error.code = "GAME_ACCESS_DENIED";
		throw error;
	}
}

export async function startGame(req, res) {
	const authenticatedUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!authenticatedUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	const payload = normalizeStartGamePayload(req.body, authenticatedUserId);
	const missingFields = getMissingGameFields(payload);

	if (missingFields.length > 0) {
		return res.status(400).json({
			ok: false,
			error: `${missingFields.join(", ")} are required`,
		});
	}

	try {
		const game = await createGame(payload);

		emitLobbyGameCreated({ game });

		return res.status(201).json({ ok: true, game });
	} catch (error) {
		console.error("Error starting game:", error);
		const { status, error: message } = getStartGameErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function setGameStarted(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const actingUserId = req.auth?.id;

	try {
		await ensureUserCanAccessGame(gameId, actingUserId);

		const game = await markGameStarted(gameId);

		emitGameStatusUpdated({
			gameId: game.game_id,
			game,
		});

		emitLobbyGameUpdated({ game });

		return res.status(200).json({ ok: true, game });
	} catch (error) {
		console.error("Error updating game status to started:", error);
		const { status, error: message } = getUpdateGameStatusErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function cancelLobbyGame(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const cancellationResult = await deleteLobbyGameByHost({
			game_id: gameId,
			acting_user_id: actingUserId,
		});

		emitGameLobbyClosed({
			gameId: cancellationResult.game.game_id,
			hostUserId: cancellationResult.host_user_id,
			kickedUserIds: cancellationResult.kicked_user_ids,
			reason: "host-left",
		});

		emitLobbyGameRemoved({
			gameId: cancellationResult.game.game_id,
			hostUserId: cancellationResult.host_user_id,
			reason: "host-left",
		});

		return res.status(200).json({
			ok: true,
			game: cancellationResult.game,
			host_user_id: cancellationResult.host_user_id,
			kicked_user_ids: cancellationResult.kicked_user_ids,
			message: "Game lobby closed because host left",
		});
	} catch (error) {
		console.error("Error canceling lobby game:", error);
		const { status, error: message } = getCancelLobbyGameErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function cancelLobbyGameOnLeaveBeacon(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const refreshToken = parseLeaveBeaconRefreshToken(req);

	if (!refreshToken) {
		return res.status(400).json({ ok: false, error: "refreshToken is required" });
	}

	try {
		const tokenClaims = verifyRefreshToken(refreshToken);

		await authenticateRefreshSession({
			userId: tokenClaims.id,
			email: tokenClaims.email,
			refreshToken,
		});

		const cancellationResult = await deleteLobbyGameByHost({
			game_id: gameId,
			acting_user_id: tokenClaims.id,
		});

		emitGameLobbyClosed({
			gameId: cancellationResult.game.game_id,
			hostUserId: cancellationResult.host_user_id,
			kickedUserIds: cancellationResult.kicked_user_ids,
			reason: "host-left",
		});

		emitLobbyGameRemoved({
			gameId: cancellationResult.game.game_id,
			hostUserId: cancellationResult.host_user_id,
			reason: "host-left",
		});

		return res.status(200).json({ ok: true });
	} catch (error) {
		if (error?.code === "GAME_NOT_FOUND" || error?.code === "GAME_ALREADY_FINISHED") {
			return res.status(200).json({ ok: true });
		}

		console.error("Error canceling lobby game via leave beacon:", error);
		const { status, error: message } = getLeaveBeaconErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function heartbeatLobbyPresenceForGame(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		await ensureUserCanAccessGame(gameId, actingUserId);
		const presence = heartbeatLobbyPresence({ game_id: gameId, user_id: actingUserId });
		return res.status(200).json({ ok: true, presence });
	} catch (error) {
		const { status, error: message } = getUpdateGameStatusErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function leaveLobbyPresenceForGame(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	const presence = removeLobbyPresence({ game_id: gameId, user_id: actingUserId });
	return res.status(200).json({ ok: true, presence });
}

export async function getGameById(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		await ensureUserCanAccessGame(gameId, actingUserId);
		// Use the live realtime snapshot so remaining_seconds and clock_last_synced_at
		// reflect the Redis live clock, not stale DB values that lag behind socket moves.
		const snapshot = await getGameRealtimeSnapshot(gameId);
		const game = { ...snapshot.game, teams: snapshot.teams };
		return res.status(200).json({ ok: true, game });
	} catch (error) {
		console.error("Error fetching game by id:", error);
		const { status, error: message } = getUpdateGameStatusErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function updateLobbyTeamName(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const teamId = typeof req.params?.teamId === "string" ? req.params.teamId.trim() : "";
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";
	const teamName =
		typeof req.body?.team_name === "string"
			? req.body.team_name.trim()
			: String(req.body?.team_name ?? "").trim();

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const { team } = await updateLobbyTeamNameByHost({
			game_id: gameId,
			team_id: teamId,
			team_name: teamName,
			acting_user_id: actingUserId,
		});

		const game = await getGameByIdWithTeams(gameId);

		emitLobbyGameUpdated({ game });

		return res.status(200).json({
			ok: true,
			team,
			game,
			message: "Team name updated",
		});
	} catch (error) {
		console.error("Error updating lobby team name:", error);
		const { status, error: message } = getUpdateTeamNameErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function updateLobbyGameName(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";
	const gameName =
		typeof req.body?.game_name === "string"
			? req.body.game_name.trim()
			: String(req.body?.game_name ?? "").trim();

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		await updateLobbyGameNameByHost({
			game_id: gameId,
			game_name: gameName,
			acting_user_id: actingUserId,
		});

		const game = await getGameByIdWithTeams(gameId);

		emitLobbyGameUpdated({ game });

		return res.status(200).json({
			ok: true,
			game,
			message: "Game name updated",
		});
	} catch (error) {
		console.error("Error updating lobby game name:", error);
		const { status, error: message } = getUpdateGameNameErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function updateLobbyGameSettings(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";
	const settingsPayload = req.body && typeof req.body === "object" ? req.body : {};
	console.log("[settings-update] gameId:", gameId, "body:", settingsPayload);

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		await updateLobbyGameSettingsByHost({
			game_id: gameId,
			acting_user_id: actingUserId,
			settings: settingsPayload,
		});

		const game = await getGameByIdWithTeams(gameId);

		emitLobbyGameUpdated({ game });

		return res.status(200).json({
			ok: true,
			game,
			message: "Game settings updated",
		});
	} catch (error) {
		console.error("Error updating lobby game settings:", error);
		const { status, error: message } = getUpdateGameSettingsErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function getInvitedGame(req, res) {
	const inviteToken = typeof req.params?.inviteToken === "string" ? req.params.inviteToken.trim() : "";
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const game = await getGameByInviteToken(inviteToken);
		await grantLobbyAccessFromInviteToken(game, actingUserId);
		return res.status(200).json({ ok: true, game });
	} catch (error) {
		console.error("Error fetching invited game:", error);
		const { status, error: message } = getInviteGameErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function getGameInviteLink(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const actingUserId = req.auth?.id;

	try {
		await ensureUserCanAccessGame(gameId, actingUserId);

		const inviteToken = await getGameInviteTokenByGameId(gameId);
		const invite = buildInviteLinkPayload(inviteToken, req);

		return res.status(200).json({ ok: true, invite });
	} catch (error) {
		console.error("Error fetching game invite link:", error);
		const { status, error: message } = getGameInviteLinkErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function setGameFinished(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const actingUserId = req.auth?.id;

	try {
		await ensureUserCanAccessGame(gameId, actingUserId);

		const game = await markGameFinished(gameId);

		emitGameStatusUpdated({
			gameId: game.game_id,
			game,
		});

		emitLobbyGameUpdated({ game });

		return res.status(200).json({ ok: true, game });
	} catch (error) {
		console.error("Error updating game status to finished:", error);
		const { status, error: message } = getUpdateGameStatusErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function getMyActiveGame(req, res) {
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const activeGames = await findActiveGamesForUser(actingUserId);

		if (activeGames.length === 0) {
			return res.status(200).json({ ok: true, active_game: null });
		}

		const resolvedGames = [];

		for (const activeGame of activeGames) {
			try {
				const game = await getGameByIdWithTeams(activeGame.game_id);
				const normalizedStatus = typeof game?.status === "string" ? game.status.trim().toLowerCase() : "";

				if (normalizedStatus === "finished") {
					continue;
				}

				resolvedGames.push(game);
			} catch {
				continue;
			}
		}

		if (resolvedGames.length === 0) {
			return res.status(200).json({ ok: true, active_game: null });
		}

		resolvedGames.sort((a, b) => {
			const statusA = typeof a?.status === "string" ? a.status.trim().toLowerCase() : "";
			const statusB = typeof b?.status === "string" ? b.status.trim().toLowerCase() : "";
			const rankA = statusA === "started" ? 2 : statusA === "in_progress" ? 1 : 0;
			const rankB = statusB === "started" ? 2 : statusB === "in_progress" ? 1 : 0;

			if (rankA !== rankB) {
				return rankB - rankA;
			}

			return Number(b.game_id ?? 0) - Number(a.game_id ?? 0);
		});

		const activeGame = resolvedGames[0];
		const normalizedStatus = typeof activeGame?.status === "string" ? activeGame.status.trim().toLowerCase() : "";
		const route = normalizedStatus === "started"
			? `/game/${encodeURIComponent(String(activeGame.game_id))}`
			: `/create?gameId=${encodeURIComponent(String(activeGame.game_id))}`;

		return res.status(200).json({
			ok: true,
			active_game: {
				game_id: activeGame.game_id,
				status: activeGame.status,
				game_name: activeGame.game_name,
				route,
			},
		});
	} catch (error) {
		console.error("Error fetching active game for user:", error);
		return res.status(500).json({ ok: false, error: "Internal server error" });
	}
}


export async function getPublicGames(req, res) {
	try {
		const games = await getPublicLobbyGames();
		return res.status(200).json({ ok: true, games });
	} catch (error) {
		console.error("Error fetching public games:", error);
		return res.status(500).json({ ok: false, error: "Internal server error" });
	}
}

export async function getGameStatsHandler(req, res) {
	try {
		const stats = await getGameStats();
		return res.status(200).json({ ok: true, ...stats });
	} catch (error) {
		console.error("Error fetching game stats:", error);
		return res.status(500).json({ ok: false, error: "Internal server error" });
	}
}

export async function populateRematch(req, res) {
	const newGameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const sourceGameId = typeof req.body?.source_game_id !== "undefined" ? String(req.body.source_game_id) : "";
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	if (!sourceGameId) {
		return res.status(400).json({ ok: false, error: "source_game_id is required" });
	}

	try {
		await assignRematchPlayers(newGameId, sourceGameId);
		const game = await getGameByIdWithTeams(newGameId);
		emitLobbyGameUpdated({ game });
		return res.status(200).json({ ok: true, game });
	} catch (error) {
		console.error("Error populating rematch:", error);
		return res.status(500).json({ ok: false, error: "Internal server error" });
	}
}

export async function getSpectatorGamesHandler(req, res) {
	try {
		const games = await getSpectatorGames();
		return res.status(200).json({ ok: true, games });
	} catch (error) {
		console.error("Error fetching spectator games:", error);
		return res.status(500).json({ ok: false, error: "Internal server error" });
	}
}
