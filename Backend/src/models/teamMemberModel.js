import pool from "../config/db.js";
import { findActiveGamesForUser } from "./gameParticipationModel.js";

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TEAM_MEMBER_SELECT_FIELDS =
	"team_member_id, team_id, user_id, is_bot, board_number, piece_color, joined_at, draw_offer_accepted, forfeit_offer_accepted";

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

async function ensureUserCanAccessGame({ userId, gameId }, queryExecutor = pool) {
	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
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
		[gameId, normalizedUserId]
	);

	if (accessResult.rowCount === 0) {
		const error = new Error("You do not have access to this game");
		error.code = "GAME_ACCESS_DENIED";
		throw error;
	}
}

async function getUserById(userId, queryExecutor = pool) {
	const result = await queryExecutor.query(
		"SELECT user_id FROM neon_auth.users WHERE user_id = $1 LIMIT 1",
		[userId]
	);

	if (result.rowCount === 0) {
		const error = new Error("User not found");
		error.code = "USER_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}

async function getBotUserByUsername(username, queryExecutor = pool) {
	const result = await queryExecutor.query(
		"SELECT user_id, username FROM neon_auth.users WHERE username = $1 LIMIT 1",
		[username]
	);

	if (result.rowCount === 0) {
		const error = new Error("Bot user not found");
		error.code = "BOT_USER_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}

async function getTeamMemberGameContext(teamMemberId, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT tm.team_member_id, t.game_id
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE tm.team_member_id = $1
		 LIMIT 1
		 FOR UPDATE`,
		[teamMemberId]
	);

	if (result.rowCount === 0) {
		const error = new Error("Team member not found");
		error.code = "TEAM_MEMBER_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}

async function ensureUserIsNotInDifferentActiveGame({ userId, targetGameId }, queryExecutor = pool) {
	const activeGames = await findActiveGamesForUser(userId, queryExecutor);
	const activeGameOutsideTarget = activeGames.find((game) => game.game_id !== Number(targetGameId));

	if (activeGameOutsideTarget) {
		const error = new Error("User is already in another active game");
		error.code = "USER_ALREADY_IN_ACTIVE_GAME";
		error.activeGameId = activeGameOutsideTarget.game_id;
		throw error;
	}
}

async function ensureUserIsNotAlreadyMemberInGame({ userId, gameId }, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT 1
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1
		   AND LOWER(COALESCE(tm.user_id::text, '')) = $2
		 LIMIT 1`,
		[gameId, normalizeUserId(userId)]
	);

	if (result.rowCount > 0) {
		const error = new Error("User is already in this active game");
		error.code = "USER_ALREADY_IN_ACTIVE_GAME";
		error.activeGameId = Number(gameId);
		throw error;
	}
}

async function releaseUserFromCurrentSlotsInGame(
	{ userId, gameId, targetTeamMemberId },
	queryExecutor = pool
) {
	await queryExecutor.query(
		`UPDATE gameplay.team_members tm
		 SET user_id = NULL,
		 	 is_bot = FALSE,
		 	 joined_at = NULL,
		 	 draw_offer_accepted = FALSE,
		 	 forfeit_offer_accepted = FALSE
		 FROM gameplay.teams t
		 JOIN gameplay.games g ON g.game_id = t.game_id
		 WHERE tm.team_id = t.team_id
		 	 AND t.game_id = $1
		 	 AND LOWER(COALESCE(tm.user_id::text, '')) = $2
		 	 AND tm.team_member_id <> $3
		 	 AND g.status IS DISTINCT FROM 'finished'`,
		[gameId, normalizeUserId(userId), targetTeamMemberId]
	);
}

async function updateTeamMemberSlotForHuman({ teamMemberId, userId }, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`UPDATE gameplay.team_members
		 SET user_id = $1::uuid,
		 	 is_bot = FALSE,
		 	 joined_at = COALESCE(joined_at, NOW())
		 WHERE team_member_id = $2
	 	 	 AND (user_id IS NULL OR LOWER(user_id::text) = LOWER(($1::uuid)::text))
		 RETURNING ${TEAM_MEMBER_SELECT_FIELDS}`,
		[userId, teamMemberId]
	);

	if (result.rowCount > 0) {
		return result.rows[0];
	}

	const slotResult = await queryExecutor.query(
		"SELECT team_member_id, user_id, joined_at FROM gameplay.team_members WHERE team_member_id = $1 LIMIT 1",
		[teamMemberId]
	);

	if (slotResult.rowCount === 0) {
		const error = new Error("Team member not found");
		error.code = "TEAM_MEMBER_NOT_FOUND";
		throw error;
	}

	const error = new Error("Team member slot is already taken");
	error.code = "TEAM_MEMBER_ALREADY_JOINED";
	throw error;
}

async function updateAvailableTeamMember({ teamMemberId, userId, isBot }, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`UPDATE gameplay.team_members
		 SET user_id   = $1::uuid,
		     is_bot    = $2,
		     joined_at = NOW()
		 WHERE team_member_id = $3
		   AND user_id IS NULL
		   AND joined_at IS NULL
		 RETURNING ${TEAM_MEMBER_SELECT_FIELDS}`,
		[userId, isBot, teamMemberId]
	);

	if (result.rowCount > 0) {
		return result.rows[0];
	}

	const slotResult = await queryExecutor.query(
		"SELECT team_member_id, user_id, joined_at FROM gameplay.team_members WHERE team_member_id = $1 LIMIT 1",
		[teamMemberId]
	);

	if (slotResult.rowCount === 0) {
		const error = new Error("Team member not found");
		error.code = "TEAM_MEMBER_NOT_FOUND";
		throw error;
	}

	const error = new Error("Team member slot is already taken");
	error.code = "TEAM_MEMBER_ALREADY_JOINED";
	throw error;
}

export async function joinTeamMember({ team_member_id, user_id }, queryExecutor = pool) {
	const normalizedTeamMemberId = normalizeId(team_member_id);

	if (normalizedTeamMemberId === null) {
		const error = new Error("team_member_id must be a valid positive integer");
		error.code = "INVALID_TEAM_MEMBER_ID";
		throw error;
	}

	const normalizedUserId = normalizeText(user_id);

	if (!normalizedUserId) {
		const error = new Error("user_id is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	if (!UUID_PATTERN.test(normalizedUserId)) {
		const error = new Error("user_id must be a valid UUID");
		error.code = "INVALID_USER_ID";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		await getUserById(normalizedUserId, executor);
		const teamMemberGameContext = await getTeamMemberGameContext(normalizedTeamMemberId, executor);

		await ensureUserIsNotInDifferentActiveGame(
			{ userId: normalizedUserId, targetGameId: teamMemberGameContext.game_id },
			executor
		);

		await releaseUserFromCurrentSlotsInGame(
			{
				userId: normalizedUserId,
				gameId: teamMemberGameContext.game_id,
				targetTeamMemberId: normalizedTeamMemberId,
			},
			executor
		);

		const updatedMember = await updateTeamMemberSlotForHuman(
			{ teamMemberId: normalizedTeamMemberId, userId: normalizedUserId },
			executor
		);

		if (client) await client.query("COMMIT");

		return {
			...updatedMember,
			game_id: teamMemberGameContext.game_id,
		};
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function joinBotTeamMember({ team_member_id, username, acting_user_id }, queryExecutor = pool) {
	const normalizedTeamMemberId = normalizeId(team_member_id);

	if (normalizedTeamMemberId === null) {
		const error = new Error("team_member_id must be a valid positive integer");
		error.code = "INVALID_TEAM_MEMBER_ID";
		throw error;
	}

	const normalizedUsername = normalizeText(username);

	if (!normalizedUsername) {
		const error = new Error("username is required");
		error.code = "USERNAME_REQUIRED";
		throw error;
	}

	if (!normalizedUsername.endsWith("_BOT")) {
		const error = new Error("username must end with _BOT");
		error.code = "INVALID_BOT_USERNAME";
		throw error;
	}

	const botUser = await getBotUserByUsername(normalizedUsername, queryExecutor);
	const teamMemberGameContext = await getTeamMemberGameContext(normalizedTeamMemberId, queryExecutor);
	await ensureUserCanAccessGame(
		{ userId: acting_user_id, gameId: teamMemberGameContext.game_id },
		queryExecutor
	);
	await ensureUserIsNotAlreadyMemberInGame(
		{ userId: botUser.user_id, gameId: teamMemberGameContext.game_id },
		queryExecutor
	);

	const updatedMember = await updateAvailableTeamMember(
		{ teamMemberId: normalizedTeamMemberId, userId: botUser.user_id, isBot: true },
		queryExecutor
	);

	return {
		...updatedMember,
		game_id: teamMemberGameContext.game_id,
	};
}

export async function leaveTeamMember({ team_member_id, user_id }, queryExecutor = pool) {
	const normalizedTeamMemberId = normalizeId(team_member_id);

	if (normalizedTeamMemberId === null) {
		const error = new Error("team_member_id must be a valid positive integer");
		error.code = "INVALID_TEAM_MEMBER_ID";
		throw error;
	}

	const normalizedUserId = normalizeText(user_id);

	if (!normalizedUserId) {
		const error = new Error("user_id is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	if (!UUID_PATTERN.test(normalizedUserId)) {
		const error = new Error("user_id must be a valid UUID");
		error.code = "INVALID_USER_ID";
		throw error;
	}

	// Get team member current info
	const currentMemberResult = await queryExecutor.query(
		`SELECT tm.user_id, t.game_id
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE tm.team_member_id = $1 LIMIT 1`,
		[normalizedTeamMemberId]
	);

	if (currentMemberResult.rowCount === 0) {
		const error = new Error("Team member not found");
		error.code = "TEAM_MEMBER_NOT_FOUND";
		throw error;
	}

	const currentMember = currentMemberResult.rows[0];

	// Verify the user is the current occupant
	if (!currentMember.user_id || currentMember.user_id.toString().toLowerCase() !== normalizedUserId.toLowerCase()) {
		const error = new Error("You are not occupying this slot");
		error.code = "NOT_SLOT_OCCUPANT";
		throw error;
	}

	// Update to set user_id to NULL
	const result = await queryExecutor.query(
		`UPDATE gameplay.team_members
		 SET user_id = NULL,
		 	 is_bot = FALSE,
		 	 joined_at = NULL,
		 	 draw_offer_accepted = FALSE,
		 	 forfeit_offer_accepted = FALSE
		 WHERE team_member_id = $1
		 RETURNING ${TEAM_MEMBER_SELECT_FIELDS}`,
		[normalizedTeamMemberId]
	);

	if (result.rowCount > 0) {
		return {
			...result.rows[0],
			game_id: currentMember.game_id,
		};
	}

	const error = new Error("Failed to leave team slot");
	error.code = "LEAVE_FAILED";
	throw error;
}

export async function removeBotTeamMember({ team_member_id, acting_user_id }, queryExecutor = pool) {
	const normalizedTeamMemberId = normalizeId(team_member_id);

	if (normalizedTeamMemberId === null) {
		const error = new Error("team_member_id must be a valid positive integer");
		error.code = "INVALID_TEAM_MEMBER_ID";
		throw error;
	}

	const normalizedActingUserId = normalizeText(acting_user_id);

	if (!normalizedActingUserId) {
		const error = new Error("acting_user_id is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	if (!UUID_PATTERN.test(normalizedActingUserId)) {
		const error = new Error("acting_user_id must be a valid UUID");
		error.code = "INVALID_USER_ID";
		throw error;
	}

	const teamMemberGameContext = await getTeamMemberGameContext(normalizedTeamMemberId, queryExecutor);

	await ensureUserCanAccessGame(
		{ userId: normalizedActingUserId, gameId: teamMemberGameContext.game_id },
		queryExecutor
	);

	const result = await queryExecutor.query(
		`UPDATE gameplay.team_members
		 SET user_id = NULL,
		 	 is_bot = FALSE,
		 	 joined_at = NULL,
		 	 draw_offer_accepted = FALSE,
		 	 forfeit_offer_accepted = FALSE
		 WHERE team_member_id = $1
		 	 AND user_id IS NOT NULL
		 	 AND is_bot = TRUE
		 RETURNING ${TEAM_MEMBER_SELECT_FIELDS}`,
		[normalizedTeamMemberId]
	);

	if (result.rowCount > 0) {
		return {
			...result.rows[0],
			game_id: teamMemberGameContext.game_id,
		};
	}

	const slotStateResult = await queryExecutor.query(
		"SELECT user_id, is_bot FROM gameplay.team_members WHERE team_member_id = $1 LIMIT 1",
		[normalizedTeamMemberId]
	);

	if (slotStateResult.rowCount === 0) {
		const error = new Error("Team member not found");
		error.code = "TEAM_MEMBER_NOT_FOUND";
		throw error;
	}

	const slotState = slotStateResult.rows[0];

	if (!slotState.user_id) {
		const error = new Error("Team member slot is empty");
		error.code = "TEAM_MEMBER_ALREADY_EMPTY";
		throw error;
	}

	if (slotState.is_bot !== true) {
		const error = new Error("Only bot-occupied slots can be removed");
		error.code = "TEAM_MEMBER_NOT_BOT";
		throw error;
	}

	const error = new Error("Could not remove bot from slot");
	error.code = "REMOVE_BOT_FAILED";
	throw error;
}

export async function listAllBotNames(queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT username
		 FROM neon_auth.users
		 WHERE RIGHT(username, 4) = '_BOT'
		 ORDER BY username ASC`
	);

	return result.rows.map((row) => row.username);
}
