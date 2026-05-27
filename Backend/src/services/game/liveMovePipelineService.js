import { Chess } from "chess.js";
import { Redis } from "@upstash/redis";
import pool from "../../config/db.js";
import { upstashConfig } from "../../config/upstash.js";
import { createMove } from "../../models/moveModel.js";
import { validateMoveOnFenBoard } from "../chess/moveValidationService.js";
import { applyRatingForFinishedGame } from "./ratingService.js";

const MOVE_UCI_PATTERN = /^[a-h][1-8][a-h][1-8]([qrbn])?$/i;
const MOVE_DROP_UCI_PATTERN = /^@([pnbrq])([a-h][1-8])$/i;
const BUGHOUSE_DROP_PIECE_TYPES = ["p", "n", "b", "r", "q"];
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const PIECE_NAME_BY_SYMBOL = {
	p: "pawn",
	n: "knight",
	b: "bishop",
	r: "rook",
	q: "queen",
	k: "king",
};

const GAME_SELECT_FIELDS =
	"game_id, status, result, started_at, finished_at, time_control, increment, created_by, move_count, user_id, invite_token, game_name, rated_game, allow_spectators, public_game, draw_offer_count, winner_team_id, finish_reason, clock_last_synced_at, active_board1_team_member_id, active_board2_team_member_id";

const DEBUG_LIVE_CLOCK = process.env.DEBUG_LIVE_CLOCK === "1";

const CACHE_TTL_SECONDS = 60 * 60 * 6;
const persistenceQueue = [];
let workerStarted = false;
let workerInFlight = false;

const hasRedisConfig = Boolean(upstashConfig?.url) && Boolean(upstashConfig?.token);
const redis = hasRedisConfig
	? new Redis({
		url: upstashConfig.url,
		token: upstashConfig.token,
	})
	: null;

const memoryStore = new Map();

// L1: in-process cache (sub-ms reads/writes, single-instance safe)
const L1_TTL_MS = 10 * 60 * 1000; // 10 minutes
const l1 = new Map(); // string values
const l1Hash = new Map(); // object values

function l1Get(key) {
	const entry = l1.get(key);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) { l1.delete(key); return null; }
	return entry.value;
}
function l1Set(key, value, ttlMs = L1_TTL_MS) {
	l1.set(key, { value, expiresAt: Date.now() + ttlMs });
}
function l1GetObj(key) {
	const entry = l1Hash.get(key);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) { l1Hash.delete(key); return null; }
	return entry.value;
}
function l1MergeObj(key, map, ttlMs = L1_TTL_MS) {
	const existing = l1GetObj(key) ?? {};
	l1Hash.set(key, { value: { ...existing, ...map }, expiresAt: Date.now() + ttlMs });
}
function l1Del(keys) {
	for (const key of keys) { l1.delete(key); l1Hash.delete(key); }
}

// In-process caches for DB data that never changes during a game
const TEAM_MEMBER_CACHE_TTL_MS = 30_000; // 30 seconds
const teamMemberContextCache = new Map(); // teamMemberId -> { data, cachedAt }
const oppositeMemberCache = new Map(); // `${gameId}:${boardNumber}:${oppositeColor}` -> memberId

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

async function finishGameByTimeout(gameId, timedOutMemberId, queryExecutor = pool) {
	const timedOutTeamResult = await queryExecutor.query(
		`SELECT t.team_id, t.team_name
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE tm.team_member_id = $1
		 LIMIT 1`,
		[timedOutMemberId]
	);

	const timedOutTeamId = normalizeId(timedOutTeamResult.rows[0]?.team_id);
	if (!timedOutTeamId) {
		return null;
	}

	const winnerTeamResult = await queryExecutor.query(
		`SELECT team_id, team_name
		 FROM gameplay.teams
		 WHERE game_id = $1 AND team_id != $2
		 LIMIT 1`,
		[gameId, timedOutTeamId]
	);

	const winnerTeam = winnerTeamResult.rows[0] ?? null;
	if (!winnerTeam) {
		return null;
	}

	const finishResult = await queryExecutor.query(
		`UPDATE gameplay.games
		 SET status = 'finished', finished_at = NOW(), winner_team_id = $2,
			 finish_reason = 'timeout', result = $3
		 WHERE game_id = $1 AND status = 'started'
		 RETURNING ${GAME_SELECT_FIELDS}`,
		[gameId, winnerTeam.team_id, `${normalizeText(winnerTeam.team_name) || "Team"} won on time`]
	);

	const finishedGame = finishResult.rows[0] ?? null;

	if (finishedGame) {
		const timedOutUserResult = await queryExecutor.query(
			"SELECT user_id FROM gameplay.team_members WHERE team_member_id = $1 LIMIT 1",
			[timedOutMemberId]
		);
		const timedOutUserId = timedOutUserResult.rows[0]?.user_id ? String(timedOutUserResult.rows[0].user_id) : null;
		applyRatingForFinishedGame({
			gameId: finishedGame.game_id,
			winnerTeamId: finishedGame.winner_team_id,
			ratedGame: finishedGame.rated_game,
			options: timedOutUserId ? { disconnecting_user_ids: [timedOutUserId] } : {},
		}).catch((err) => console.error("[rating] Failed to apply rating:", err));
	}

	return finishedGame;
}

async function finishGameByCheckmate({ gameId, winnerTeamId, winnerTeamName }, queryExecutor = pool) {
	const finishResult = await queryExecutor.query(
		`UPDATE gameplay.games
		 SET status = 'finished', finished_at = NOW(), winner_team_id = $2,
			 finish_reason = 'checkmate', result = $3
		 WHERE game_id = $1 AND status = 'started'
		 RETURNING ${GAME_SELECT_FIELDS}`,
		[gameId, winnerTeamId, `${normalizeText(winnerTeamName) || "Team"} won by checkmate`]
	);

	const finishedGame = finishResult.rows[0] ?? null;

	if (finishedGame) {
		applyRatingForFinishedGame({
			gameId: finishedGame.game_id,
			winnerTeamId: finishedGame.winner_team_id,
			ratedGame: finishedGame.rated_game,
		}).catch((err) => console.error("[rating] Failed to apply rating:", err));
	}

	return finishedGame;
}

function getFenKey(gameId, boardNumber) {
	return `live:game:${gameId}:board:${boardNumber}:fen`;
}

function getGameStateKey(gameId) {
	return `live:game:${gameId}:state`;
}

function getReserveKey(gameId, teamMemberId) {
	return `live:game:${gameId}:reserve:${teamMemberId}`;
}

function getMoveSeqKey(gameId) {
	return `live:game:${gameId}:move_seq`;
}

function getMoveCountKey(gameId) {
	return `live:game:${gameId}:move_count`;
}

async function cacheGet(key) {
	const fast = l1Get(key);
	if (fast !== null) return fast;

	let value;
	if (redis) {
		value = await redis.get(key);
	} else {
		value = memoryStore.get(key) ?? null;
	}
	if (value !== null) l1Set(key, String(value));
	return value;
}

async function cacheSet(key, value) {
	l1Set(key, String(value));
	if (redis) {
		redis.set(key, value, { ex: CACHE_TTL_SECONDS }).catch(() => {});
	} else {
		memoryStore.set(key, value);
	}
}

async function cacheDel(keys) {
	const normalizedKeys = Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
	if (normalizedKeys.length === 0) {
		return;
	}

	l1Del(normalizedKeys);
	if (redis) {
		redis.del(...normalizedKeys).catch(() => {});
	} else {
		for (const key of normalizedKeys) {
			memoryStore.delete(key);
		}
	}
}

async function hashGetAll(key) {
	const fast = l1GetObj(key);
	if (fast !== null) return fast;

	let value;
	if (redis) {
		const raw = await redis.hgetall(key);
		value = raw && typeof raw === "object" ? raw : {};
	} else {
		const raw = memoryStore.get(key);
		value = raw && typeof raw === "object" ? { ...raw } : {};
	}
	if (Object.keys(value).length > 0) l1MergeObj(key, value);
	return value;
}

async function hashSet(key, map) {
	if (!map || typeof map !== "object") {
		return;
	}

	l1MergeObj(key, map);
	if (redis) {
		redis.hset(key, map).then(() => redis.expire(key, CACHE_TTL_SECONDS)).catch(() => {});
	} else {
		const previous = memoryStore.get(key);
		memoryStore.set(key, {
			...(previous && typeof previous === "object" ? previous : {}),
			...map,
		});
	}
}

async function incrementCounter(key) {
	const fast = l1Get(key);
	if (fast !== null) {
		const next = Number(fast) + 1;
		l1Set(key, String(next));
		if (redis) {
			redis.set(key, String(next), { ex: CACHE_TTL_SECONDS }).catch(() => {});
		} else {
			memoryStore.set(key, next);
		}
		return next;
	}

	let next;
	if (redis) {
		next = await redis.incr(key);
	} else {
		const current = Number(memoryStore.get(key) ?? 0);
		next = current + 1;
		memoryStore.set(key, next);
	}
	l1Set(key, String(next));
	return next;
}

function parseReserveQuantity(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		return 0;
	}

	return Math.max(0, Math.floor(numeric));
}

function parseInitialSecondsFromTimeControl(value) {
	const numericValue = Number(String(value ?? "").trim());

	if (!Number.isFinite(numericValue) || numericValue <= 0) {
		return 300;
	}

	return Math.max(1, Math.round(numericValue * 60));
}

function parseIsoTimestampMs(value) {
	if (typeof value !== "string") {
		return NaN;
	}

	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : NaN;
}

function toIsoTimestamp(value) {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value.toISOString();
	}

	if (typeof value === "string") {
		const parsed = parseIsoTimestampMs(value);
		if (Number.isFinite(parsed)) {
			return new Date(parsed).toISOString();
		}
	}

	return new Date().toISOString();
}

function normalizeClockState(rawClockState) {
	if (!rawClockState || typeof rawClockState !== "object") {
		return null;
	}

	const timersRaw = normalizeText(rawClockState.timers_json);
	if (!timersRaw) {
		return null;
	}

	let parsedTimers;
	try {
		parsedTimers = JSON.parse(timersRaw);
	} catch {
		return null;
	}

	if (!parsedTimers || typeof parsedTimers !== "object") {
		return null;
	}

	const remainingSecondsByMember = {};
	for (const [memberIdKey, remainingValue] of Object.entries(parsedTimers)) {
		const memberId = normalizeId(memberIdKey);
		if (!memberId) {
			continue;
		}

		remainingSecondsByMember[memberId] = parseReserveQuantity(remainingValue);
	}

	if (Object.keys(remainingSecondsByMember).length === 0) {
		return null;
	}

	const moveCount = parseReserveQuantity(rawClockState.move_count);
	const stateVersion = parseReserveQuantity(rawClockState.state_version) || moveCount;

	return {
		remaining_seconds_by_member: remainingSecondsByMember,
		clock_last_synced_at: normalizeText(rawClockState.clock_last_synced_at) || new Date().toISOString(),
		active_board1_team_member_id: normalizeId(rawClockState.active_board1_team_member_id),
		active_board2_team_member_id: normalizeId(rawClockState.active_board2_team_member_id),
		move_count: moveCount,
		state_version: stateVersion,
	};
}

function serializeClockState(clockState) {
	const timers = clockState?.remaining_seconds_by_member ?? {};

	return {
		timers_json: JSON.stringify(timers),
		clock_last_synced_at: toIsoTimestamp(clockState?.clock_last_synced_at),
		active_board1_team_member_id: String(normalizeId(clockState?.active_board1_team_member_id) ?? ""),
		active_board2_team_member_id: String(normalizeId(clockState?.active_board2_team_member_id) ?? ""),
		move_count: String(parseReserveQuantity(clockState?.move_count)),
		state_version: String(parseReserveQuantity(clockState?.state_version)),
	};
}

function consumeElapsedActiveClockSeconds(clockState, nowMs = Date.now()) {
	if (!clockState || typeof clockState !== "object") {
		return;
	}

	const lastSyncedMs = parseIsoTimestampMs(clockState.clock_last_synced_at);
	if (!Number.isFinite(lastSyncedMs)) {
		clockState.clock_last_synced_at = new Date(nowMs).toISOString();
		return;
	}

	const elapsedSeconds = Math.max(0, Math.floor((nowMs - lastSyncedMs) / 1000));
	if (elapsedSeconds <= 0) {
		return;
	}

	const activeMemberIds = [
		normalizeId(clockState.active_board1_team_member_id),
		normalizeId(clockState.active_board2_team_member_id),
	].filter(Boolean);

	for (const memberId of activeMemberIds) {
		const currentRemaining = parseReserveQuantity(clockState.remaining_seconds_by_member?.[memberId]);
		clockState.remaining_seconds_by_member[memberId] = Math.max(0, currentRemaining - elapsedSeconds);
	}

	clockState.clock_last_synced_at = new Date(nowMs).toISOString();
}

async function persistLiveClockState(gameId, clockState) {
	await hashSet(getGameStateKey(gameId), serializeClockState(clockState));
}

async function ensureLiveClockState({ gameId }, queryExecutor = pool) {
	const gameStateKey = getGameStateKey(gameId);
	const cachedState = normalizeClockState(await hashGetAll(gameStateKey));
	if (cachedState) {
		return cachedState;
	}

	const [gameResult, teamMembersResult] = await Promise.all([
		queryExecutor.query(
			`SELECT
				g.move_count,
				g.clock_last_synced_at,
				g.active_board1_team_member_id,
				g.active_board2_team_member_id,
				g.time_control
			 FROM gameplay.games g
			 WHERE g.game_id = $1
			 LIMIT 1`,
			[gameId]
		),
		queryExecutor.query(
			`SELECT
				tm.team_member_id,
				tm.remaining_seconds
			 FROM gameplay.team_members tm
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 WHERE t.game_id = $1`,
			[gameId]
		),
	]);

	const gameRow = gameResult.rows[0] ?? {};
	const initialSeconds = parseInitialSecondsFromTimeControl(gameRow.time_control);
	const remainingSecondsByMember = {};

	for (const row of teamMembersResult.rows) {
		const memberId = normalizeId(row.team_member_id);
		if (!memberId) {
			continue;
		}

		const dbRemaining = Number(row.remaining_seconds);
		remainingSecondsByMember[memberId] = Number.isFinite(dbRemaining)
			? Math.max(0, Math.floor(dbRemaining))
			: initialSeconds;
	}

	const clockState = {
		remaining_seconds_by_member: remainingSecondsByMember,
		clock_last_synced_at: toIsoTimestamp(gameRow.clock_last_synced_at),
		active_board1_team_member_id: normalizeId(gameRow.active_board1_team_member_id),
		active_board2_team_member_id: normalizeId(gameRow.active_board2_team_member_id),
		move_count: parseReserveQuantity(gameRow.move_count),
		state_version: parseReserveQuantity(gameRow.move_count),
	};

	await persistLiveClockState(gameId, clockState);
	return clockState;
}

export async function getLiveClockSnapshot(gameId, queryExecutor = pool) {
	const normalizedGameId = normalizeId(gameId);
	if (!normalizedGameId) {
		return null;
	}

	const clockState = await ensureLiveClockState({ gameId: normalizedGameId }, queryExecutor);
	consumeElapsedActiveClockSeconds(clockState, Date.now());
	await persistLiveClockState(normalizedGameId, clockState);

	if (DEBUG_LIVE_CLOCK) {
		console.log("[clock:get-snapshot]", {
			gameId: normalizedGameId,
			clockLastSyncedAt: clockState.clock_last_synced_at,
			moveCount: clockState.move_count,
			stateVersion: clockState.state_version,
			remainingSeconds: clockState.remaining_seconds_by_member,
		});
	}

	return {
		remaining_seconds_by_member: { ...clockState.remaining_seconds_by_member },
		clock_last_synced_at: clockState.clock_last_synced_at,
		active_board1_team_member_id: normalizeId(clockState.active_board1_team_member_id),
		active_board2_team_member_id: normalizeId(clockState.active_board2_team_member_id),
		move_count: parseReserveQuantity(clockState.move_count),
		state_version: parseReserveQuantity(clockState.state_version),
	};
}

async function getTeamMemberContext(teamMemberId, queryExecutor = pool) {
	const cached = teamMemberContextCache.get(teamMemberId);
	if (cached && (Date.now() - cached.cachedAt) < TEAM_MEMBER_CACHE_TTL_MS) {
		return cached.data;
	}

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
			t.team_name,
			g.status,
			g.increment,
			g.move_count,
			g.active_board1_team_member_id,
			g.active_board2_team_member_id
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 JOIN gameplay.games g ON g.game_id = t.game_id
		 WHERE tm.team_member_id = $1
		 LIMIT 1`,
		[teamMemberId]
	);

	if (result.rowCount === 0) {
		const error = new Error("Team member not found");
		error.code = "TEAM_MEMBER_NOT_FOUND";
		throw error;
	}

	const data = result.rows[0];
	teamMemberContextCache.set(teamMemberId, { data, cachedAt: Date.now() });
	return data;
}

async function getOppositeColorTeamMemberId({ gameId, boardNumber, pieceColor }, queryExecutor = pool) {
	const oppositeColor = normalizeText(pieceColor).toLowerCase() === "white" ? "black" : "white";
	const cacheKey = `${gameId}:${boardNumber}:${oppositeColor}`;

	const cached = oppositeMemberCache.get(cacheKey);
	if (cached !== undefined) return cached;

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

	const memberId = result.rowCount > 0 ? normalizeId(result.rows[0].team_member_id) : null;
	oppositeMemberCache.set(cacheKey, memberId);
	return memberId;
}

async function ensureMoveActorAccess({ teamMember, actingUserId }) {
	const normalizedActingUserId = normalizeUserId(actingUserId);

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	if (teamMember.is_bot) {
		const error = new Error("Socket bot moves are not allowed");
		error.code = "TEAM_MEMBER_ACCESS_DENIED";
		throw error;
	}

	const normalizedMemberUserId = normalizeUserId(teamMember.user_id);
	if (!normalizedMemberUserId || normalizedMemberUserId !== normalizedActingUserId) {
		const error = new Error("You can only move your own team member slot");
		error.code = "TEAM_MEMBER_ACCESS_DENIED";
		throw error;
	}
}

async function getLastBoardFen({ gameId, boardNumber }, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT m.fen_after_move
		 FROM gameplay.moves m
		 JOIN gameplay.team_members tm ON tm.team_member_id = m.team_member_id
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1 AND tm.board_number = $2
		 ORDER BY m.move_number DESC, m.move_id DESC
		 LIMIT 1`,
		[gameId, boardNumber]
	);

	const fen = normalizeText(result.rows[0]?.fen_after_move);
	if (fen) {
		const testChess = new Chess();
		if (testChess.load(fen)) {
			return fen;
		}
	}

	return new Chess().fen();
}

async function ensureLiveBoardFen({ gameId, boardNumber }, queryExecutor = pool) {
	const key = getFenKey(gameId, boardNumber);
	const cachedFen = normalizeText(await cacheGet(key));

	if (cachedFen) {
		const testChess = new Chess();
		if (testChess.load(cachedFen)) {
			return cachedFen;
		}
	}

	const fen = await getLastBoardFen({ gameId, boardNumber }, queryExecutor);
	await cacheSet(key, fen);
	return fen;
}

async function ensureLiveReserveMap({ gameId, teamMemberId }, queryExecutor = pool) {
	const reserveKey = getReserveKey(gameId, teamMemberId);
	const cachedMap = await hashGetAll(reserveKey);
	const hasValues = Object.keys(cachedMap).length > 0;

	if (hasValues) {
		return cachedMap;
	}

	const result = await queryExecutor.query(
		`SELECT piece_type, quantity
		 FROM gameplay.player_reserves
		 WHERE team_member_id = $1`,
		[teamMemberId]
	);

	const reserveMap = {};
	for (const row of result.rows) {
		const pieceType = normalizeText(row.piece_type).toLowerCase();
		if (!pieceType) {
			continue;
		}

		reserveMap[pieceType] = parseReserveQuantity(row.quantity);
	}

	await hashSet(reserveKey, reserveMap);
	return reserveMap;
}

async function ensureLiveCounters({ gameId }, queryExecutor = pool) {
	const moveCountKey = getMoveCountKey(gameId);
	const moveSeqKey = getMoveSeqKey(gameId);

	const [cachedMoveCount, cachedMoveSeq] = await Promise.all([
		cacheGet(moveCountKey),
		cacheGet(moveSeqKey),
	]);

	if (normalizeId(cachedMoveCount) && normalizeId(cachedMoveSeq)) {
		return;
	}

	const [gameResult, moveSeqResult] = await Promise.all([
		queryExecutor.query("SELECT move_count FROM gameplay.games WHERE game_id = $1 LIMIT 1", [gameId]),
		queryExecutor.query(
			`SELECT COALESCE(MAX(m.move_id), 0)::int AS max_move_id
			 FROM gameplay.moves m
			 JOIN gameplay.team_members tm ON tm.team_member_id = m.team_member_id
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 WHERE t.game_id = $1`,
			[gameId]
		),
	]);

	const dbMoveCount = Number(gameResult.rows[0]?.move_count ?? 0);
	const dbMoveSeq = Number(moveSeqResult.rows[0]?.max_move_id ?? 0);

	await Promise.all([
		cacheSet(moveCountKey, Math.max(0, dbMoveCount)),
		cacheSet(moveSeqKey, Math.max(0, dbMoveSeq)),
	]);
}

function parseIncrementSeconds(value) {
	const numeric = Number(String(value ?? "").trim());
	if (!Number.isFinite(numeric) || numeric < 0) {
		return 0;
	}

	return Math.max(0, Math.round(numeric));
}

function parseDropMove(moveUci) {
	const match = normalizeText(moveUci).toLowerCase().match(MOVE_DROP_UCI_PATTERN);
	if (!match) {
		return null;
	}

	return {
		pieceType: match[1],
		square: match[2],
	};
}

async function warmLiveGameState(gameId, queryExecutor = pool) {
	const normalizedGameId = normalizeId(gameId);
	if (!normalizedGameId) {
		return;
	}

	await Promise.all([
		ensureLiveBoardFen({ gameId: normalizedGameId, boardNumber: 1 }, queryExecutor),
		ensureLiveBoardFen({ gameId: normalizedGameId, boardNumber: 2 }, queryExecutor),
		ensureLiveCounters({ gameId: normalizedGameId }, queryExecutor),
		ensureLiveClockState({ gameId: normalizedGameId }, queryExecutor),
	]);
}

async function invalidateLiveGameCache(gameId) {
	const normalizedGameId = normalizeId(gameId);
	if (!normalizedGameId) {
		return;
	}

	for (const [key, value] of teamMemberContextCache) {
		if (value.data?.game_id === normalizedGameId) teamMemberContextCache.delete(key);
	}
	for (const key of oppositeMemberCache.keys()) {
		if (key.startsWith(`${normalizedGameId}:`)) oppositeMemberCache.delete(key);
	}

	await cacheDel([
		getFenKey(normalizedGameId, 1),
		getFenKey(normalizedGameId, 2),
		getGameStateKey(normalizedGameId),
		getMoveSeqKey(normalizedGameId),
		getMoveCountKey(normalizedGameId),
	]);
}

async function processPersistenceQueue() {
	if (workerInFlight || persistenceQueue.length === 0) {
		return;
	}

	workerInFlight = true;

	try {
		while (persistenceQueue.length > 0) {
			const next = persistenceQueue.shift();

			if (!next) {
				continue;
			}

			try {
				await createMove({
					team_member_id: next.team_member_id,
					move_uci: next.move_uci,
					captured_piece: next.captured_piece,
					acting_user_id: next.acting_user_id,
				});

				const liveClockSnapshot = next.live_clock_snapshot;
				if (liveClockSnapshot && typeof liveClockSnapshot === "object") {
					const gameId = normalizeId(next.game_id);
					const moveCount = parseReserveQuantity(liveClockSnapshot.move_count);
					const activeBoard1TeamMemberId = normalizeId(liveClockSnapshot.active_board1_team_member_id);
					const activeBoard2TeamMemberId = normalizeId(liveClockSnapshot.active_board2_team_member_id);
					const clockLastSyncedAt = toIsoTimestamp(liveClockSnapshot.clock_last_synced_at);
					const remainingEntries = Object.entries(liveClockSnapshot.remaining_seconds_by_member ?? {})
						.map(([teamMemberId, remainingSeconds]) => ({
							teamMemberId: normalizeId(teamMemberId),
							remainingSeconds: parseReserveQuantity(remainingSeconds),
						}))
						.filter((entry) => Boolean(entry.teamMemberId));

					if (gameId) {
						// Guard against a race where a concurrent HTTP move (e.g. a bot move) has
						// already advanced move_count beyond this snapshot. Overwriting
						// active_board{n}_team_member_id or clock_last_synced_at with stale values
						// causes the page-refresh timer to snap back to the initial/default time.
						const { rowCount: gamesUpdated } = await pool.query(
							`UPDATE gameplay.games
							 SET move_count = $2,
								 clock_last_synced_at = $3,
								 active_board1_team_member_id = $4,
								 active_board2_team_member_id = $5
							 WHERE game_id = $1
							   AND COALESCE(move_count, 0) <= $2`,
							[
								gameId,
								moveCount,
								clockLastSyncedAt,
								activeBoard1TeamMemberId,
								activeBoard2TeamMemberId,
							]
						);

						// Only overwrite remaining_seconds when the games row was also updated,
						// i.e. this snapshot is still the most recent one in DB.
						if (gamesUpdated > 0 && remainingEntries.length > 0) {
							const teamMemberIds = remainingEntries.map((entry) => entry.teamMemberId);
							const remainingValues = remainingEntries.map((entry) => entry.remainingSeconds);

							await pool.query(
								`UPDATE gameplay.team_members tm
								 SET remaining_seconds = src.remaining_seconds
								 FROM (
									SELECT
										UNNEST($1::int[]) AS team_member_id,
										UNNEST($2::int[]) AS remaining_seconds
								 ) AS src
								 WHERE tm.team_member_id = src.team_member_id`,
								[teamMemberIds, remainingValues]
							);
						}

						if (DEBUG_LIVE_CLOCK) {
							console.log("[clock:persist-worker]", {
								gameId,
								moveCount,
								clockLastSyncedAt,
								activeBoard1TeamMemberId,
								activeBoard2TeamMemberId,
								remainingSeconds: remainingEntries,
								gamesUpdated,
							});
						}
					}
				}
			} catch (error) {
				if (error?.code === "GAME_ALREADY_FINISHED" || error?.code === "GAME_NOT_STARTED") {
					teamMemberContextCache.delete(next.team_member_id);
				}
				console.error("[live-move-persist] Failed to persist move", {
					gameId: next.game_id,
					teamMemberId: next.team_member_id,
					moveUci: next.move_uci,
					errorCode: error?.code ?? null,
					errorMessage: error?.message ?? "Unknown error",
				});
			}
		}
	} finally {
		workerInFlight = false;
	}
}

export function startLiveMovePersistenceWorker() {
	if (workerStarted) {
		return;
	}

	workerStarted = true;
	setInterval(() => {
		void processPersistenceQueue();
	}, 50);

	console.log(
		hasRedisConfig
			? "[live-move] Redis live pipeline enabled"
			: "[live-move] Redis config missing, using in-memory fallback"
	);
}

export async function submitLiveSocketMove({ team_member_id, move_uci, captured_piece, acting_user_id }) {
	const normalizedTeamMemberId = normalizeId(team_member_id);
	const normalizedMoveUci = normalizeText(move_uci).toLowerCase();
	const normalizedCapturedPiece = normalizeText(captured_piece).toLowerCase();
	const dropMove = parseDropMove(normalizedMoveUci);

	if (!normalizedTeamMemberId) {
		const error = new Error("team_member_id must be a valid positive integer");
		error.code = "INVALID_TEAM_MEMBER_ID";
		throw error;
	}

	if (!normalizedMoveUci) {
		const error = new Error("move_uci is required");
		error.code = "MOVE_UCI_REQUIRED";
		throw error;
	}

	if (!dropMove && !MOVE_UCI_PATTERN.test(normalizedMoveUci)) {
		const error = new Error("move_uci must be valid UCI format");
		error.code = "INVALID_MOVE_UCI";
		throw error;
	}

	const teamMember = await getTeamMemberContext(normalizedTeamMemberId, pool);
	await ensureMoveActorAccess({ teamMember, actingUserId: acting_user_id });

	if (!teamMember.joined_at) {
		const error = new Error("Team member has not joined yet");
		error.code = "TEAM_MEMBER_NOT_JOINED";
		throw error;
	}

	const gameStatus = normalizeText(teamMember.status).toLowerCase();
	if (gameStatus === "finished") {
		const error = new Error("Game is already finished");
		error.code = "GAME_ALREADY_FINISHED";
		throw error;
	}

	if (gameStatus !== "started") {
		const error = new Error("Game is not started");
		error.code = "GAME_NOT_STARTED";
		throw error;
	}

	await ensureLiveCounters({ gameId: teamMember.game_id }, pool);

	const boardNumber = Number(teamMember.board_number);
	const boardFen = await ensureLiveBoardFen({ gameId: teamMember.game_id, boardNumber }, pool);
	let finalCapturedPiece = normalizedCapturedPiece || null;
	let fenAfterMove = "";
	const reserveUpdates = [];

	if (dropMove) {
		const dropRank = Number(dropMove.square[1]);
		if (dropMove.pieceType === "p" && (dropRank === 1 || dropRank === 8)) {
			const error = new Error("Pawns cannot be dropped on the first or eighth rank");
			error.code = "INVALID_DROP_SQUARE_FOR_PAWN";
			throw error;
		}

		const chess = new Chess();
		chess.load(boardFen);

		const expectedTurn = normalizeText(teamMember.piece_color).toLowerCase() === "white" ? "w" : "b";
		if (chess.turn() !== expectedTurn) {
			const requiredColor = chess.turn() === "w" ? "white" : "black";
			const error = new Error(`It is ${requiredColor}'s turn on this board`);
			error.code = "TURN_MISMATCH";
			throw error;
		}

		if (chess.get(dropMove.square)) {
			const error = new Error("Drop square is occupied");
			error.code = "DROP_SQUARE_OCCUPIED";
			throw error;
		}

		const reserveMap = await ensureLiveReserveMap({ gameId: teamMember.game_id, teamMemberId: normalizedTeamMemberId }, pool);
		const availableQuantity = parseReserveQuantity(reserveMap[dropMove.pieceType]);
		if (availableQuantity <= 0) {
			const error = new Error(`No ${dropMove.pieceType} piece available in reserve for this team member`);
			error.code = "RESERVE_PIECE_NOT_AVAILABLE";
			throw error;
		}

		chess.put({ type: dropMove.pieceType, color: expectedTurn }, dropMove.square);
		const fenParts = chess.fen().split(" ");
		fenParts[1] = expectedTurn === "w" ? "b" : "w";
		fenParts[3] = "-";
		fenParts[4] = String(Number(fenParts[4]) + 1);
		if (expectedTurn === "b") {
			fenParts[5] = String(Number(fenParts[5]) + 1);
		}

		fenAfterMove = fenParts.join(" ");
		reserveMap[dropMove.pieceType] = availableQuantity - 1;
		await hashSet(getReserveKey(teamMember.game_id, normalizedTeamMemberId), {
			[dropMove.pieceType]: reserveMap[dropMove.pieceType],
		});

		reserveUpdates.push({
			team_member_id: normalizedTeamMemberId,
			piece_type: dropMove.pieceType,
			change: -1,
		});

		finalCapturedPiece = null;
	} else {
		const validationResult = validateMoveOnFenBoard({
			currentFen: boardFen,
			nextUciMove: normalizedMoveUci,
			expectedPieceColor: teamMember.piece_color,
		});

		const derivedCapturedPiece = normalizeText(validationResult.capturedPiece).toLowerCase() || null;
		if (finalCapturedPiece && finalCapturedPiece !== derivedCapturedPiece) {
			const error = new Error("captured_piece does not match actual captured piece on board");
			error.code = "CAPTURED_PIECE_MISMATCH";
			throw error;
		}

		finalCapturedPiece = finalCapturedPiece ?? derivedCapturedPiece;
		fenAfterMove = validationResult.fenAfterMove;
	}

	const oppositeMemberId = await getOppositeColorTeamMemberId({
		gameId: teamMember.game_id,
		boardNumber,
		pieceColor: teamMember.piece_color,
	}, pool);

	const nextMoveNumber = await incrementCounter(getMoveCountKey(teamMember.game_id));
	const syntheticMoveId = await incrementCounter(getMoveSeqKey(teamMember.game_id));
	const clockNowMs = Date.now();
	const clockState = await ensureLiveClockState({ gameId: teamMember.game_id }, pool);

	consumeElapsedActiveClockSeconds(clockState, clockNowMs);

	const timedOutMemberId = [
		normalizeId(clockState.active_board1_team_member_id),
		normalizeId(clockState.active_board2_team_member_id),
	]
		.filter(Boolean)
		.find((memberId) => {
			const remaining = parseReserveQuantity(clockState.remaining_seconds_by_member?.[memberId]);
			return remaining <= 0;
		});

	if (timedOutMemberId) {
		await persistLiveClockState(teamMember.game_id, clockState);
		const finishedGame = await finishGameByTimeout(teamMember.game_id, timedOutMemberId, pool);
		const error = new Error("Game timed out");
		error.code = "GAME_TIMEOUT";
		error.game = finishedGame;
		throw error;
	}

	if (DEBUG_LIVE_CLOCK) {
		console.log("[clock:before-move]", {
			gameId: teamMember.game_id,
			teamMemberId: normalizedTeamMemberId,
			boardNumber,
			moveUci: normalizedMoveUci,
			clockLastSyncedAt: clockState.clock_last_synced_at,
			remainingSeconds: { ...clockState.remaining_seconds_by_member },
		});
	}

	const movingMemberId = normalizeId(normalizedTeamMemberId);
	const movingMemberClock = parseReserveQuantity(clockState.remaining_seconds_by_member[movingMemberId]);
	const incrementSeconds = parseIncrementSeconds(teamMember.increment);

	clockState.remaining_seconds_by_member[movingMemberId] = movingMemberClock + incrementSeconds;
	clockState.active_board1_team_member_id = boardNumber === 1
		? normalizeId(oppositeMemberId)
		: normalizeId(clockState.active_board1_team_member_id ?? teamMember.active_board1_team_member_id);
	clockState.active_board2_team_member_id = boardNumber === 2
		? normalizeId(oppositeMemberId)
		: normalizeId(clockState.active_board2_team_member_id ?? teamMember.active_board2_team_member_id);
	clockState.move_count = nextMoveNumber;
	clockState.state_version = nextMoveNumber;
	clockState.clock_last_synced_at = new Date(clockNowMs).toISOString();

	const liveClockSnapshot = {
		remaining_seconds_by_member: { ...clockState.remaining_seconds_by_member },
		active_board1_team_member_id: normalizeId(clockState.active_board1_team_member_id),
		active_board2_team_member_id: normalizeId(clockState.active_board2_team_member_id),
		move_count: nextMoveNumber,
		clock_last_synced_at: clockState.clock_last_synced_at,
		state_version: nextMoveNumber,
	};

	await Promise.all([
		cacheSet(getFenKey(teamMember.game_id, boardNumber), fenAfterMove),
		persistLiveClockState(teamMember.game_id, clockState),
	]);

	if (DEBUG_LIVE_CLOCK) {
		console.log("[clock:after-move]", {
			gameId: teamMember.game_id,
			teamMemberId: normalizedTeamMemberId,
			boardNumber,
			moveUci: normalizedMoveUci,
			moveNumber: nextMoveNumber,
			clockLastSyncedAt: clockState.clock_last_synced_at,
			remainingSeconds: { ...clockState.remaining_seconds_by_member },
		});
	}

	persistenceQueue.push({
		game_id: teamMember.game_id,
		team_member_id: normalizedTeamMemberId,
		move_uci: normalizedMoveUci,
		captured_piece: finalCapturedPiece,
		acting_user_id,
		live_clock_snapshot: liveClockSnapshot,
	});
	// Flush immediately so bots can find this move in DB without waiting for the 50ms interval
	void processPersistenceQueue();

	if (finalCapturedPiece) {
		const capturedSymbol = Object.entries(PIECE_NAME_BY_SYMBOL)
			.find(([, name]) => name === finalCapturedPiece)?.[0] ?? null;

		if (capturedSymbol) {
			const teammateReserveResult = await pool.query(
				`SELECT tm.team_member_id
				 FROM gameplay.team_members tm
				 WHERE tm.team_id = $1
				   AND tm.team_member_id <> $2
				 LIMIT 1`,
				[teamMember.team_id, normalizedTeamMemberId]
			);

			const teammateId = normalizeId(teammateReserveResult.rows[0]?.team_member_id);
			if (teammateId) {
				const teammateReserveKey = getReserveKey(teamMember.game_id, teammateId);
				const teammateReserveMap = await ensureLiveReserveMap({ gameId: teamMember.game_id, teamMemberId: teammateId }, pool);
				const currentQuantity = parseReserveQuantity(teammateReserveMap[capturedSymbol]);
				await hashSet(teammateReserveKey, {
					[capturedSymbol]: currentQuantity + 1,
				});

				reserveUpdates.push({
					team_member_id: teammateId,
					piece_type: capturedSymbol,
					change: 1,
				});
			}
		}
	}

	let finishedGame = null;
	const defendingReservePieces = await getReservePieceTypesByTeamMemberId(oppositeMemberId, pool);
	if (isBughouseCheckmateFen(fenAfterMove, defendingReservePieces)) {
		finishedGame = await finishGameByCheckmate({
			gameId: teamMember.game_id,
			winnerTeamId: teamMember.team_id,
			winnerTeamName: teamMember.team_name,
		}, pool);
	}

	return {
		move: {
			move_id: syntheticMoveId,
			team_member_id: normalizedTeamMemberId,
			move_number: nextMoveNumber,
			move_uci: normalizedMoveUci,
			captured_piece: finalCapturedPiece,
			fen_after_move: fenAfterMove,
			game_id: teamMember.game_id,
			board_number: boardNumber,
			piece_color: teamMember.piece_color,
			user_id: teamMember.user_id,
			is_bot: Boolean(teamMember.is_bot),
			reserve_updates: reserveUpdates,
			state_version: nextMoveNumber,
			live: true,
			game: finishedGame,
		},
		gamePatch: {
			active_board1_team_member_id: normalizeId(clockState.active_board1_team_member_id),
			active_board2_team_member_id: normalizeId(clockState.active_board2_team_member_id),
			move_count: nextMoveNumber,
			clock_last_synced_at: clockState.clock_last_synced_at,
			remaining_seconds_by_member: liveClockSnapshot.remaining_seconds_by_member,
			state_version: nextMoveNumber,
		},
		liveClockSnapshot,
	};
}

export { warmLiveGameState, invalidateLiveGameCache };