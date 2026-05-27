import { claimGameTimeout, createBotMove, createMove, listMovesByGameId } from "../models/moveModel.js";
import { emitGameMoveCreated, emitGameReserveUpdated, emitGameStatusUpdated } from "../realtime/gameSocketHub.js";
import { invalidateLiveGameCache } from "../services/game/liveMovePipelineService.js";

function emitRealtimeGameUpdates(movePayload) {
	const gameId = Number(movePayload?.game_id);

	if (!Number.isInteger(gameId) || gameId <= 0) {
		return;
	}

	emitGameMoveCreated({
		gameId,
		move: movePayload,
	});

	const reserveUpdates = Array.isArray(movePayload?.reserve_updates) ? movePayload.reserve_updates : [];

	for (const reserveUpdate of reserveUpdates) {
		emitGameReserveUpdated({
			gameId,
			reserveUpdate,
		});
	}

	if (movePayload?.game && String(movePayload.game.status ?? "").toLowerCase() === "finished") {
		emitGameStatusUpdated({
			gameId,
			game: movePayload.game,
		});
	}
}

function getCreateMoveErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (
		error?.code === "TEAM_MEMBER_ACCESS_DENIED" ||
		error?.code === "BOT_CONTROL_ACCESS_DENIED" ||
		error?.code === "GAME_ACCESS_DENIED"
	) {
		return { status: 403, error: error.message };
	}

	if (
		error?.code === "INVALID_TEAM_MEMBER_ID" ||
		error?.code === "MOVE_UCI_REQUIRED" ||
		error?.code === "INVALID_MOVE_UCI" ||
		error?.code === "CAPTURED_PIECE_TOO_LONG" ||
		error?.code === "CAPTURED_PIECE_MISMATCH" ||
		error?.code === "ILLEGAL_MOVE" ||
		error?.code === "TEAM_MEMBER_NOT_BOT" ||
		error?.code === "INVALID_DROP_SQUARE_FOR_PAWN"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_NOT_JOINED") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "HISTORICAL_MOVE_INVALID") {
		return { status: 409, error: error.message };
	}

	if (
		error?.code === "TURN_MISMATCH" ||
		error?.code === "INVALID_TEAM_MEMBER_PIECE_COLOR" ||
		error?.code === "CONSECUTIVE_TEAM_MEMBER_MOVE" ||
		error?.code === "GAME_ALREADY_FINISHED" ||
		error?.code === "GAME_NOT_STARTED" ||
		error?.code === "NO_LEGAL_BOT_MOVE" ||
		error?.code === "DROP_SQUARE_OCCUPIED" ||
		error?.code === "RESERVE_PIECE_NOT_AVAILABLE" ||
		error?.code === "RESERVE_DECREMENT_CONFLICT"
	) {
		return { status: 409, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getListMovesErrorResponse(error) {
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

export async function postMove(req, res) {
	const startedAt = Date.now();
	const teamMemberId = req.body?.team_member_id;
	const actingUserId = req.auth?.id;
	const moveUci = typeof req.body?.move_uci === "string" ? req.body.move_uci.trim() : String(req.body?.move_uci ?? "").trim();
	const capturedPiece = typeof req.body?.captured_piece === "string"
		? req.body.captured_piece.trim()
		: String(req.body?.captured_piece ?? "").trim();

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	if (!teamMemberId) {
		return res.status(400).json({ ok: false, error: "team_member_id is required" });
	}

	if (!moveUci) {
		return res.status(400).json({ ok: false, error: "move_uci is required" });
	}

	try {
		const move = await createMove({
			team_member_id: teamMemberId,
			move_uci: moveUci,
			captured_piece: capturedPiece,
			acting_user_id: actingUserId,
		});

		if (move?.timeout === true) {
			const gameId = Number(move.game_id);
			if (Number.isInteger(gameId) && gameId > 0 && move.game) {
				emitGameStatusUpdated({ gameId, game: move.game });
			}
			void invalidateLiveGameCache(move.game_id);
			return res.status(200).json({ ok: true, move });
		}

		emitRealtimeGameUpdates(move);
		void invalidateLiveGameCache(move.game_id);
		console.log("[post-move]", {
			moveUci,
			teamMemberId,
			totalMs: Date.now() - startedAt,
		});

		return res.status(201).json({ ok: true, move });
	} catch (error) {
		console.error("Error creating move:", error);
		console.log("[post-move]", {
			moveUci,
			teamMemberId,
			totalMs: Date.now() - startedAt,
			failed: true,
			errorCode: error?.code ?? null,
		});
		const { status, error: msg } = getCreateMoveErrorResponse(error);
		return res.status(status).json({ ok: false, error: msg });
	}
}

export async function postBotMove(req, res) {
	const teamMemberId = req.body?.team_member_id;
	const actingUserId = req.auth?.id;

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	if (!teamMemberId) {
		return res.status(400).json({ ok: false, error: "team_member_id is required" });
	}

	try {
		const bot_move = await createBotMove({
			team_member_id: teamMemberId,
			acting_user_id: actingUserId,
		});

		if (bot_move?.waiting_for_reserve === true) {
			return res.status(200).json({ ok: true, bot_move });
		}

		// Bot was in checkmate — game ended without a normal move being played.
		// Emit only the status update; skip emitGameMoveCreated since there is no move.
		if (bot_move?.game && String(bot_move.game.status ?? "").toLowerCase() === "finished") {
			const gameId = Number(bot_move.game_id);
			if (Number.isInteger(gameId) && gameId > 0) {
				emitGameStatusUpdated({ gameId, game: bot_move.game });
			}
			void invalidateLiveGameCache(bot_move.game_id);
			return res.status(200).json({ ok: true, bot_move });
		}

		emitRealtimeGameUpdates(bot_move);
		void invalidateLiveGameCache(bot_move.game_id);

		return res.status(201).json({ ok: true, bot_move });
	} catch (error) {
		console.error("Error creating bot move:", error);

		if (error?.code === "TURN_MISMATCH") {
			return res.status(200).json({
				ok: false,
				code: error.code,
				error: error.message,
			});
		}

		const { status, error: msg } = getCreateMoveErrorResponse(error);
		return res.status(status).json({
			ok: false,
			code: error?.code ?? null,
			error: msg,
		});
	}
}

export async function getGameMoves(req, res) {
	const gameId = req.params?.gameId;
	const actingUserId = req.auth?.id;

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const moves = await listMovesByGameId(gameId, actingUserId);
		return res.status(200).json({ ok: true, moves });
	} catch (error) {
		console.error("Error fetching game moves:", error);
		const { status, error: msg } = getListMovesErrorResponse(error);
		return res.status(status).json({ ok: false, error: msg });
	}
}

export async function postGameTimeout(req, res) {
	const gameId = req.params?.gameId;
	const actingUserId = req.auth?.id;

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const result = await claimGameTimeout(gameId, actingUserId);
		if (result.timed_out) {
			emitGameStatusUpdated({ gameId: Number(result.game?.game_id), game: result.game });
			void invalidateLiveGameCache(result.game?.game_id);
		}
		return res.status(200).json({ ok: true, timed_out: result.timed_out, game: result.game });
	} catch (error) {
		console.error("Error claiming game timeout:", error);
		if (error?.code === "AUTH_USER_REQUIRED") {
			return res.status(401).json({ ok: false, error: error.message });
		}
		if (error?.code === "GAME_ACCESS_DENIED") {
			return res.status(403).json({ ok: false, error: error.message });
		}
		if (error?.code === "INVALID_GAME_ID") {
			return res.status(400).json({ ok: false, error: error.message });
		}
		if (error?.code === "GAME_NOT_FOUND") {
			return res.status(404).json({ ok: false, error: error.message });
		}
		return res.status(500).json({ ok: false, error: "Internal server error" });
	}
}
