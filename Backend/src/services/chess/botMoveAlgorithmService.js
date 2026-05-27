import { Chess } from "chess.js";

const PIECE_NAME_BY_SYMBOL = {
	p: "pawn",
	n: "knight",
	b: "bishop",
	r: "rook",
	q: "queen",
	k: "king",
};

const TURN_BY_PIECE_COLOR = {
	white: "w",
	black: "b",
};

const PIECE_VALUE_BY_SYMBOL = {
	p: 100,
	n: 320,
	b: 330,
	r: 500,
	q: 900,
	k: 20000,
};

const SEARCH_MAX_DEPTH = 5;
const SEARCH_TIME_BUDGET_MS = 650;
const INFINITY_SCORE = 1_000_000_000;
const MATE_SCORE = 100_000_000; 
const FORCED_FIRST_WHITE_BOT_MOVE_UCI = "e2e4";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const DROP_MIN_GAIN_OVER_REGULAR = 100;
const HISTORICAL_DROP_PATTERN = /^@([pnbrq])([a-h][1-8])$/i;

class SearchTimeoutError extends Error {
	constructor() {
		super("Search timed out");
		this.code = "SEARCH_TIMEOUT";
	}
}

function toMoveObjectFromUci(uciMove) {
	return {
		from: uciMove.slice(0, 2),
		to: uciMove.slice(2, 4),
		promotion: uciMove.length === 5 ? uciMove[4] : undefined,
	};
}

function toUciFromMoveObject(moveObject) {
	return `${moveObject.from}${moveObject.to}${moveObject.promotion ?? ""}`;
}

function getTranspositionKey(chess) {
	return chess.fen();
}

function createSearchContext() {
	const deadlineAt = Date.now() + SEARCH_TIME_BUDGET_MS;

	return {
		deadlineAt,
		shouldStop: () => Date.now() >= deadlineAt,
		transpositionTable: new Map(),
		historyHeuristic: new Map(),
		killerMovesByPly: [],
	};
}

function getTerminalScore(chess, rootTurn, ply) {
	if (chess.isCheckmate()) {
		const losingTurn = chess.turn();
		return losingTurn === rootTurn ? -MATE_SCORE + ply : MATE_SCORE - ply;
	}

	if (chess.isDraw()) {
		return 0;
	}

	return null;
}

function getSquareCentralizationScore(rowIndex, columnIndex) {
	const fileDistance = Math.abs(3.5 - columnIndex);
	const rankDistance = Math.abs(3.5 - rowIndex);
	return (3.5 - fileDistance) + (3.5 - rankDistance);
}

function getPawnAdvancement(rowIndex, pieceColor) {
	if (pieceColor === "w") {
		return Math.max(0, 6 - rowIndex);
	}

	return Math.max(0, rowIndex - 1);
}

function evaluatePosition(chess, rootTurn) {
	const terminalScore = getTerminalScore(chess, rootTurn, 0);

	if (terminalScore !== null) {
		return terminalScore;
	}

	const board = chess.board();
	const pieces = [];
	let nonPawnMaterial = 0;

	for (let rowIndex = 0; rowIndex < board.length; rowIndex += 1) {
		for (let columnIndex = 0; columnIndex < board[rowIndex].length; columnIndex += 1) {
			const piece = board[rowIndex][columnIndex];

			if (!piece) {
				continue;
			}

			const pieceValue = PIECE_VALUE_BY_SYMBOL[piece.type] ?? 0;

			if (piece.type !== "p" && piece.type !== "k") {
				nonPawnMaterial += pieceValue;
			}

			pieces.push({ piece, rowIndex, columnIndex, pieceValue });
		}
	}

	const isEndgame = nonPawnMaterial <= 2400;
	let score = 0;

	for (let index = 0; index < pieces.length; index += 1) {
		const { piece, rowIndex, columnIndex, pieceValue } = pieces[index];
		const centralization = getSquareCentralizationScore(rowIndex, columnIndex);
		let positionalBonus = 0;

		switch (piece.type) {
			case "p":
				positionalBonus = getPawnAdvancement(rowIndex, piece.color) * 12 + centralization * 2;
				break;
			case "n":
				positionalBonus = centralization * 14;
				break;
			case "b":
				positionalBonus = centralization * 10;
				break;
			case "r":
				positionalBonus = centralization * 4;
				break;
			case "q":
				positionalBonus = centralization * 4;
				break;
			case "k":
				positionalBonus = isEndgame ? centralization * 8 : -centralization * 6;
				break;
			default:
				positionalBonus = 0;
		}

		const signedValue = piece.color === rootTurn ? 1 : -1;
		score += signedValue * (pieceValue + positionalBonus);
	}

	if (chess.isCheck()) {
		score += chess.turn() === rootTurn ? -35 : 35;
	}

	return score;
}

function evaluateCaptureOrdering(move) {
	if (!move.captured) {
		return 0;
	}

	const capturedValue = PIECE_VALUE_BY_SYMBOL[move.captured] ?? 0;
	const attackerValue = PIECE_VALUE_BY_SYMBOL[move.piece] ?? 1;
	return capturedValue * 16 - attackerValue;
}

function registerKillerMove(searchContext, ply, moveUci) {
	if (!searchContext.killerMovesByPly[ply]) {
		searchContext.killerMovesByPly[ply] = [null, null];
	}

	const [primaryKiller, secondaryKiller] = searchContext.killerMovesByPly[ply];

	if (primaryKiller === moveUci) {
		return;
	}

	searchContext.killerMovesByPly[ply] = [moveUci, primaryKiller ?? secondaryKiller ?? null];
}

function registerHistoryScore(searchContext, moveUci, depth) {
	const currentValue = searchContext.historyHeuristic.get(moveUci) ?? 0;
	const bonus = depth * depth;
	searchContext.historyHeuristic.set(moveUci, currentValue + bonus);
}

function orderMoves({ moves, preferredMoveUci, ttBestMoveUci, searchContext, ply }) {
	const killers = searchContext.killerMovesByPly[ply] ?? [null, null];

	const scoredMoves = moves.map((move) => {
		const moveUci = toUciFromMoveObject(move);
		let score = 0;

		if (preferredMoveUci && moveUci === preferredMoveUci) {
			score += 2_000_000_000;
		}

		if (ttBestMoveUci && moveUci === ttBestMoveUci) {
			score += 1_500_000_000;
		}

		if (killers[0] && moveUci === killers[0]) {
			score += 900_000_000;
		} else if (killers[1] && moveUci === killers[1]) {
			score += 800_000_000;
		}

		if (move.captured) {
			score += 600_000_000 + evaluateCaptureOrdering(move);
		}

		if (move.promotion) {
			score += 500_000_000 + (PIECE_VALUE_BY_SYMBOL[move.promotion] ?? 0);
		}

		if (typeof move.san === "string" && (move.san.includes("#") || move.san.includes("+"))) {
			score += 300_000_000;
		}

		score += searchContext.historyHeuristic.get(moveUci) ?? 0;

		return { move, moveUci, score };
	});

	scoredMoves.sort((left, right) => {
		if (right.score !== left.score) {
			return right.score - left.score;
		}

		return left.moveUci.localeCompare(right.moveUci);
	});

	return scoredMoves.map((entry) => entry.move);
}

function alphaBetaMinimax({
	chess,
	depth,
	alpha,
	beta,
	maximizingForRoot,
	rootTurn,
	ply,
	searchContext,
	preferredMovesByPly,
}) {
	if (searchContext.shouldStop()) {
		throw new SearchTimeoutError();
	}

	const terminalScore = getTerminalScore(chess, rootTurn, ply);

	if (terminalScore !== null) {
		return terminalScore;
	}

	if (depth === 0) {
		return evaluatePosition(chess, rootTurn);
	}

	const transpositionKey = getTranspositionKey(chess);
	const originalAlpha = alpha;
	const originalBeta = beta;
	const cachedEntry = searchContext.transpositionTable.get(transpositionKey);

	if (cachedEntry && cachedEntry.depth >= depth) {
		if (cachedEntry.flag === "EXACT") {
			return cachedEntry.score;
		}

		if (cachedEntry.flag === "LOWER_BOUND") {
			alpha = Math.max(alpha, cachedEntry.score);
		} else if (cachedEntry.flag === "UPPER_BOUND") {
			beta = Math.min(beta, cachedEntry.score);
		}

		if (alpha >= beta) {
			return cachedEntry.score;
		}
	}

	const legalMoves = chess.moves({ verbose: true });
	const orderedMoves = orderMoves({
		moves: legalMoves,
		preferredMoveUci: preferredMovesByPly[ply] ?? null,
		ttBestMoveUci: cachedEntry?.bestMoveUci ?? null,
		searchContext,
		ply,
	});

	let bestScore = maximizingForRoot ? -INFINITY_SCORE : INFINITY_SCORE;
	let bestMoveUci = null;

	for (let index = 0; index < orderedMoves.length; index += 1) {
		if (searchContext.shouldStop()) {
			throw new SearchTimeoutError();
		}

		const move = orderedMoves[index];
		const moveUci = toUciFromMoveObject(move);

		chess.move(move);
		let childScore;

		try {
			childScore = alphaBetaMinimax({
				chess,
				depth: depth - 1,
				alpha,
				beta,
				maximizingForRoot: !maximizingForRoot,
				rootTurn,
				ply: ply + 1,
				searchContext,
				preferredMovesByPly,
			});
		} finally {
			chess.undo();
		}

		if (maximizingForRoot) {
			if (childScore > bestScore) {
				bestScore = childScore;
				bestMoveUci = moveUci;
			}

			alpha = Math.max(alpha, bestScore);
		} else {
			if (childScore < bestScore) {
				bestScore = childScore;
				bestMoveUci = moveUci;
			}

			beta = Math.min(beta, bestScore);
		}

		if (alpha >= beta) {
			if (!move.captured && !move.promotion) {
				registerKillerMove(searchContext, ply, moveUci);
				registerHistoryScore(searchContext, moveUci, depth);
			}

			break;
		}
	}

	let flag = "EXACT";

	if (bestScore <= originalAlpha) {
		flag = "UPPER_BOUND";
	} else if (bestScore >= originalBeta) {
		flag = "LOWER_BOUND";
	}

	searchContext.transpositionTable.set(transpositionKey, {
		depth,
		score: bestScore,
		flag,
		bestMoveUci,
	});

	return bestScore;
}

function extractPrincipalVariation({ chess, depth, searchContext }) {
	const principalVariation = [];
	const appliedMoveCount = [];

	for (let ply = 0; ply < depth; ply += 1) {
		const entry = searchContext.transpositionTable.get(getTranspositionKey(chess));

		if (!entry?.bestMoveUci) {
			break;
		}

		let appliedMove = null;

		try {
			appliedMove = chess.move(toMoveObjectFromUci(entry.bestMoveUci));
		} catch {
			appliedMove = null;
		}

		if (!appliedMove) {
			break;
		}

		principalVariation.push(entry.bestMoveUci);
		appliedMoveCount.push(1);
	}

	while (appliedMoveCount.length > 0) {
		chess.undo();
		appliedMoveCount.pop();
	}

	return principalVariation;
}

function searchBestMoveForDepth({ chess, depth, rootTurn, searchContext, preferredMovesByPly }) {
	if (searchContext.shouldStop()) {
		throw new SearchTimeoutError();
	}

	const legalMoves = chess.moves({ verbose: true });
	const rootCacheEntry = searchContext.transpositionTable.get(getTranspositionKey(chess));
	const orderedMoves = orderMoves({
		moves: legalMoves,
		preferredMoveUci: preferredMovesByPly[0] ?? null,
		ttBestMoveUci: rootCacheEntry?.bestMoveUci ?? null,
		searchContext,
		ply: 0,
	});

	let bestMove = orderedMoves[0] ?? null;
	let bestScore = -INFINITY_SCORE;
	let alpha = -INFINITY_SCORE;
	const beta = INFINITY_SCORE;

	for (let index = 0; index < orderedMoves.length; index += 1) {
		if (searchContext.shouldStop()) {
			throw new SearchTimeoutError();
		}

		const move = orderedMoves[index];
		const moveUci = toUciFromMoveObject(move);

		chess.move(move);
		let score;

		try {
			score = alphaBetaMinimax({
				chess,
				depth: depth - 1,
				alpha,
				beta,
				maximizingForRoot: false,
				rootTurn,
				ply: 1,
				searchContext,
				preferredMovesByPly,
			});
		} finally {
			chess.undo();
		}

		if (
			score > bestScore ||
			(score === bestScore && bestMove && moveUci.localeCompare(toUciFromMoveObject(bestMove)) < 0)
		) {
			bestScore = score;
			bestMove = move;
		}

		alpha = Math.max(alpha, bestScore);
	}

	if (!bestMove) {
		const error = new Error("No legal moves available for bot on this board");
		error.code = "NO_LEGAL_BOT_MOVE";
		throw error;
	}

	return {
		bestMove,
		bestScore,
	};
}

function findBestMoveWithIterativeDeepening(chess) {
	const rootTurn = chess.turn();
	const searchContext = createSearchContext();
	const legalMoves = chess.moves({ verbose: true });

	if (legalMoves.length === 0) {
		const error = new Error("No legal moves available for bot on this board");
		error.code = "NO_LEGAL_BOT_MOVE";
		throw error;
	}

	let preferredMovesByPly = [];
	let bestMove = legalMoves[0];
	let bestScore = -INFINITY_SCORE;

	for (let depth = 1; depth <= SEARCH_MAX_DEPTH; depth += 1) {
		if (searchContext.shouldStop()) {
			break;
		}

		try {
			const iterationResult = searchBestMoveForDepth({
				chess,
				depth,
				rootTurn,
				searchContext,
				preferredMovesByPly,
			});

			bestMove = iterationResult.bestMove;
			bestScore = iterationResult.bestScore;
			preferredMovesByPly = extractPrincipalVariation({ chess, depth, searchContext });

			if (Math.abs(bestScore) >= MATE_SCORE - 1000) {
				break;
			}
		} catch (error) {
			if (error instanceof SearchTimeoutError || error?.code === "SEARCH_TIMEOUT") {
				break;
			}

			throw error;
		}
	}

	return { bestMove, bestScore };
}

function generateValidDropSquares(chess, pieceType) {
	const board = chess.board();
	const squares = [];

	for (let rowIndex = 0; rowIndex < 8; rowIndex += 1) {
		const rank = 8 - rowIndex;

		if (pieceType === "p" && (rank === 1 || rank === 8)) {
			continue;
		}

		for (let columnIndex = 0; columnIndex < 8; columnIndex += 1) {
			if (board[rowIndex][columnIndex] !== null) {
				continue;
			}

			squares.push(`${FILES[columnIndex]}${rank}`);
		}
	}

	return squares;
}

function isLegalDropForCurrentTurn(chess, pieceType, square) {
	const chessCopy = new Chess(chess.fen());
	const currentTurn = chess.turn();
	const dropApplied = chessCopy.put({ type: pieceType, color: currentTurn }, square);

	if (!dropApplied) {
		return false;
	}

	return !chessCopy.isCheck();
}

function evaluateDropCandidate(chess, pieceType, square, color, rootTurn) {
	const chessCopy = new Chess(chess.fen());
	chessCopy.put({ type: pieceType, color }, square);
	return evaluatePosition(chessCopy, rootTurn);
}

function findBestDropMoveCandidate(chess, reservePieces, rootTurn) {
	const color = rootTurn;
	let bestDropScore = null;
	let bestDropUci = null;

	for (const pieceType of reservePieces) {
		const squares = generateValidDropSquares(chess, pieceType);

		for (const square of squares) {
			if (!isLegalDropForCurrentTurn(chess, pieceType, square)) {
				continue;
			}

			const score = evaluateDropCandidate(chess, pieceType, square, color, rootTurn);

			if (bestDropScore === null || score > bestDropScore) {
				bestDropScore = score;
				bestDropUci = `@${pieceType}${square}`;
			}
		}
	}

	return bestDropScore === null ? null : { dropUci: bestDropUci, score: bestDropScore };
}

function applyHistoricalMoves(chess, historicalUciMoves) {
	for (let index = 0; index < historicalUciMoves.length; index += 1) {
		const historicalMove = historicalUciMoves[index];

		const dropMatch = historicalMove.match(HISTORICAL_DROP_PATTERN);

		if (dropMatch) {
			const pieceType = dropMatch[1];
			const square = dropMatch[2];
			const rank = Number(square[1]);
			const currentTurn = chess.turn();

			if (pieceType === "p" && (rank === 1 || rank === 8)) {
				const error = new Error(`Stored move is invalid for board state: ${historicalMove}`);
				error.code = "HISTORICAL_MOVE_INVALID";
				throw error;
			}

			if (chess.get(square) != null) {
				const error = new Error(`Stored move is invalid for board state: ${historicalMove}`);
				error.code = "HISTORICAL_MOVE_INVALID";
				throw error;
			}

			const dropApplied = chess.put({ type: pieceType, color: currentTurn }, square);

			if (!dropApplied) {
				const error = new Error(`Stored move is invalid for board state: ${historicalMove}`);
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
			let appliedMove = null;

			try {
				appliedMove = chess.move(toMoveObjectFromUci(historicalMove));
			} catch {
				appliedMove = null;
			}

			if (!appliedMove) {
				const error = new Error(`Stored move is invalid for board state: ${historicalMove}`);
				error.code = "HISTORICAL_MOVE_INVALID";
				throw error;
			}
		}
	}
}

function validateExpectedPieceColor(chess, expectedPieceColor) {
	if (expectedPieceColor == null) {
		return;
	}

	const normalizedExpectedPieceColor = String(expectedPieceColor).trim().toLowerCase();
	const expectedTurn = TURN_BY_PIECE_COLOR[normalizedExpectedPieceColor];

	if (!expectedTurn) {
		const error = new Error("Invalid piece_color on team member");
		error.code = "INVALID_TEAM_MEMBER_PIECE_COLOR";
		throw error;
	}

	if (chess.turn() !== expectedTurn) {
		const requiredColor = chess.turn() === "w" ? "white" : "black";
		const error = new Error(`It is ${requiredColor}'s turn on this board`);
		error.code = "TURN_MISMATCH";
		throw error;
	}
}

function getForcedOpeningMoveIfApplicable(chess, historicalUciMoves, expectedPieceColor) {
	if (!Array.isArray(historicalUciMoves) || historicalUciMoves.length !== 0) {
		return null;
	}

	if (expectedPieceColor == null) {
		return null;
	}

	const normalizedExpectedPieceColor = String(expectedPieceColor).trim().toLowerCase();

	if (normalizedExpectedPieceColor !== "white") {
		return null;
	}

	let appliedMove = null;

	try {
		appliedMove = chess.move(toMoveObjectFromUci(FORCED_FIRST_WHITE_BOT_MOVE_UCI));
	} catch {
		appliedMove = null;
	}

	if (!appliedMove) {
		return null;
	}

	chess.undo();

	return {
		moveUci: FORCED_FIRST_WHITE_BOT_MOVE_UCI,
		capturedPiece: null,
	};
}

export function calculateBestBotMoveOnDefaultBoard({ historicalUciMoves, expectedPieceColor, reservePieces }) {
	const chess = new Chess();

	const normalizedHistoricalUciMoves = Array.isArray(historicalUciMoves) ? historicalUciMoves : [];
	const normalizedReservePieces = Array.isArray(reservePieces) ? reservePieces.filter(Boolean) : [];

	applyHistoricalMoves(chess, normalizedHistoricalUciMoves);
	validateExpectedPieceColor(chess, expectedPieceColor);

	const forcedOpeningMove = getForcedOpeningMoveIfApplicable(
		chess,
		normalizedHistoricalUciMoves,
		expectedPieceColor
	);

	if (forcedOpeningMove) {
		return forcedOpeningMove;
	}

	const rootTurn = chess.turn();
	let bestMove = null;
	let regularMoveDepth0Score = -INFINITY_SCORE;

	try {
		const standardSearchResult = findBestMoveWithIterativeDeepening(chess);
		bestMove = standardSearchResult.bestMove;
		chess.move(bestMove);
		regularMoveDepth0Score = evaluatePosition(chess, rootTurn);
		chess.undo();
	} catch (error) {
		if (error?.code !== "NO_LEGAL_BOT_MOVE") {
			throw error;
		}
	}

	if (normalizedReservePieces.length > 0) {
		const bestDrop = findBestDropMoveCandidate(chess, normalizedReservePieces, rootTurn);

		if (bestDrop !== null) {
			if (
				bestMove === null ||
				bestDrop.score >= regularMoveDepth0Score + DROP_MIN_GAIN_OVER_REGULAR
			) {
				return {
					moveUci: bestDrop.dropUci,
					capturedPiece: null,
				};
			}
		}
	}

	if (!bestMove) {
		const error = new Error("No legal moves available for bot on this board");
		error.code = "NO_LEGAL_BOT_MOVE";
		throw error;
	}

	return {
		moveUci: toUciFromMoveObject(bestMove),
		capturedPiece: bestMove.captured ? PIECE_NAME_BY_SYMBOL[bestMove.captured] ?? null : null,
	};
}
