import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import pool from "./config/db.js";
import authRoutes from "./routes/authRoutes.js";
import gameRoutes from "./routes/gameRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import teamMemberRoutes from "./routes/teamMemberRoutes.js";
import moveRoutes from "./routes/moveRoutes.js";
import playerReserveRoutes from "./routes/playerReserveRoutes.js";
import inboxRoutes from "./routes/inboxRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import { startLobbyInactivityCleanup, stopLobbyInactivityCleanup } from "./controllers/gameController.js";
import { getGameRoomName, getInboxRoomName, getLobbyRoomName, getNormalizedGameId, registerSocketIo } from "./realtime/gameSocketHub.js";
import { getGameRealtimeSnapshot, getLobbyRealtimeSnapshot } from "./realtime/gameRealtimeSnapshot.js";
import { verifyAccessToken } from "./security/tokenService.js";
import { startLiveMovePersistenceWorker, submitLiveSocketMove, warmLiveGameState } from "./services/game/liveMovePipelineService.js";
import { startBughouseMateChecker, stopBughouseMateChecker } from "./services/game/bughouseMateCheckerService.js";
import { emitGameMoveCreated, emitGameReserveUpdated, emitGameStatusUpdated } from "./realtime/gameSocketHub.js";

function extractBearerToken(authorizationHeader) {
	if (typeof authorizationHeader !== "string") {
		return "";
	}

	const trimmedHeader = authorizationHeader.trim();
	if (!trimmedHeader.toLowerCase().startsWith("bearer ")) {
		return "";
	}

	return trimmedHeader.slice(7).trim();
}

function resolveSocketAccessToken(socket) {
	const authToken =
		typeof socket.handshake?.auth?.accessToken === "string"
			? socket.handshake.auth.accessToken.trim()
			: "";

	if (authToken) {
		return authToken;
	}

	const legacyAuthToken =
		typeof socket.handshake?.auth?.token === "string"
			? socket.handshake.auth.token.trim()
			: "";

	if (legacyAuthToken) {
		return legacyAuthToken;
	}

	return extractBearerToken(socket.handshake?.headers?.authorization);
}

function normalizeUserId(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim().toLowerCase();
}

const GAME_STATUS_FIELDS =
	"game_id, status, result, finished_at, winner_team_id, finish_reason, move_count, clock_last_synced_at, active_board1_team_member_id, active_board2_team_member_id";

async function getGameStatusSnapshot(gameId) {
	const normalizedGameId = getNormalizedGameId(gameId);
	if (!normalizedGameId) {
		return null;
	}

	const result = await pool.query(
		`SELECT ${GAME_STATUS_FIELDS}
		 FROM gameplay.games
		 WHERE game_id = $1
		 LIMIT 1`,
		[normalizedGameId]
	);

	return result.rows[0] ?? null;
}

async function ensureSocketUserCanAccessGame(socket, gameId) {
	const normalizedSocketUserId = normalizeUserId(socket.auth?.id);

	if (!normalizedSocketUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const accessResult = await pool.query(
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
		[gameId, normalizedSocketUserId]
	);

	if (accessResult.rowCount === 0) {
		const error = new Error("You do not have access to this game");
		error.code = "GAME_ACCESS_DENIED";
		throw error;
	}
}

function getSocketErrorPayload(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return {
			ok: false,
			code: error.code,
			error: error.message,
		};
	}

	if (error?.code === "GAME_ACCESS_DENIED") {
		return {
			ok: false,
			code: error.code,
			error: error.message,
		};
	}

	if (error?.code === "INVALID_GAME_ID") {
		return {
			ok: false,
			code: error.code,
			error: error.message,
		};
	}

	if (error?.code === "GAME_NOT_FOUND") {
		return {
			ok: false,
			code: error.code,
			error: error.message,
		};
	}

	return {
		ok: false,
		code: "SOCKET_INTERNAL_ERROR",
		error: "Internal server error",
	};
}

pool.query("SELECT 1", (err, result) => {
	if (err) {
		console.error("Database connection failed:", err);
	} else {
		console.log("Connected to Neon database successfully");
	}
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(authRoutes);
app.use(gameRoutes);
app.use(chatRoutes);
app.use(teamMemberRoutes);
app.use(moveRoutes);
app.use(playerReserveRoutes);
app.use(inboxRoutes);
app.use(reportRoutes);
startLobbyInactivityCleanup();

const server = http.createServer(app);
const io = new Server(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
	},
});

io.use((socket, next) => {
	const accessToken = resolveSocketAccessToken(socket);

	if (!accessToken) {
		const error = new Error("Authentication required");
		error.data = {
			code: "MISSING_ACCESS_TOKEN",
			error: "Socket access token is required",
		};
		next(error);
		return;
	}

	try {
		const claims = verifyAccessToken(accessToken);
		socket.auth = {
			id: claims.id,
			email: claims.email,
			roles: claims.roles,
			expiresAt: claims.expiresAt,
		};
		next();
	} catch (error) {
		if (
			error?.code === "MISSING_ACCESS_TOKEN" ||
			error?.code === "INVALID_ACCESS_TOKEN"
		) {
			const authError = new Error("Invalid or expired access token");
			authError.data = {
				code: "INVALID_ACCESS_TOKEN",
				error: "Invalid or expired access token",
			};
			next(authError);
			return;
		}

		if (error?.code === "AUTH_CONFIGURATION_ERROR") {
			const authError = new Error("Authentication is not configured");
			authError.data = {
				code: "AUTH_CONFIGURATION_ERROR",
				error: "Authentication is not configured",
			};
			next(authError);
			return;
		}

		const authError = new Error("Internal server error");
		authError.data = {
			code: "SOCKET_INTERNAL_ERROR",
			error: "Internal server error",
		};
		next(authError);
	}
});

registerSocketIo(io);
startLiveMovePersistenceWorker();
startBughouseMateChecker();

io.on("connection", (socket) => {
	console.log("client connected", socket.id);

	const inboxRoomName = getInboxRoomName(socket.auth?.id);
	if (inboxRoomName) {
		socket.join(inboxRoomName);
	}

	socket.on("lobby:join", async (_payload, acknowledge) => {
		const roomName = getLobbyRoomName();

		try {
			const snapshot = await getLobbyRealtimeSnapshot();
			socket.join(roomName);

			const joinedPayload = {
				ok: true,
				room: roomName,
				snapshot,
			};

			socket.emit("lobby:joined", joinedPayload);
			socket.emit("lobby:snapshot", {
				...snapshot,
				occurred_at: new Date().toISOString(),
			});

			if (typeof acknowledge === "function") {
				acknowledge(joinedPayload);
			}
		} catch (error) {
			const errorPayload = getSocketErrorPayload(error);
			socket.emit("lobby:error", errorPayload);
			if (typeof acknowledge === "function") {
				acknowledge(errorPayload);
			}
		}
	});

	socket.on("lobby:leave", (_payload, acknowledge) => {
		const roomName = getLobbyRoomName();
		socket.leave(roomName);

		const leftPayload = {
			ok: true,
			room: roomName,
		};

		socket.emit("lobby:left", leftPayload);
		if (typeof acknowledge === "function") {
			acknowledge(leftPayload);
		}
	});

	socket.on("lobby:sync", async (_payload, acknowledge) => {
		try {
			const snapshot = await getLobbyRealtimeSnapshot();
			const snapshotPayload = {
				ok: true,
				snapshot,
			};

			socket.emit("lobby:snapshot", {
				...snapshot,
				occurred_at: new Date().toISOString(),
			});

			if (typeof acknowledge === "function") {
				acknowledge(snapshotPayload);
			}
		} catch (error) {
			const errorPayload = getSocketErrorPayload(error);
			socket.emit("lobby:error", errorPayload);
			if (typeof acknowledge === "function") {
				acknowledge(errorPayload);
			}
		}
	});

	socket.on("game:join", async (payload, acknowledge) => {
		const normalizedGameId = getNormalizedGameId(payload?.gameId);

		if (normalizedGameId === null) {
			const errorPayload = {
				ok: false,
				code: "INVALID_GAME_ID",
				error: "gameId must be a valid positive integer",
			};

			socket.emit("game:error", errorPayload);
			if (typeof acknowledge === "function") {
				acknowledge(errorPayload);
			}
			return;
		}

		try {
			await ensureSocketUserCanAccessGame(socket, normalizedGameId);
			await warmLiveGameState(normalizedGameId);

			const snapshot = await getGameRealtimeSnapshot(normalizedGameId);
			const roomName = getGameRoomName(normalizedGameId);
			socket.join(roomName);

			const joinedPayload = {
				ok: true,
				game_id: normalizedGameId,
				room: roomName,
				snapshot,
			};

			socket.emit("game:joined", joinedPayload);
			socket.emit("game:snapshot", {
				...snapshot,
				game_id: normalizedGameId,
				occurred_at: new Date().toISOString(),
			});

			if (typeof acknowledge === "function") {
				acknowledge(joinedPayload);
			}
		} catch (error) {
			const errorPayload = getSocketErrorPayload(error);
			socket.emit("game:error", errorPayload);
			if (typeof acknowledge === "function") {
				acknowledge(errorPayload);
			}
		}
	});

	socket.on("game:move", async (payload, acknowledge) => {
		const teamMemberId = payload?.team_member_id;
		const moveUci = typeof payload?.move_uci === "string" ? payload.move_uci.trim() : "";
		const capturedPiece = typeof payload?.captured_piece === "string" ? payload.captured_piece.trim() : "";

		if (!teamMemberId) {
			const errorPayload = {
				ok: false,
				code: "INVALID_TEAM_MEMBER_ID",
				error: "team_member_id is required",
			};

			if (typeof acknowledge === "function") {
				acknowledge(errorPayload);
			}
			return;
		}

		if (!moveUci) {
			const errorPayload = {
				ok: false,
				code: "MOVE_UCI_REQUIRED",
				error: "move_uci is required",
			};

			if (typeof acknowledge === "function") {
				acknowledge(errorPayload);
			}
			return;
		}

		try {
			const result = await submitLiveSocketMove({
				team_member_id: teamMemberId,
				move_uci: moveUci,
				captured_piece: capturedPiece,
				acting_user_id: socket.auth?.id,
			});

			emitGameMoveCreated({
				gameId: result.move.game_id,
				move: {
					...result.move,
					game_patch: result.gamePatch,
				},
			});

			const reserveUpdates = Array.isArray(result.move.reserve_updates)
				? result.move.reserve_updates
				: [];

			for (const reserveUpdate of reserveUpdates) {
				if (reserveUpdate?.piece_type === "_clock_increment") {
					continue;
				}

				emitGameReserveUpdated({
					gameId: result.move.game_id,
					reserveUpdate,
				});
			}

			if (result.move?.game && String(result.move.game.status ?? "").toLowerCase() === "finished") {
				emitGameStatusUpdated({
					gameId: result.move.game_id,
					game: result.move.game,
				});
			} else {
				const moveGameId = Number(result.move?.game_id);
				if (Number.isInteger(moveGameId) && moveGameId > 0) {
					void (async () => {
						try {
							const snapshot = await getGameStatusSnapshot(moveGameId);
							const status = String(snapshot?.status ?? "").toLowerCase();
							if (status === "finished") {
								emitGameStatusUpdated({
									gameId: moveGameId,
									game: snapshot,
								});
							}
						} catch {
							// Ignore snapshot errors; the client can still recover via manual sync.
						}
					})();
				}
			}

			if (typeof acknowledge === "function") {
				acknowledge({
					ok: true,
					move: result.move,
					game_patch: result.gamePatch,
				});
			}
		} catch (error) {
			if (error?.code === "GAME_TIMEOUT" && error?.game) {
				emitGameStatusUpdated({
					gameId: error.game.game_id,
					game: error.game,
				});
			}

			const errorPayload = {
				ok: false,
				code: typeof error?.code === "string" ? error.code : "SOCKET_MOVE_FAILED",
				error: typeof error?.message === "string" && error.message ? error.message : "Move failed",
			};

			if (typeof acknowledge === "function") {
				acknowledge(errorPayload);
			}
		}
	});

	socket.on("game:leave", (payload, acknowledge) => {
		const normalizedGameId = getNormalizedGameId(payload?.gameId);

		if (normalizedGameId === null) {
			const errorPayload = {
				ok: false,
				code: "INVALID_GAME_ID",
				error: "gameId must be a valid positive integer",
			};

			socket.emit("game:error", errorPayload);
			if (typeof acknowledge === "function") {
				acknowledge(errorPayload);
			}
			return;
		}

		const roomName = getGameRoomName(normalizedGameId);
		socket.leave(roomName);

		const leftPayload = {
			ok: true,
			game_id: normalizedGameId,
			room: roomName,
		};

		socket.emit("game:left", leftPayload);
		if (typeof acknowledge === "function") {
			acknowledge(leftPayload);
		}
	});

	socket.on("game:sync", async (payload, acknowledge) => {
		const normalizedGameId = getNormalizedGameId(payload?.gameId);

		if (normalizedGameId === null) {
			const errorPayload = {
				ok: false,
				code: "INVALID_GAME_ID",
				error: "gameId must be a valid positive integer",
			};

			socket.emit("game:error", errorPayload);
			if (typeof acknowledge === "function") {
				acknowledge(errorPayload);
			}
			return;
		}

		try {
			await ensureSocketUserCanAccessGame(socket, normalizedGameId);

			const snapshot = await getGameRealtimeSnapshot(normalizedGameId);
			const snapshotPayload = {
				ok: true,
				game_id: normalizedGameId,
				snapshot,
			};

			socket.emit("game:snapshot", {
				...snapshot,
				game_id: normalizedGameId,
				occurred_at: new Date().toISOString(),
			});

			if (typeof acknowledge === "function") {
				acknowledge(snapshotPayload);
			}
		} catch (error) {
			const errorPayload = getSocketErrorPayload(error);
			socket.emit("game:error", errorPayload);
			if (typeof acknowledge === "function") {
				acknowledge(errorPayload);
			}
		}
	});

	socket.on("ping", (payload) => {
		socket.emit("pong", { echo: payload ?? null });
	});

	socket.on("disconnect", (reason) => {
		console.log("client disconnected", socket.id, reason);
	});
});

const BASE_PORT = Number(process.env.PORT) || 3001;
let currentPort = BASE_PORT;

function startServer(port) {
	currentPort = port;
	server.listen(port);
}

server.on("listening", () => {
	console.log(`Server listening on http://localhost:${currentPort}`);
});

startServer(BASE_PORT);

process.on("SIGINT", async () => {
	console.log("Closing database pool...");
	stopLobbyInactivityCleanup();
	stopBughouseMateChecker();
	await pool.end();
	process.exit(0);
});
