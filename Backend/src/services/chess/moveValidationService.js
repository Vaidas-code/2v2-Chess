import { Chess } from "chess.js";

const HISTORICAL_DROP_PATTERN = /^@([pnbrq])([a-h][1-8])$/i;

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

function toMoveObjectFromUci(uciMove) {
	return {
		from: uciMove.slice(0, 2),
		to: uciMove.slice(2, 4),
		promotion: uciMove.length === 5 ? uciMove[4] : undefined,
	};
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

export function validateMoveOnDefaultBoard({ historicalUciMoves, nextUciMove, expectedPieceColor }) {
	const chess = new Chess();

	applyHistoricalMoves(chess, historicalUciMoves);
	validateExpectedPieceColor(chess, expectedPieceColor);

	let moveResult = null;

	try {
		moveResult = chess.move(toMoveObjectFromUci(nextUciMove));
	} catch {
		moveResult = null;
	}

	if (!moveResult) {
		const error = new Error("Illegal move for current board state");
		error.code = "ILLEGAL_MOVE";
		throw error;
	}

	const capturedPiece = moveResult.captured ? PIECE_NAME_BY_SYMBOL[moveResult.captured] ?? null : null;

	return {
		capturedPiece,
		fenAfterMove: chess.fen(),
	};
}

export function validateMoveOnFenBoard({ currentFen, nextUciMove, expectedPieceColor }) {
	const chess = new Chess();
	const fenToLoad = typeof currentFen === "string" ? currentFen.trim() : "";

	if (fenToLoad) {
		const loaded = chess.load(fenToLoad);

		if (!loaded) {
			const error = new Error("Stored board snapshot is invalid");
			error.code = "HISTORICAL_MOVE_INVALID";
			throw error;
		}
	}

	validateExpectedPieceColor(chess, expectedPieceColor);

	let moveResult = null;

	try {
		moveResult = chess.move(toMoveObjectFromUci(nextUciMove));
	} catch {
		moveResult = null;
	}

	if (!moveResult) {
		const error = new Error("Illegal move for current board state");
		error.code = "ILLEGAL_MOVE";
		throw error;
	}

	const capturedPiece = moveResult.captured ? PIECE_NAME_BY_SYMBOL[moveResult.captured] ?? null : null;

	return {
		capturedPiece,
		fenAfterMove: chess.fen(),
	};
}
