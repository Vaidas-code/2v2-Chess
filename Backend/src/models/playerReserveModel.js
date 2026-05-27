import pool from "../config/db.js";

const RESERVE_PIECE_TYPE_BY_CAPTURED_PIECE = {
	pawn: "p",
	knight: "n",
	bishop: "b",
	rook: "r",
	queen: "q",
};

function normalizeCapturedPiece(capturedPiece) {
	if (typeof capturedPiece !== "string") {
		return "";
	}

	return capturedPiece.trim().toLowerCase();
}

function normalizeUserId(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim().toLowerCase();
}

async function findTeammateTeamMemberId({ teamId, teamMemberId }, queryExecutor = pool) {
	const teammateResult = await queryExecutor.query(
		`SELECT team_member_id
		 FROM gameplay.team_members
		 WHERE team_id = $1 AND team_member_id <> $2
		 ORDER BY team_member_id ASC
		 LIMIT 1`,
		[teamId, teamMemberId]
	);

	if (teammateResult.rowCount === 0) {
		const error = new Error("Teammate team member not found");
		error.code = "TEAMMATE_NOT_FOUND";
		throw error;
	}

	return teammateResult.rows[0].team_member_id;
}

export async function addCapturedPieceToTeammateReserve(
	{ teamId, teamMemberId, capturedPiece },
	queryExecutor = pool
) {
	const normalizedCapturedPiece = normalizeCapturedPiece(capturedPiece);

	if (!normalizedCapturedPiece) {
		return null;
	}

	const reservePieceType = RESERVE_PIECE_TYPE_BY_CAPTURED_PIECE[normalizedCapturedPiece];

	if (!reservePieceType) {
		const error = new Error("Captured piece cannot be added to reserve");
		error.code = "INVALID_CAPTURED_PIECE_FOR_RESERVE";
		throw error;
	}

	const teammateTeamMemberId = await findTeammateTeamMemberId(
		{ teamId, teamMemberId },
		queryExecutor
	);

	await queryExecutor.query(
		`INSERT INTO gameplay.player_reserves (team_member_id, piece_type, quantity)
		 VALUES ($1, $2, 1)
		 ON CONFLICT (team_member_id, piece_type)
		 DO UPDATE SET quantity = gameplay.player_reserves.quantity + 1`,
		[teammateTeamMemberId, reservePieceType]
	);

	return {
		team_member_id: teammateTeamMemberId,
		piece_type: reservePieceType,
	};
}

export async function getReservesByTeamMemberId(teamMemberId, queryExecutor = pool, options = {}) {
	const normalizedActingUserId = normalizeUserId(options?.acting_user_id);

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const memberCheck = await queryExecutor.query(
		`SELECT tm.team_member_id, t.game_id
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE tm.team_member_id = $1
		 LIMIT 1`,
		[teamMemberId]
	);

	if (memberCheck.rowCount === 0) {
		const error = new Error("Team member not found");
		error.code = "TEAM_MEMBER_NOT_FOUND";
		throw error;
	}

	const gameId = memberCheck.rows[0].game_id;

	const accessCheck = await queryExecutor.query(
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

	if (accessCheck.rowCount === 0) {
		const error = new Error("You do not have access to this game");
		error.code = "GAME_ACCESS_DENIED";
		throw error;
	}

	const result = await queryExecutor.query(
		`SELECT piece_type, quantity
		 FROM gameplay.player_reserves
		 WHERE team_member_id = $1
		 ORDER BY piece_type ASC`,
		[teamMemberId]
	);

	return {
		team_member_id: teamMemberId,
		reserves: result.rows,
	};
}
