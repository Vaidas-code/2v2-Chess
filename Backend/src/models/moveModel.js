import pool from "../config/db.js";
import { Chess } from "chess.js";
import { calculateBestBotMoveOnDefaultBoard } from "../services/chess/botMoveAlgorithmService.js";
import { validateMoveOnDefaultBoard, validateMoveOnFenBoard } from "../services/chess/moveValidationService.js";
import { addCapturedPieceToTeammateReserve } from "./playerReserveModel.js";
import { applyRatingForFinishedGame } from "../services/game/ratingService.js";

const MOVE_SELECT_FIELDS = "move_id, team_member_id, move_number, move_uci, captured_piece, fen_after_move";
const GAME_SELECT_FIELDS =
	"game_id, status, result, started_at, finished_at, time_control, increment, created_by, move_count, user_id, invite_token, game_name, rated_game, allow_spectators, public_game, draw_offer_count, winner_team_id, finish_reason, clock_last_synced_at, active_board1_team_member_id, active_board2_team_member_id";
const MOVE_UCI_PATTERN = /^[a-h][1-8][a-h][1-8]([qrbn])?$/i;
const MOVE_DROP_UCI_PATTERN = /^@([pnbrq])([a-h][1-8])$/i;
const BUGHOUSE_DROP_PIECE_TYPES = ["p", "n", "b", "r", "q"];
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const SHOULD_LOG_MOVE_TIMING = process.env.DEBUG_MOVE_TIMING !== "0";

function normalizeId(value) {
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

function normalizeText(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim();
}

function normalizeUserId(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim().toLowerCase();
}

function normalizeTeamId(teamId) {
	if (typeof teamId === "number" && Number.isInteger(teamId) && teamId > 0) {
		return teamId;
	}

	if (typeof teamId !== "string") {
		return null;
	}

	const normalizedValue = teamId.trim();
	if (!normalizedValue) {
		return null;
	}

	const parsedId = Number(normalizedValue);
	return Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
}

function parseInitialSecondsFromTimeControl(value) {
	const numericValue = Number(String(value ?? "").trim());

	if (!Number.isFinite(numericValue) || numericValue <= 0) {
		return 300;
	}

	return Math.max(1, Math.round(numericValue * 60));
}

async function _synchronizeGameClockWithinTransaction(gameId, game, queryExecutor) {
	const normalizedGameId = normalizeId(gameId);
	let updatedGame = game;
	const initialSeconds = parseInitialSecondsFromTimeControl(updatedGame.time_control);
	const clockLastSyncedAt = updatedGame.clock_last_synced_at ? new Date(updatedGame.clock_last_synced_at) : null;
	const now = new Date();

	const elapsedSeconds = (!clockLastSyncedAt || Number.isNaN(clockLastSyncedAt.getTime()))
		? 0
		: Math.max(0, Math.floor((now.getTime() - clockLastSyncedAt.getTime()) / 1000));

	const activeMemberIds = Array.from(new Set([
		normalizeTeamId(updatedGame.active_board1_team_member_id),
		normalizeTeamId(updatedGame.active_board2_team_member_id),
	].filter(Boolean)));

	let timedOutMemberId = null;

	if (elapsedSeconds > 0 && activeMemberIds.length > 0) {
		await queryExecutor.query(
			`UPDATE gameplay.team_members
			 SET remaining_seconds = GREATEST(0, COALESCE(remaining_seconds, $1) - $2)
			 WHERE team_member_id = ANY($3::int[])`,
			[initialSeconds, elapsedSeconds, activeMemberIds]
		);

		const timeoutCheckResult = await queryExecutor.query(
			`SELECT team_member_id
			 FROM gameplay.team_members
			 WHERE team_member_id = ANY($1::int[]) AND COALESCE(remaining_seconds, $2) <= 0`,
			[activeMemberIds, initialSeconds]
		);
		if (timeoutCheckResult.rowCount > 0) {
			timedOutMemberId = normalizeId(timeoutCheckResult.rows[0].team_member_id);
		}
	}

	const syncedGameResult = await queryExecutor.query(
		`UPDATE gameplay.games
		 SET clock_last_synced_at = $2
		 WHERE game_id = $1
		 RETURNING ${GAME_SELECT_FIELDS}`,
		[normalizedGameId, now]
	);

	updatedGame = syncedGameResult.rows[0] ?? updatedGame;

	return { game: updatedGame, timedOutMemberId };
}

async function ensureGameExists(gameId, queryExecutor = pool) {
	const gameResult = await queryExecutor.query(
		"SELECT game_id FROM gameplay.games WHERE game_id = $1 LIMIT 1",
		[gameId]
	);

	if (gameResult.rowCount === 0) {
		const error = new Error("Game not found");
		error.code = "GAME_NOT_FOUND";
		throw error;
	}
}

async function getTeamMemberContext(teamMemberId, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT
			tm.team_member_id,
			tm.team_id,
			tm.user_id,
			tm.is_bot,
			tm.board_number,
			tm.piece_color,
			tm.joined_at,
			t.game_id,
			t.team_name
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE tm.team_member_id = $1
		 LIMIT 1`,
		[teamMemberId]
	);

	if (result.rowCount === 0) {
		const error = new Error("Team member not found");
		error.code = "TEAM_MEMBER_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}

function getIncrementSeconds(value) {
	const numericValue = Number(String(value ?? "").trim());

	if (!Number.isFinite(numericValue) || numericValue < 0) {
		return 0;
	}

	return Math.max(0, Math.round(numericValue));
}

async function getUserIdByTeamMemberId(teamMemberId, queryExecutor = pool) {
	const normalizedTeamMemberId = normalizeId(teamMemberId);
	if (!normalizedTeamMemberId) return null;

	const result = await queryExecutor.query(
		"SELECT user_id FROM gameplay.team_members WHERE team_member_id = $1 LIMIT 1",
		[normalizedTeamMemberId]
	);

	const userId = result.rows[0]?.user_id ?? null;
	return userId ? String(userId) : null;
}

function toSquareCoordinates(square) {
	if (typeof square !== "string" || square.length !== 2) {
		return null;
	}

	const fileIndex = square.charCodeAt(0) - 97;
	const rank = Number(square[1]);

	if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 7) {
		return null;
	}

	if (!Number.isInteger(rank) || rank < 1 || rank > 8) {
		return null;
	}

	return { fileIndex, rank };
}

function findKingSquare(chess, color) {
	const board = chess.board();

	for (let rowIndex = 0; rowIndex < 8; rowIndex += 1) {
		const rank = 8 - rowIndex;

		for (let columnIndex = 0; columnIndex < 8; columnIndex += 1) {
			const piece = board[rowIndex][columnIndex];

			if (!piece || piece.type !== "k" || piece.color !== color) {
				continue;
			}

			return `${FILES[columnIndex]}${rank}`;
		}
	}

	return null;
}

function isPathClear(board, fromFileIndex, fromRank, toFileIndex, toRank, stepFile, stepRank) {
	let currentFileIndex = fromFileIndex + stepFile;
	let currentRank = fromRank + stepRank;

	while (currentFileIndex !== toFileIndex || currentRank !== toRank) {
		const rowIndex = 8 - currentRank;

		if (board[rowIndex][currentFileIndex] !== null) {
			return false;
		}

		currentFileIndex += stepFile;
		currentRank += stepRank;
	}

	return true;
}

function getCheckingAttackers(chess) {
	const board = chess.board();
	const defendingColor = chess.turn();
	const attackerColor = defendingColor === "w" ? "b" : "w";
	const kingSquare = findKingSquare(chess, defendingColor);

	if (!kingSquare) {
		return [];
	}

	const kingCoordinates = toSquareCoordinates(kingSquare);

	if (!kingCoordinates) {
		return [];
	}

	const { fileIndex: kingFileIndex, rank: kingRank } = kingCoordinates;
	const attackers = [];

	for (let rowIndex = 0; rowIndex < 8; rowIndex += 1) {
		const pieceRank = 8 - rowIndex;

		for (let columnIndex = 0; columnIndex < 8; columnIndex += 1) {
			const piece = board[rowIndex][columnIndex];

			if (!piece || piece.color !== attackerColor) {
				continue;
			}

			const fileDiff = kingFileIndex - columnIndex;
			const rankDiff = kingRank - pieceRank;
			const absFileDiff = Math.abs(fileDiff);
			const absRankDiff = Math.abs(rankDiff);
			const stepFile = fileDiff === 0 ? 0 : fileDiff / absFileDiff;
			const stepRank = rankDiff === 0 ? 0 : rankDiff / absRankDiff;

			if (piece.type === "p") {
				const expectedRankDiff = attackerColor === "w" ? 1 : -1;

				if (absFileDiff === 1 && rankDiff === expectedRankDiff) {
					attackers.push({
						square: `${FILES[columnIndex]}${pieceRank}`,
						type: piece.type,
						distance: 1,
						isLineAttack: false,
					});
				}

				continue;
			}

			if (piece.type === "n") {
				if ((absFileDiff === 1 && absRankDiff === 2) || (absFileDiff === 2 && absRankDiff === 1)) {
					attackers.push({
						square: `${FILES[columnIndex]}${pieceRank}`,
						type: piece.type,
						distance: 1,
						isLineAttack: false,
					});
				}

				continue;
			}

			if (piece.type === "k") {
				if (Math.max(absFileDiff, absRankDiff) === 1) {
					attackers.push({
						square: `${FILES[columnIndex]}${pieceRank}`,
						type: piece.type,
						distance: 1,
						isLineAttack: false,
					});
				}

				continue;
			}

			const isRookLine = piece.type === "r" && (fileDiff === 0 || rankDiff === 0);
			const isBishopLine = piece.type === "b" && absFileDiff === absRankDiff;
			const isQueenLine = piece.type === "q" && (fileDiff === 0 || rankDiff === 0 || absFileDiff === absRankDiff);

			if (!isRookLine && !isBishopLine && !isQueenLine) {
				continue;
			}

			if (!isPathClear(board, columnIndex, pieceRank, kingFileIndex, kingRank, stepFile, stepRank)) {
				continue;
			}

			attackers.push({
				square: `${FILES[columnIndex]}${pieceRank}`,
				type: piece.type,
				distance: Math.max(absFileDiff, absRankDiff),
				isLineAttack: true,
				stepFile,
				stepRank,
			});
		}
	}

	return attackers;
}

function getSquaresBetweenAttackerAndKing(attackerSquare, kingSquare) {
	const attackerCoordinates = toSquareCoordinates(attackerSquare);
	const kingCoordinates = toSquareCoordinates(kingSquare);

	if (!attackerCoordinates || !kingCoordinates) {
		return [];
	}

	const fileDiff = kingCoordinates.fileIndex - attackerCoordinates.fileIndex;
	const rankDiff = kingCoordinates.rank - attackerCoordinates.rank;
	const absFileDiff = Math.abs(fileDiff);
	const absRankDiff = Math.abs(rankDiff);

	if (!(fileDiff === 0 || rankDiff === 0 || absFileDiff === absRankDiff)) {
		return [];
	}

	const stepFile = fileDiff === 0 ? 0 : fileDiff / absFileDiff;
	const stepRank = rankDiff === 0 ? 0 : rankDiff / absRankDiff;
    const squares = [];
	let currentFileIndex = attackerCoordinates.fileIndex + stepFile;
	let currentRank = attackerCoordinates.rank + stepRank;

	while (currentFileIndex !== kingCoordinates.fileIndex || currentRank !== kingCoordinates.rank) {
		squares.push(`${FILES[currentFileIndex]}${currentRank}`);
		currentFileIndex += stepFile;
		currentRank += stepRank;
	}

	return squares;
}

function hasAnyBughouseDefensiveDrop(chess, reservePieces = []) {
	const normalizedReservePieces = Array.isArray(reservePieces)
		? reservePieces
			.map((piece) => String(piece ?? "").trim().toLowerCase())
			.filter((piece) => BUGHOUSE_DROP_PIECE_TYPES.includes(piece))
		: [];

	if (normalizedReservePieces.length === 0) {
		return false;
	}

	const defendingColor = chess.turn();
	const kingSquare = findKingSquare(chess, defendingColor);
	if (!kingSquare) {
		return false;
	}

	const checkingAttackers = getCheckingAttackers(chess);

	if (checkingAttackers.length !== 1) {
		return false;
	}

	const checkingAttacker = checkingAttackers[0];

	if (!checkingAttacker.isLineAttack || Number(checkingAttacker.distance) <= 1) {
		return false;
	}

	const interpositionSquares = getSquaresBetweenAttackerAndKing(checkingAttacker.square, kingSquare);

	if (interpositionSquares.length === 0) {
		return false;
	}

	const board = chess.board();
	const currentTurn = chess.turn();

	for (const pieceType of normalizedReservePieces) {
		for (const square of interpositionSquares) {
			const coords = toSquareCoordinates(square);

			if (!coords) {
				continue;
			}

			const rank = coords.rank;

			if (pieceType === "p" && (rank === 1 || rank === 8)) {
				continue;
			}

			const rowIndex = 8 - rank;
			if (board[rowIndex][coords.fileIndex] !== null) {
				continue;
			}

			const chessCopy = new Chess(chess.fen());
			const dropApplied = chessCopy.put({ type: pieceType, color: currentTurn }, square);

			if (!dropApplied) {
				continue;
			}

			if (!chessCopy.isCheck()) {
				return true;
			}
		}
	}

	return false;
}

function isBughouseCheckmateFen(fenValue, reservePieces = []) {
	const fen = normalizeText(fenValue);

	if (!fen) {
		return false;
	}

	const chess = new Chess();
	const loaded = chess.load(fen);

	if (!loaded) {
		return false;
	}

	if (!chess.isCheck()) {
		return false;
	}

	if (chess.moves({ verbose: true }).length > 0) {
		return false;
	}

	if (hasAnyBughouseDefensiveDrop(chess, reservePieces)) {
		return false;
	}

	return true;
}

async function getTeamMemberIdByBoardAndPieceColor({ gameId, boardNumber, pieceColor }, queryExecutor = pool) {
	const normalizedPieceColor = normalizeText(pieceColor).toLowerCase();

	if (normalizedPieceColor !== "white" && normalizedPieceColor !== "black") {
		return null;
	}

	const result = await queryExecutor.query(
		`SELECT tm.team_member_id
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1
		   AND tm.board_number = $2
		   AND LOWER(tm.piece_color) = $3
		 LIMIT 1`,
		[gameId, boardNumber, normalizedPieceColor]
	);

	return result.rowCount > 0 ? normalizeId(result.rows[0].team_member_id) : null;
}

async function getReservePieceTypesByTeamMemberId(teamMemberId, queryExecutor = pool) {
	const normalizedTeamMemberId = normalizeId(teamMemberId);

	if (!normalizedTeamMemberId) {
		return [];
	}

	const result = await queryExecutor.query(
		`SELECT piece_type
		 FROM gameplay.player_reserves
		 WHERE team_member_id = $1
		   AND quantity > 0`,
		[normalizedTeamMemberId]
	);

	return result.rows
		.map((row) => String(row?.piece_type ?? "").trim().toLowerCase())
		.filter((piece) => BUGHOUSE_DROP_PIECE_TYPES.includes(piece));
}

async function getOppositeColorTeamMemberId({ gameId, boardNumber, pieceColor }, queryExecutor = pool) {
	const oppositeColor = normalizeText(pieceColor).toLowerCase() === "white" ? "black" : "white";

	const result = await queryExecutor.query(
		`SELECT tm.team_member_id
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1
		   AND tm.board_number = $2
		   AND LOWER(tm.piece_color) = $3
		 LIMIT 1`,
		[gameId, boardNumber, oppositeColor]
	);

	return result.rowCount > 0 ? normalizeId(result.rows[0].team_member_id) : null;
}

async function ensureMoveActorAccess(
	{ teamMember, actingUserId, allowBotControl },
	queryExecutor = pool
) {
	const normalizedActingUserId = normalizeUserId(actingUserId);

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const normalizedTeamMemberUserId = normalizeUserId(teamMember.user_id);

	if (teamMember.is_bot) {
		if (!allowBotControl) {
			const error = new Error("You can only move your own team member slot");
			error.code = "TEAM_MEMBER_ACCESS_DENIED";
			throw error;
		}

		return;
	}

	if (!normalizedTeamMemberUserId || normalizedTeamMemberUserId !== normalizedActingUserId) {
		const error = new Error("You can only move your own team member slot");
		error.code = "TEAM_MEMBER_ACCESS_DENIED";
		throw error;
	}
}

async function ensureUserCanAccessGame({ gameId, actingUserId }, queryExecutor = pool) {
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
		 LIMIT 1`,
		[gameId, normalizedActingUserId]
	);

	if (accessResult.rowCount === 0) {
		const error = new Error("You do not have access to this game");
		error.code = "GAME_ACCESS_DENIED";
		throw error;
	}
}

async function getNextMoveNumberForGame(gameId, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT COALESCE(MAX(m.move_number), 0)::int AS max_move_number
		 FROM gameplay.moves m
		 JOIN gameplay.team_members tm ON tm.team_member_id = m.team_member_id
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1`,
		[gameId]
	);

	return result.rows[0].max_move_number + 1;
}

async function getBoardMovesForGame({ gameId, boardNumber }, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT m.move_uci
		 FROM gameplay.moves m
		 JOIN gameplay.team_members tm ON tm.team_member_id = m.team_member_id
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1 AND tm.board_number = $2
		 ORDER BY m.move_number ASC, m.move_id ASC`,
		[gameId, boardNumber]
	);

	return result.rows.map((row) => row.move_uci);
}

async function getLastBoardMoveForGame({ gameId, boardNumber }, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT m.team_member_id, m.move_number, m.fen_after_move
		 FROM gameplay.moves m
		 JOIN gameplay.team_members tm ON tm.team_member_id = m.team_member_id
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1 AND tm.board_number = $2
		 ORDER BY m.move_number DESC, m.move_id DESC
		 LIMIT 1`,
		[gameId, boardNumber]
	);

	return result.rows[0] ?? null;
	
}

function buildChessBoardFromMoves(uciMoves) {
	const chess = new Chess();

	for (const uci of uciMoves) {
		const dropMatch = uci.match(MOVE_DROP_UCI_PATTERN);

		if (dropMatch) {
			const pieceType = dropMatch[1];
			const square = dropMatch[2];
			const rank = Number(square[1]);
			const currentTurn = chess.turn();

			if (pieceType === "p" && (rank === 1 || rank === 8)) {
				const error = new Error(`Stored move is invalid for board state: ${uci}`);
				error.code = "HISTORICAL_MOVE_INVALID";
				throw error;
			}

			if (chess.get(square) != null) {
				const error = new Error(`Stored move is invalid for board state: ${uci}`);
				error.code = "HISTORICAL_MOVE_INVALID";
				throw error;
			}

			const dropApplied = chess.put({ type: pieceType, color: currentTurn }, square);

			if (!dropApplied) {
				const error = new Error(`Stored move is invalid for board state: ${uci}`);
				error.code = "HISTORICAL_MOVE_INVALID";
				throw error;
			}

			const fenParts = chess.fen().split(" ");
			fenParts[1] = currentTurn === "w" ? "b" : "w";
			fenParts[3] = "-";
			fenParts[4] = String(Number(fenParts[4]) + 1);
			if (currentTurn === "b") {
				fenParts[5] = String(Number(fenParts[5]) + 1);
			}
			chess.load(fenParts.join(" "));
		} else {
			const standardMove = chess.move({
				from: uci.slice(0, 2),
				to: uci.slice(2, 4),
				promotion: uci.length === 5 ? uci[4] : undefined,
			});

			if (!standardMove) {
				const error = new Error(`Stored move is invalid for board state: ${uci}`);
				error.code = "HISTORICAL_MOVE_INVALID";
				throw error;
			}
		}
	}

	return chess;
}

export async function createMove(
	{ team_member_id, move_uci, captured_piece, acting_user_id, allow_bot_control = false },
	queryExecutor = pool
) {
	const requestStartedAt = Date.now();
	const moveTiming = {
		start: requestStartedAt,
	};

	const markTiming = (key) => {
		moveTiming[key] = Date.now();
	};

	const normalizedTeamMemberId = normalizeId(team_member_id);
	const normalizedMoveUci = normalizeText(move_uci).toLowerCase();
	const normalizedCapturedPieceRaw = normalizeText(captured_piece);
	const normalizedCapturedPiece = normalizedCapturedPieceRaw ? normalizedCapturedPieceRaw.toLowerCase() : null;
	const isDropMove = MOVE_DROP_UCI_PATTERN.test(normalizedMoveUci);

	if (normalizedTeamMemberId === null) {
		const error = new Error("team_member_id must be a valid positive integer");
		error.code = "INVALID_TEAM_MEMBER_ID";
		throw error;
	}

	if (!normalizedMoveUci) {
		const error = new Error("move_uci is required");
		error.code = "MOVE_UCI_REQUIRED";
		throw error;
	}

	if (!isDropMove && !MOVE_UCI_PATTERN.test(normalizedMoveUci)) {
		const error = new Error("move_uci must be valid UCI format (e.g. e2e4, e7e8q) or a drop move (e.g. @ne4)");
		error.code = "INVALID_MOVE_UCI";
		throw error;
	}

	if (normalizedCapturedPiece && normalizedCapturedPiece.length > 20) {
		const error = new Error("captured_piece must be 20 characters or fewer");
		error.code = "CAPTURED_PIECE_TOO_LONG";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");
		markTiming("afterBegin");

		const teamMember = await getTeamMemberContext(normalizedTeamMemberId, executor);
		markTiming("afterTeamMember");

		if (!teamMember.joined_at) {
			const error = new Error("Team member has not joined yet");
			error.code = "TEAM_MEMBER_NOT_JOINED";
			throw error;
		}

		await ensureMoveActorAccess(
			{
				teamMember,
				actingUserId: acting_user_id,
				allowBotControl: Boolean(allow_bot_control),
			},
			executor
		);
		markTiming("afterAccessCheck");

		const gameLockResult = await executor.query(
			`SELECT ${GAME_SELECT_FIELDS}
			 FROM gameplay.games
			 WHERE game_id = $1
			 FOR UPDATE`,
			[teamMember.game_id]
		);
		markTiming("afterGameLock");

		if (gameLockResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		const lockedGame = gameLockResult.rows[0];
		const normalizedGameStatus = normalizeText(lockedGame.status).toLowerCase();

		if (normalizedGameStatus === "finished") {
			const error = new Error("Game is already finished");
			error.code = "GAME_ALREADY_FINISHED";
			throw error;
		}

		if (normalizedGameStatus !== "started") {
			const error = new Error("Game is not started");
			error.code = "GAME_NOT_STARTED";
			throw error;
		}

		const { game: synchronizedGame, timedOutMemberId } = await _synchronizeGameClockWithinTransaction(teamMember.game_id, lockedGame, executor);
		markTiming("afterClockSync");

		if (timedOutMemberId !== null) {
			const timedOutTeamResult = await executor.query(
				`SELECT t.team_id FROM gameplay.team_members tm JOIN gameplay.teams t ON t.team_id = tm.team_id WHERE tm.team_member_id = $1`,
				[timedOutMemberId]
			);
			const timedOutTeamId = normalizeId(timedOutTeamResult.rows[0]?.team_id);
			if (timedOutTeamId) {
				const winnerTeamResult = await executor.query(
					`SELECT team_id, team_name FROM gameplay.teams WHERE game_id = $1 AND team_id != $2 LIMIT 1`,
					[teamMember.game_id, timedOutTeamId]
				);
				const winnerTeam = winnerTeamResult.rows[0] ?? null;
				if (winnerTeam) {
					const finishResult = await executor.query(
						`UPDATE gameplay.games
						 SET status = 'finished', finished_at = NOW(), winner_team_id = $2,
							 finish_reason = 'timeout', result = $3
						 WHERE game_id = $1 AND status = 'started'
						 RETURNING ${GAME_SELECT_FIELDS}`,
						[teamMember.game_id, winnerTeam.team_id, `${normalizeText(winnerTeam.team_name) || "Team"} won on time`]
					);
					if (finishResult.rowCount > 0) {
						const timedOutUserId = await getUserIdByTeamMemberId(timedOutMemberId, executor);
						if (client) await client.query("COMMIT");
						const timedOutFinishedGame = finishResult.rows[0];
						applyRatingForFinishedGame({
							gameId: timedOutFinishedGame.game_id,
							winnerTeamId: timedOutFinishedGame.winner_team_id,
							ratedGame: timedOutFinishedGame.rated_game,
							options: timedOutUserId ? { disconnecting_user_ids: [timedOutUserId] } : {},
						}).catch((err) => console.error("[rating] Failed to apply rating:", err));
						return {
							game_id: teamMember.game_id,
							board_number: teamMember.board_number,
							piece_color: teamMember.piece_color,
							reserve_updates: [],
							game: timedOutFinishedGame,
							timeout: true,
						};
					}
				}
			}
		}

		const nextMoveNumber = (Number(synchronizedGame.move_count) || 0) + 1;
		const lastBoardMove = await getLastBoardMoveForGame(
			{ gameId: teamMember.game_id, boardNumber: teamMember.board_number },
			executor
		);
		markTiming("afterLastBoardMove");

		let lastBoardFen = typeof lastBoardMove?.fen_after_move === "string" ? lastBoardMove.fen_after_move.trim() : "";

		if (lastBoardFen) {
			const fenCheckChess = new Chess();
			const isFenValid = fenCheckChess.load(lastBoardFen);

			if (!isFenValid) {
				lastBoardFen = "";
			}
		}
		let boardMoves = null;

		if (lastBoardMove && Number(lastBoardMove.team_member_id) === normalizedTeamMemberId) {
			const error = new Error("The same team member cannot move twice in a row on this board");
			error.code = "CONSECUTIVE_TEAM_MEMBER_MOVE";
			throw error;
		}

		if (isDropMove) {
			const dropMatch = normalizedMoveUci.match(MOVE_DROP_UCI_PATTERN);
			const dropPieceType = dropMatch[1];
			const dropSquare = dropMatch[2];
			const dropRank = parseInt(dropSquare[1], 10);

			if (dropPieceType === "p" && (dropRank === 1 || dropRank === 8)) {
				const error = new Error("Pawns cannot be dropped on the first or eighth rank");
				error.code = "INVALID_DROP_SQUARE_FOR_PAWN";
				throw error;
			}

			let chessForDrop = null;

			if (lastBoardFen) {
				const snapshotChess = new Chess();
				const loaded = snapshotChess.load(lastBoardFen);

				if (!loaded) {
					lastBoardFen = "";
				} else {
					chessForDrop = snapshotChess;
				}
			} else {
				if (!Array.isArray(boardMoves)) {
					boardMoves = await getBoardMovesForGame(
						{ gameId: teamMember.game_id, boardNumber: teamMember.board_number },
						executor
					);
				}
			}

			if (!chessForDrop) {
				if (!Array.isArray(boardMoves)) {
					boardMoves = await getBoardMovesForGame(
						{ gameId: teamMember.game_id, boardNumber: teamMember.board_number },
						executor
					);
				}

				chessForDrop = buildChessBoardFromMoves(boardMoves);
			}
			const expectedTurnForDrop = teamMember.piece_color === "white" ? "w" : "b";

			if (chessForDrop.turn() !== expectedTurnForDrop) {
				const requiredColor = chessForDrop.turn() === "w" ? "white" : "black";
				const error = new Error(`It is ${requiredColor}'s turn on this board`);
				error.code = "TURN_MISMATCH";
				throw error;
			}

			const boardGrid = chessForDrop.board();
			const fileIndex = dropSquare.charCodeAt(0) - 97;
			const rankIndex = 8 - dropRank;

			if (boardGrid[rankIndex][fileIndex] !== null) {
				const error = new Error("Drop square is occupied");
				error.code = "DROP_SQUARE_OCCUPIED";
				throw error;
			}

			const reserveCheckResult = await executor.query(
				`SELECT quantity FROM gameplay.player_reserves
				 WHERE team_member_id = $1 AND piece_type = $2 LIMIT 1`,
				[normalizedTeamMemberId, dropPieceType]
			);

			if (!reserveCheckResult.rows[0] || Number(reserveCheckResult.rows[0].quantity) <= 0) {
				const error = new Error(`No ${dropPieceType} piece available in reserve for this team member`);
				error.code = "RESERVE_PIECE_NOT_AVAILABLE";
				throw error;
			}

			chessForDrop.put({ type: dropPieceType, color: expectedTurnForDrop }, dropSquare);

			if (chessForDrop.isCheck()) {
				const error = new Error("Illegal drop for current board state");
				error.code = "ILLEGAL_MOVE";
				throw error;
			}

			const fenPartsForDrop = chessForDrop.fen().split(" ");
			fenPartsForDrop[1] = expectedTurnForDrop === "w" ? "b" : "w";
			fenPartsForDrop[3] = "-";
			fenPartsForDrop[4] = String(Number(fenPartsForDrop[4]) + 1);
			if (expectedTurnForDrop === "b") {
				fenPartsForDrop[5] = String(Number(fenPartsForDrop[5]) + 1);
			}
			const fenAfterDrop = fenPartsForDrop.join(" ");

			const dropInsertResult = await executor.query(
				`INSERT INTO gameplay.moves (team_member_id, move_number, move_uci, captured_piece, fen_after_move)
				 VALUES ($1, $2, $3, $4, $5)
				 RETURNING ${MOVE_SELECT_FIELDS}`,
				[normalizedTeamMemberId, nextMoveNumber, normalizedMoveUci, null, fenAfterDrop]
			);
			markTiming("afterDropInsert");

			const reserveDecrementResult = await executor.query(
				`UPDATE gameplay.player_reserves
				 SET quantity = quantity - 1
				 WHERE team_member_id = $1 AND piece_type = $2 AND quantity > 0`,
				[normalizedTeamMemberId, dropPieceType]
			);

			if (reserveDecrementResult.rowCount === 0) {
				const error = new Error("Reserve piece is no longer available");
				error.code = "RESERVE_DECREMENT_CONFLICT";
				throw error;
			}

			await executor.query("UPDATE gameplay.games SET move_count = $1 WHERE game_id = $2", [
				nextMoveNumber,
				teamMember.game_id,
			]);

			const oppositeMemberId = await getOppositeColorTeamMemberId(
				{
					gameId: teamMember.game_id,
					boardNumber: teamMember.board_number,
					pieceColor: teamMember.piece_color,
				},
				executor
			);

			const activeColumn = Number(teamMember.board_number) === 1
				? "active_board1_team_member_id"
				: "active_board2_team_member_id";

			await executor.query(
				`UPDATE gameplay.games
				 SET ${activeColumn} = $2,
					 clock_last_synced_at = NOW()
				 WHERE game_id = $1`,
				[teamMember.game_id, oppositeMemberId]
			);

			const incrementSeconds = getIncrementSeconds(synchronizedGame.increment);
			if (incrementSeconds > 0) {
				await executor.query(
					`UPDATE gameplay.team_members
					 SET remaining_seconds = COALESCE(remaining_seconds, 0) + $2
					 WHERE team_member_id = $1`,
					[normalizedTeamMemberId, incrementSeconds]
				);
			}

			let finishedGame = null;
			const defendingPieceColor = teamMember.piece_color === "white" ? "black" : "white";
			const defendingTeamMemberId = await getTeamMemberIdByBoardAndPieceColor(
				{
					gameId: teamMember.game_id,
					boardNumber: teamMember.board_number,
					pieceColor: defendingPieceColor,
				},
				executor
			);
			const defendingReservePieces = await getReservePieceTypesByTeamMemberId(defendingTeamMemberId, executor);

			if (isBughouseCheckmateFen(fenAfterDrop, defendingReservePieces)) {
				const finishResult = await executor.query(
					`UPDATE gameplay.games
					 SET status = 'finished',
						 finished_at = NOW(),
						 winner_team_id = $2,
						 finish_reason = 'checkmate',
						 result = $3
					 WHERE game_id = $1
					 RETURNING ${GAME_SELECT_FIELDS}`,
					[
						teamMember.game_id,
						teamMember.team_id,
						`${normalizeText(teamMember.team_name) || "Team"} won by checkmate`,
					]
				);

				finishedGame = finishResult.rows[0] ?? null;
			}

			if (client) await client.query("COMMIT");
			if (finishedGame) {
				applyRatingForFinishedGame({
					gameId: finishedGame.game_id,
					winnerTeamId: finishedGame.winner_team_id,
					ratedGame: finishedGame.rated_game,
				}).catch((err) => console.error("[rating] Failed to apply rating:", err));
			}
			markTiming("afterCommit");

			if (SHOULD_LOG_MOVE_TIMING) {
				console.log("[move-timing]", {
					teamMemberId: normalizedTeamMemberId,
					moveUci: normalizedMoveUci,
					isDropMove: true,
					totalMs: moveTiming.afterCommit - moveTiming.start,
					segmentsMs: {
						beginToTeamMember: (moveTiming.afterTeamMember ?? 0) - (moveTiming.afterBegin ?? 0),
						teamMemberToAccessCheck: (moveTiming.afterAccessCheck ?? 0) - (moveTiming.afterTeamMember ?? 0),
						accessCheckToGameLock: (moveTiming.afterGameLock ?? 0) - (moveTiming.afterAccessCheck ?? 0),
						gameLockToClockSync: (moveTiming.afterClockSync ?? 0) - (moveTiming.afterGameLock ?? 0),
						clockSyncToLastMove: (moveTiming.afterLastBoardMove ?? 0) - (moveTiming.afterClockSync ?? 0),
						lastMoveToInsert: (moveTiming.afterDropInsert ?? 0) - (moveTiming.afterLastBoardMove ?? 0),
						insertToCommit: (moveTiming.afterCommit ?? 0) - (moveTiming.afterDropInsert ?? 0),
					},
				});
			}

			return {
				...dropInsertResult.rows[0],
				game_id: teamMember.game_id,
				board_number: teamMember.board_number,
				piece_color: teamMember.piece_color,
				fen_after_move: fenAfterDrop,
				reserve_updates: [
					{
						team_member_id: normalizedTeamMemberId,
						piece_type: dropPieceType,
						change: -1,
					},
				],
				game: finishedGame,
			};
		}

		let validationResult = null;

		if (lastBoardFen) {
			validationResult = validateMoveOnFenBoard({
				currentFen: lastBoardFen,
				nextUciMove: normalizedMoveUci,
				expectedPieceColor: teamMember.piece_color,
			});
		} else {
			if (!Array.isArray(boardMoves)) {
				boardMoves = await getBoardMovesForGame(
					{ gameId: teamMember.game_id, boardNumber: teamMember.board_number },
					executor
				);
			}

			validationResult = validateMoveOnDefaultBoard({
				historicalUciMoves: boardMoves,
				nextUciMove: normalizedMoveUci,
				expectedPieceColor: teamMember.piece_color,
			});
		}

		const { capturedPiece: derivedCapturedPiece, fenAfterMove } = validationResult;

		if (normalizedCapturedPiece && normalizedCapturedPiece !== derivedCapturedPiece) {
			const error = new Error("captured_piece does not match actual captured piece on board");
			error.code = "CAPTURED_PIECE_MISMATCH";
			throw error;
		}

		const finalCapturedPiece = normalizedCapturedPiece ?? derivedCapturedPiece;

		const insertResult = await executor.query(
			`INSERT INTO gameplay.moves (team_member_id, move_number, move_uci, captured_piece, fen_after_move)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING ${MOVE_SELECT_FIELDS}`,
			[normalizedTeamMemberId, nextMoveNumber, normalizedMoveUci, finalCapturedPiece, fenAfterMove]
		);
		markTiming("afterMoveInsert");

		const reserveUpdates = [];

		if (finalCapturedPiece) {
			const reserveIncrease = await addCapturedPieceToTeammateReserve(
				{
					teamId: teamMember.team_id,
					teamMemberId: normalizedTeamMemberId,
					capturedPiece: finalCapturedPiece,
				},
				executor
			);

			if (reserveIncrease?.team_member_id && reserveIncrease?.piece_type) {
				reserveUpdates.push({
					team_member_id: reserveIncrease.team_member_id,
					piece_type: reserveIncrease.piece_type,
					change: 1,
				});
			}
		}

		await executor.query("UPDATE gameplay.games SET move_count = $1 WHERE game_id = $2", [
			nextMoveNumber,
			teamMember.game_id,
		]);

		const oppositeMemberId = await getOppositeColorTeamMemberId(
			{
				gameId: teamMember.game_id,
				boardNumber: teamMember.board_number,
				pieceColor: teamMember.piece_color,
			},
			executor
		);

		const activeColumn = Number(teamMember.board_number) === 1
			? "active_board1_team_member_id"
			: "active_board2_team_member_id";

		await executor.query(
			`UPDATE gameplay.games
			 SET ${activeColumn} = $2,
				 clock_last_synced_at = NOW()
			 WHERE game_id = $1`,
			[teamMember.game_id, oppositeMemberId]
		);

		const incrementSeconds = getIncrementSeconds(synchronizedGame.increment);
		if (incrementSeconds > 0) {
			await executor.query(
				`UPDATE gameplay.team_members
				 SET remaining_seconds = COALESCE(remaining_seconds, 0) + $2
				 WHERE team_member_id = $1`,
				[normalizedTeamMemberId, incrementSeconds]
			);
		}

		let finishedGame = null;
		const defendingPieceColor = teamMember.piece_color === "white" ? "black" : "white";
		const defendingTeamMemberId = await getTeamMemberIdByBoardAndPieceColor(
			{
				gameId: teamMember.game_id,
				boardNumber: teamMember.board_number,
				pieceColor: defendingPieceColor,
			},
			executor
		);
		const defendingReservePieces = await getReservePieceTypesByTeamMemberId(defendingTeamMemberId, executor);

		if (isBughouseCheckmateFen(fenAfterMove, defendingReservePieces)) {
			const finishResult = await executor.query(
				`UPDATE gameplay.games
				 SET status = 'finished',
					 finished_at = NOW(),
					 winner_team_id = $2,
					 finish_reason = 'checkmate',
					 result = $3
				 WHERE game_id = $1
				 RETURNING ${GAME_SELECT_FIELDS}`,
				[
					teamMember.game_id,
					teamMember.team_id,
					`${normalizeText(teamMember.team_name) || "Team"} won by checkmate`,
				]
			);

			finishedGame = finishResult.rows[0] ?? null;
		}

		if (client) await client.query("COMMIT");
		if (finishedGame) {
			applyRatingForFinishedGame({
				gameId: finishedGame.game_id,
				winnerTeamId: finishedGame.winner_team_id,
				ratedGame: finishedGame.rated_game,
			}).catch((err) => console.error("[rating] Failed to apply rating:", err));
		}
		markTiming("afterCommit");

		if (SHOULD_LOG_MOVE_TIMING) {
			console.log("[move-timing]", {
				teamMemberId: normalizedTeamMemberId,
				moveUci: normalizedMoveUci,
				isDropMove: false,
				totalMs: moveTiming.afterCommit - moveTiming.start,
				segmentsMs: {
					beginToTeamMember: (moveTiming.afterTeamMember ?? 0) - (moveTiming.afterBegin ?? 0),
					teamMemberToAccessCheck: (moveTiming.afterAccessCheck ?? 0) - (moveTiming.afterTeamMember ?? 0),
					accessCheckToGameLock: (moveTiming.afterGameLock ?? 0) - (moveTiming.afterAccessCheck ?? 0),
					gameLockToClockSync: (moveTiming.afterClockSync ?? 0) - (moveTiming.afterGameLock ?? 0),
					clockSyncToLastMove: (moveTiming.afterLastBoardMove ?? 0) - (moveTiming.afterClockSync ?? 0),
					lastMoveToInsert: (moveTiming.afterMoveInsert ?? 0) - (moveTiming.afterLastBoardMove ?? 0),
					insertToCommit: (moveTiming.afterCommit ?? 0) - (moveTiming.afterMoveInsert ?? 0),
				},
			});
		}

		return {
			...insertResult.rows[0],
			game_id: teamMember.game_id,
			board_number: teamMember.board_number,
			piece_color: teamMember.piece_color,
			fen_after_move: fenAfterMove,
			reserve_updates: reserveUpdates,
			game: finishedGame,
		};
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function createBotMove({ team_member_id, acting_user_id }, queryExecutor = pool) {
	const normalizedTeamMemberId = normalizeId(team_member_id);
	console.log(`[BOT] createBotMove called`, { team_member_id, acting_user_id });

	if (normalizedTeamMemberId === null) {
		const error = new Error("team_member_id must be a valid positive integer");
		error.code = "INVALID_TEAM_MEMBER_ID";
		throw error;
	}

	const retryableCodes = new Set([
		"HISTORICAL_MOVE_INVALID",
		"TURN_MISMATCH",
		"ILLEGAL_MOVE",
		"CONSECUTIVE_TEAM_MEMBER_MOVE",
	]);

	for (let attempt = 0; attempt < 2; attempt += 1) {
		console.log(`[BOT] Attempt ${attempt + 1} for bot move`, { team_member_id, acting_user_id });
		const teamMember = await getTeamMemberContext(normalizedTeamMemberId, queryExecutor);

		if (!teamMember.is_bot) {
			console.warn(`[BOT] Not a bot slot`, { team_member_id });
			const error = new Error("team_member_id must belong to a bot slot");
			error.code = "TEAM_MEMBER_NOT_BOT";
			throw error;
		}

		if (!teamMember.joined_at) {
			console.warn(`[BOT] Team member not joined`, { team_member_id });
			const error = new Error("Team member has not joined yet");
			error.code = "TEAM_MEMBER_NOT_JOINED";
			throw error;
		}

		await ensureMoveActorAccess(
			{
				teamMember,
				actingUserId: acting_user_id,
				allowBotControl: true,
			},
			queryExecutor
		);

		const boardMoves = await getBoardMovesForGame(
			{ gameId: teamMember.game_id, boardNumber: teamMember.board_number },
			queryExecutor
		);

		const reserveResult = await queryExecutor.query(
			`SELECT piece_type FROM gameplay.player_reserves
			 WHERE team_member_id = $1 AND quantity > 0`,
			[normalizedTeamMemberId]
		);
		const reservePieces = reserveResult.rows.map((row) => row.piece_type);

		let moveUci = null;

		try {
			const calculatedMove = calculateBestBotMoveOnDefaultBoard({
				historicalUciMoves: boardMoves,
				expectedPieceColor: teamMember.piece_color,
				reservePieces,
			});
			moveUci = calculatedMove?.moveUci ?? null;
		} catch (error) {
			if (error?.code === "NO_LEGAL_BOT_MOVE") {
				// Before treating this as "waiting for reserve", check whether the bot is
				// genuinely in Bughouse checkmate (in check, no legal moves, no blocking
				// drops possible). If it is, the opposing team wins immediately.
				let finishedGameFromCheckmate = null;

				try {
					const lastFenResult = await queryExecutor.query(
						`SELECT m.fen_after_move
						 FROM gameplay.moves m
						 JOIN gameplay.team_members tm ON tm.team_member_id = m.team_member_id
						 JOIN gameplay.teams t ON t.team_id = tm.team_id
						 WHERE t.game_id = $1 AND tm.board_number = $2
						 ORDER BY m.move_number DESC, m.move_id DESC LIMIT 1`,
						[teamMember.game_id, teamMember.board_number]
					);

					const currentFen = lastFenResult.rows[0]?.fen_after_move ?? null;

					if (currentFen && isBughouseCheckmateFen(currentFen, reservePieces)) {
						const winnerTeamResult = await queryExecutor.query(
							`SELECT team_id, team_name FROM gameplay.teams
							 WHERE game_id = $1 AND team_id != $2 LIMIT 1`,
							[teamMember.game_id, teamMember.team_id]
						);
						const winnerTeam = winnerTeamResult.rows[0] ?? null;

						if (winnerTeam) {
							const finishResult = await queryExecutor.query(
								`UPDATE gameplay.games
								 SET status = 'finished',
									 finished_at = NOW(),
									 winner_team_id = $2,
									 finish_reason = 'checkmate',
									 result = $3
								 WHERE game_id = $1 AND status = 'started'
								 RETURNING ${GAME_SELECT_FIELDS}`,
								[
									teamMember.game_id,
									winnerTeam.team_id,
									`${normalizeText(winnerTeam.team_name) || "Team"} won by checkmate`,
								]
							);
							finishedGameFromCheckmate = finishResult.rows[0] ?? null;
						}
					}
				} catch (checkmateDetectionError) {
					console.error("[BOT] Error during checkmate detection fallback:", checkmateDetectionError);
				}

				if (finishedGameFromCheckmate) {
					console.log(`[BOT] Bot is in checkmate, game finished`, { team_member_id });
					applyRatingForFinishedGame({
						gameId: finishedGameFromCheckmate.game_id,
						winnerTeamId: finishedGameFromCheckmate.winner_team_id,
						ratedGame: finishedGameFromCheckmate.rated_game,
					}).catch((err) => console.error("[rating] Failed to apply rating:", err));
					return {
						waiting_for_reserve: false,
						team_member_id: normalizedTeamMemberId,
						game_id: teamMember.game_id,
						board_number: teamMember.board_number,
						piece_color: teamMember.piece_color,
						game: finishedGameFromCheckmate,
					};
				}

				console.log(`[BOT] No legal bot move, waiting for reserve`, { team_member_id });
				return {
					waiting_for_reserve: true,
					team_member_id: normalizedTeamMemberId,
					game_id: teamMember.game_id,
					board_number: teamMember.board_number,
					piece_color: teamMember.piece_color,
					message: "Bot is waiting for a reserve piece",
				};
			}
			if (attempt === 0 && retryableCodes.has(error?.code)) {
				console.warn(`[BOT] Retrying bot move calculation due to retryable error`, { team_member_id, code: error?.code });
				await new Promise((resolve) => setTimeout(resolve, 1500));
				continue;
			}
			console.error(`[BOT] Error in calculateBestBotMoveOnDefaultBoard`, { team_member_id, error });
			throw error;
		}

		if (!moveUci) {
			console.log(`[BOT] No moveUci returned, waiting for reserve`, { team_member_id });
			return {
				waiting_for_reserve: true,
				team_member_id: normalizedTeamMemberId,
				game_id: teamMember.game_id,
				board_number: teamMember.board_number,
				piece_color: teamMember.piece_color,
				message: "Bot is waiting for a reserve piece",
			};
		}

		try {
			const move = await createMove(
				{
					team_member_id: normalizedTeamMemberId,
					move_uci: moveUci,
					acting_user_id,
					allow_bot_control: true,
				},
				queryExecutor
			);
			console.log(`[BOT] Bot move created`, { team_member_id, moveUci });
			return {
				...move,
				calculated_move_uci: moveUci,
			};
		} catch (error) {
			if (error?.code === "NO_LEGAL_BOT_MOVE") {
				console.log(`[BOT] No legal bot move after createMove, waiting for reserve`, { team_member_id });
				return {
					waiting_for_reserve: true,
					team_member_id: normalizedTeamMemberId,
					game_id: teamMember.game_id,
					board_number: teamMember.board_number,
					piece_color: teamMember.piece_color,
					message: "Bot is waiting for a reserve piece",
				};
			}
			if (attempt === 0 && retryableCodes.has(error?.code)) {
				console.warn(`[BOT] Retrying bot move due to retryable error`, { team_member_id, code: error?.code });
				continue;
			}
			console.error(`[BOT] Error in createMove`, { team_member_id, error });
			throw error;
		}
	}

	const error = new Error("Failed to create bot move");
	error.code = "BOT_MOVE_FAILED";
	throw error;
}

export async function listMovesByGameId(game_id, acting_user_id, queryExecutor = pool) {
	const normalizedGameId = normalizeId(game_id);

	if (normalizedGameId === null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	await ensureGameExists(normalizedGameId, queryExecutor);
	await ensureUserCanAccessGame({ gameId: normalizedGameId, actingUserId: acting_user_id }, queryExecutor);

	const result = await queryExecutor.query(
		`SELECT
			m.move_id,
			t.game_id,
			m.team_member_id,
			tm.team_id,
			tm.board_number,
			tm.piece_color,
			tm.user_id,
			tm.is_bot,
			m.move_number,
			m.move_uci,
			m.captured_piece,
			m.fen_after_move
		 FROM gameplay.moves m
		 JOIN gameplay.team_members tm ON tm.team_member_id = m.team_member_id
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1
		 ORDER BY m.move_number ASC, m.move_id ASC`,
		[normalizedGameId]
	);

	return result.rows;
}

export async function claimGameTimeout(game_id, acting_user_id, queryExecutor = pool) {
	const normalizedGameId = normalizeId(game_id);
	if (!normalizedGameId) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	await ensureGameExists(normalizedGameId, queryExecutor);
	await ensureUserCanAccessGame({ gameId: normalizedGameId, actingUserId: acting_user_id }, queryExecutor);

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		const gameLockResult = await executor.query(
			`SELECT ${GAME_SELECT_FIELDS} FROM gameplay.games WHERE game_id = $1 FOR UPDATE`,
			[normalizedGameId]
		);

		if (gameLockResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		const lockedGame = gameLockResult.rows[0];
		if (normalizeText(lockedGame.status).toLowerCase() !== "started") {
			if (client) await client.query("ROLLBACK");
			return { game: lockedGame, timed_out: false };
		}

		const { game: syncedGame, timedOutMemberId } = await _synchronizeGameClockWithinTransaction(normalizedGameId, lockedGame, executor);

		if (timedOutMemberId === null) {
			if (client) await client.query("COMMIT");
			return { game: syncedGame, timed_out: false };
		}

		const timedOutTeamResult = await executor.query(
			`SELECT t.team_id FROM gameplay.team_members tm JOIN gameplay.teams t ON t.team_id = tm.team_id WHERE tm.team_member_id = $1`,
			[timedOutMemberId]
		);
		const timedOutTeamId = normalizeId(timedOutTeamResult.rows[0]?.team_id);

		if (!timedOutTeamId) {
			if (client) await client.query("COMMIT");
			return { game: syncedGame, timed_out: false };
		}

		const winnerTeamResult = await executor.query(
			`SELECT team_id, team_name FROM gameplay.teams WHERE game_id = $1 AND team_id != $2 LIMIT 1`,
			[normalizedGameId, timedOutTeamId]
		);
		const winnerTeam = winnerTeamResult.rows[0] ?? null;

		if (!winnerTeam) {
			if (client) await client.query("COMMIT");
			return { game: syncedGame, timed_out: false };
		}

		const finishResult = await executor.query(
			`UPDATE gameplay.games
			 SET status = 'finished', finished_at = NOW(), winner_team_id = $2,
				 finish_reason = 'timeout', result = $3
			 WHERE game_id = $1 AND status = 'started'
			 RETURNING ${GAME_SELECT_FIELDS}`,
			[normalizedGameId, winnerTeam.team_id, `${normalizeText(winnerTeam.team_name) || "Team"} won on time`]
		);

		if (client) await client.query("COMMIT");

		if (finishResult.rowCount > 0) {
			const syncTimedOutGame = finishResult.rows[0];
			const timedOutUserId = await getUserIdByTeamMemberId(timedOutMemberId, executor);
			applyRatingForFinishedGame({
				gameId: syncTimedOutGame.game_id,
				winnerTeamId: syncTimedOutGame.winner_team_id,
				ratedGame: syncTimedOutGame.rated_game,
				options: timedOutUserId ? { disconnecting_user_ids: [timedOutUserId] } : {},
			}).catch((err) => console.error("[rating] Failed to apply rating:", err));
			return { game: syncTimedOutGame, timed_out: true };
		}

		return { game: syncedGame, timed_out: false };
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function checkAndFinishForcedCheckmate(gameId, queryExecutor = pool) {
	const normalizedGameId = normalizeId(gameId);
	if (!normalizedGameId) return null;

	const boardStatesResult = await queryExecutor.query(
		`SELECT DISTINCT ON (tm.board_number)
			tm.board_number,
			m.fen_after_move
		 FROM gameplay.moves m
		 JOIN gameplay.team_members tm ON tm.team_member_id = m.team_member_id
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1
		 ORDER BY tm.board_number ASC, m.move_number DESC, m.move_id DESC`,
		[normalizedGameId]
	);

	for (const boardState of boardStatesResult.rows) {
		const { board_number, fen_after_move } = boardState;
		if (!fen_after_move) continue;

		const fenParts = String(fen_after_move).split(" ");
		const activeColor = fenParts[1] === "w" ? "white" : "black";
		const attackingColor = activeColor === "white" ? "black" : "white";

		const defendingMemberResult = await queryExecutor.query(
			`SELECT tm.team_member_id
			 FROM gameplay.team_members tm
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 WHERE t.game_id = $1 AND tm.board_number = $2 AND LOWER(tm.piece_color) = $3
			 LIMIT 1`,
			[normalizedGameId, board_number, activeColor]
		);

		if (defendingMemberResult.rowCount === 0) continue;
		const defendingMemberId = defendingMemberResult.rows[0].team_member_id;

		const reservePieces = await getReservePieceTypesByTeamMemberId(defendingMemberId, queryExecutor);

		if (!isBughouseCheckmateFen(fen_after_move, reservePieces)) continue;

		const attackingTeamResult = await queryExecutor.query(
			`SELECT tm.team_id, t.team_name
			 FROM gameplay.team_members tm
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 WHERE t.game_id = $1 AND tm.board_number = $2 AND LOWER(tm.piece_color) = $3
			 LIMIT 1`,
			[normalizedGameId, board_number, attackingColor]
		);

		if (attackingTeamResult.rowCount === 0) continue;
		const { team_id: winnerTeamId, team_name: winnerTeamName } = attackingTeamResult.rows[0];

		const finishResult = await queryExecutor.query(
			`UPDATE gameplay.games
			 SET status = 'finished',
				 finished_at = COALESCE(finished_at, NOW()),
				 winner_team_id = $2,
				 finish_reason = 'checkmate',
				 result = $3
			 WHERE game_id = $1 AND status = 'started'
			 RETURNING ${GAME_SELECT_FIELDS}`,
			[normalizedGameId, winnerTeamId, `${normalizeText(winnerTeamName) || "Team"} won by checkmate`]
		);

		if (finishResult.rowCount > 0) {
			const forcedMateGame = finishResult.rows[0];
			applyRatingForFinishedGame({
				gameId: forcedMateGame.game_id,
				winnerTeamId: forcedMateGame.winner_team_id,
				ratedGame: forcedMateGame.rated_game,
			}).catch((err) => console.error("[rating] Failed to apply rating:", err));
			return forcedMateGame;
		}
	}

	return null;
}
