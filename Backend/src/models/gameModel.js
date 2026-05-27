import pool from "../config/db.js";
import { ensureUserCanCreateGame } from "./gameParticipationModel.js";
import { generateInviteToken } from "../services/game/inviteTokenService.js";
import { generateTeamNames } from "../services/team/teamNameGenerator.js";
import { applyRatingForFinishedGame } from "../services/game/ratingService.js";

const GAME_SELECT_FIELDS =
	"game_id, status, result, started_at, finished_at, time_control, increment, created_by, move_count, user_id, invite_token, game_name, rated_game, allow_spectators, public_game, draw_offer_count, winner_team_id, finish_reason, clock_last_synced_at, active_board1_team_member_id, active_board2_team_member_id";
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DEFAULT_GAME_NAME = "Casual chess room";
const DEFAULT_RATED_GAME = false;
const DEFAULT_ALLOW_SPECTATORS = true;
const DEFAULT_PUBLIC_GAME = false;

function parseInitialSecondsFromTimeControl(value) {
	const numericValue = Number(String(value ?? "").trim());

	if (!Number.isFinite(numericValue) || numericValue <= 0) {
		return 300;
	}

	return Math.max(1, Math.round(numericValue * 60));
}

function normalizeText(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim();
}

function normalizeUserId(value) {
	return normalizeText(value).toLowerCase();
}

function normalizeGameName(value) {
	const normalizedName = normalizeText(value);
	return normalizedName || DEFAULT_GAME_NAME;
}

function normalizeBooleanWithDefault(value, defaultValue) {
	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		return defaultValue;
	}

	if (typeof value === "string") {
		const normalizedValue = value.trim().toLowerCase();

		if (normalizedValue === "true") return true;
		if (normalizedValue === "false") return false;
	}

	return defaultValue;
}

function parseBooleanOrThrow(value, { errorCode, errorMessage }) {
	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
	}

	if (typeof value === "string") {
		const normalizedValue = value.trim().toLowerCase();

		if (normalizedValue === "true") return true;
		if (normalizedValue === "false") return false;
	}

	const error = new Error(errorMessage);
	error.code = errorCode;
	throw error;
}

function normalizeGameId(gameId) {
	if (typeof gameId === "number" && Number.isInteger(gameId) && gameId > 0) {
		return gameId;
	}

	if (typeof gameId !== "string") {
		return null;
	}

	const normalizedValue = gameId.trim();
	if (!normalizedValue) {
		return null;
	}

	const parsedId = Number(normalizedValue);
	return Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
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

function mapTeamRowsToSnapshot(rows) {
	const teamsMap = new Map();

	for (const row of rows) {
		if (!teamsMap.has(row.team_id)) {
			teamsMap.set(row.team_id, {
				team_id: row.team_id,
				team_name: row.team_name,
				forfeit_offer_count: Number(row.forfeit_offer_count ?? 0),
				created_at: row.team_created_at,
				available_slots: 0,
				members: [],
			});
		}

		const team = teamsMap.get(row.team_id);

		if (row.team_member_id == null) {
			continue;
		}

		const isAvailable = row.team_member_user_id == null && row.joined_at == null;

		if (isAvailable) {
			team.available_slots += 1;
		}

		team.members.push({
			team_member_id: row.team_member_id,
			user_id: row.team_member_user_id,
			username: row.username ?? null,
			avatar: row.avatar ?? null,
			is_bot: row.is_bot,
			board_number: row.board_number,
			piece_color: row.piece_color,
			remaining_seconds: Number(row.remaining_seconds ?? 0),
			draw_offer_accepted: row.draw_offer_accepted,
			forfeit_offer_accepted: row.forfeit_offer_accepted,
			joined_at: row.joined_at,
			is_available: isAvailable,
		});
	}

	return Array.from(teamsMap.values());
}

async function getGameTeamsSnapshot(gameId, queryExecutor = pool) {
	const teamMembersResult = await queryExecutor.query(
		`SELECT
			t.team_id,
			t.team_name,
			t.forfeit_offer_count,
			t.created_at AS team_created_at,
			tm.team_member_id,
			tm.user_id AS team_member_user_id,
			tm.is_bot,
			tm.board_number,
			tm.piece_color,
			tm.remaining_seconds,
			tm.draw_offer_accepted,
			tm.forfeit_offer_accepted,
			tm.joined_at,
			u.username,
			u.avatar
		 FROM gameplay.teams t
		 LEFT JOIN gameplay.team_members tm ON tm.team_id = t.team_id
		 LEFT JOIN neon_auth.users u ON u.user_id = tm.user_id
		 WHERE t.game_id = $1
		 ORDER BY t.team_id ASC, tm.board_number ASC, tm.team_member_id ASC`,
		[gameId]
	);

	return mapTeamRowsToSnapshot(teamMembersResult.rows);
}

async function hasLobbyEditAccess({ gameId, actingUserId }, queryExecutor = pool) {
	const result = await queryExecutor.query(
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
		 LIMIT 1`,
		[gameId, actingUserId]
	);

	return result.rowCount > 0;
}

async function ensureGameIdSequenceStartsFromOne(queryExecutor = pool) {
	const sequenceResult = await queryExecutor.query("SELECT to_regclass('gameplay.games_game_id_seq') AS sequence_name");
	const sequenceName = sequenceResult.rows[0]?.sequence_name;

	if (!sequenceName) {
		return;
	}

	const statsResult = await queryExecutor.query(
		"SELECT COUNT(*)::int AS total_games, COALESCE(MAX(game_id), 0)::int AS max_game_id FROM gameplay.games"
	);
	const { total_games: totalGames, max_game_id: maxGameId } = statsResult.rows[0];

	if (totalGames === 0) {
		await queryExecutor.query("SELECT setval('gameplay.games_game_id_seq', 1, false)");
		return;
	}

	await queryExecutor.query("SELECT setval('gameplay.games_game_id_seq', $1, true)", [maxGameId]);
}

async function getUserById(userId, queryExecutor = pool) {
	const userResult = await queryExecutor.query(
		"SELECT user_id, username FROM neon_auth.users WHERE user_id = $1 LIMIT 1",
		[userId]
	);

	if (userResult.rowCount === 0) {
		const error = new Error("User not found");
		error.code = "USER_NOT_FOUND";
		throw error;
	}

	return userResult.rows[0];
}

async function createUniqueInviteToken(queryExecutor = pool) {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const inviteToken = generateInviteToken();
		const existingTokenResult = await queryExecutor.query(
			"SELECT 1 FROM gameplay.games WHERE invite_token = $1 LIMIT 1",
			[inviteToken]
		);

		if (existingTokenResult.rowCount === 0) {
			return inviteToken;
		}
	}

	const error = new Error("Unable to generate a unique invite token");
	error.code = "INVITE_TOKEN_GENERATION_FAILED";
	throw error;
}

export async function createGame(
	{ user_id, time_control, increment, game_name, rated_game, allow_spectators, public_game },
	queryExecutor = pool
) {
	const normalizedUserId = normalizeText(user_id);
	const normalizedTimeControl = normalizeText(time_control || String(time_control ?? ""));
	const normalizedIncrement = normalizeText(increment || String(increment ?? ""));
	const normalizedGameName = normalizeGameName(game_name);
	const normalizedRatedGame = normalizeBooleanWithDefault(rated_game, DEFAULT_RATED_GAME);
	const normalizedAllowSpectators = normalizeBooleanWithDefault(allow_spectators, DEFAULT_ALLOW_SPECTATORS);
	const normalizedPublicGame = normalizeBooleanWithDefault(public_game, DEFAULT_PUBLIC_GAME);
	const startedAt = new Date();

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

	if (!normalizedTimeControl) {
		const error = new Error("time_control is required");
		error.code = "TIME_CONTROL_REQUIRED";
		throw error;
	}

	if (!normalizedIncrement) {
		const error = new Error("increment is required");
		error.code = "INCREMENT_REQUIRED";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		await ensureGameIdSequenceStartsFromOne(executor);
		const user = await getUserById(normalizedUserId, executor);
		await ensureUserCanCreateGame(normalizedUserId, executor);
		const createdBy = normalizeText(user.username);
		const inviteToken = await createUniqueInviteToken(executor);

		const result = await executor.query(
			`INSERT INTO gameplay.games (
				status,
				result,
				started_at,
				finished_at,
				time_control,
				increment,
				created_by,
				move_count,
				user_id,
				invite_token,
				game_name,
				rated_game,
				allow_spectators,
				public_game
			)
			VALUES (
				'in_progress',
				NULL,
				$1,
				NULL,
				$2,
				$3,
				$4,
				NULL,
				$5,
				$6,
				$7,
				$8,
				$9,
				$10
			)
			RETURNING ${GAME_SELECT_FIELDS}`,
			[
				startedAt,
				normalizedTimeControl,
				normalizedIncrement,
				createdBy,
				normalizedUserId,
				inviteToken,
				normalizedGameName,
				normalizedRatedGame,
				normalizedAllowSpectators,
				normalizedPublicGame,
			]
		);

		const game = result.rows[0];

		const [teamName1, teamName2] = generateTeamNames();

		const teamsResult = await executor.query(
			`INSERT INTO gameplay.teams (game_id, created_at, team_name) VALUES ($1, $2, $3), ($1, $2, $4) RETURNING team_id`,
			[game.game_id, game.started_at, teamName1, teamName2]
		);

		const [team1Id, team2Id] = teamsResult.rows.map((row) => row.team_id);

		await executor.query(
			`INSERT INTO gameplay.team_members
				(team_id, user_id, is_bot, board_number, piece_color, joined_at)
			VALUES
				($1, NULL, FALSE, 1, 'white', NULL),
				($1, NULL, FALSE, 2, 'black', NULL),
				($2, NULL, FALSE, 1, 'black', NULL),
				($2, NULL, FALSE, 2, 'white', NULL)`,
			[team1Id, team2Id]
		);

		if (client) await client.query("COMMIT");

		return game;
	} catch (err) {
		if (client) await client.query("ROLLBACK");
		throw err;
	} finally {
		if (client) client.release();
	}
}

export async function getGameByInviteToken(invite_token, queryExecutor = pool) {
	const normalizedInviteToken = normalizeText(invite_token);

	if (!normalizedInviteToken) {
		const error = new Error("invite token is required");
		error.code = "INVITE_TOKEN_REQUIRED";
		throw error;
	}

	const gameResult = await queryExecutor.query(
		`SELECT ${GAME_SELECT_FIELDS}
		 FROM gameplay.games
		 WHERE invite_token = $1
		 LIMIT 1`,
		[normalizedInviteToken]
	);

	if (gameResult.rowCount === 0) {
		const error = new Error("Invite not found");
		error.code = "INVITE_TOKEN_NOT_FOUND";
		throw error;
	}

	const game = gameResult.rows[0];
	const teams = await getGameTeamsSnapshot(game.game_id, queryExecutor);

	return {
		...game,
		teams,
	};
}

export async function getGameInviteTokenByGameId(gameId, queryExecutor = pool) {
	const normalizedGameId = normalizeGameId(gameId);

	if (normalizedGameId == null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	const result = await queryExecutor.query(
		`SELECT invite_token
		 FROM gameplay.games
		 WHERE game_id = $1
		 LIMIT 1`,
		[normalizedGameId]
	);

	if (result.rowCount === 0) {
		const error = new Error("Game not found");
		error.code = "GAME_NOT_FOUND";
		throw error;
	}

	return result.rows[0].invite_token;
}

export async function getGameByIdWithTeams(gameId, queryExecutor = pool) {
	const normalizedGameId = normalizeGameId(gameId);

	if (normalizedGameId == null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	const gameResult = await queryExecutor.query(
		`SELECT ${GAME_SELECT_FIELDS}
		 FROM gameplay.games
		 WHERE game_id = $1
		 LIMIT 1`,
		[normalizedGameId]
	);

	if (gameResult.rowCount === 0) {
		const error = new Error("Game not found");
		error.code = "GAME_NOT_FOUND";
		throw error;
	}

	const game = gameResult.rows[0];
	const teams = await getGameTeamsSnapshot(normalizedGameId, queryExecutor);

	return {
		...game,
		teams,
	};
}

export async function updateLobbyGameNameByHost({ game_id, game_name, acting_user_id }, queryExecutor = pool) {
	const normalizedGameId = normalizeGameId(game_id);

	if (normalizedGameId == null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	const normalizedGameName = normalizeText(game_name);

	if (!normalizedGameName) {
		const error = new Error("game_name is required");
		error.code = "GAME_NAME_REQUIRED";
		throw error;
	}

	const normalizedActingUserId = normalizeUserId(acting_user_id);

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		const gameResult = await executor.query(
			`SELECT ${GAME_SELECT_FIELDS}
			 FROM gameplay.games
			 WHERE game_id = $1
			 FOR UPDATE`,
			[normalizedGameId]
		);

		if (gameResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		const game = gameResult.rows[0];
		const canEditLobby = await hasLobbyEditAccess(
			{ gameId: normalizedGameId, actingUserId: normalizedActingUserId },
			executor
		);

		if (!canEditLobby) {
			const error = new Error("You do not have access to this game");
			error.code = "GAME_ACCESS_DENIED";
			throw error;
		}

		const normalizedGameStatus = normalizeText(game.status).toLowerCase();
		if (normalizedGameStatus !== "in_progress") {
			const error = new Error("Game name can only be changed while lobby is open");
			error.code = "GAME_NOT_IN_LOBBY";
			throw error;
		}

		const updatedGameResult = await executor.query(
			`UPDATE gameplay.games
			 SET game_name = $1
			 WHERE game_id = $2
			 RETURNING ${GAME_SELECT_FIELDS}`,
			[normalizedGameName, normalizedGameId]
		);

		if (updatedGameResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		if (client) await client.query("COMMIT");

		return {
			game: updatedGameResult.rows[0],
		};
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function updateLobbyGameSettingsByHost({ game_id, acting_user_id, settings }, queryExecutor = pool) {
	const normalizedGameId = normalizeGameId(game_id);

	if (normalizedGameId == null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	const normalizedActingUserId = normalizeUserId(acting_user_id);

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const normalizedSettings = settings && typeof settings === "object" ? settings : {};
	const hasTimeControlField = Object.prototype.hasOwnProperty.call(normalizedSettings, "time_control");
	const hasIncrementField = Object.prototype.hasOwnProperty.call(normalizedSettings, "increment");
	const hasRatedGameField = Object.prototype.hasOwnProperty.call(normalizedSettings, "rated_game");
	const hasAllowSpectatorsField = Object.prototype.hasOwnProperty.call(normalizedSettings, "allow_spectators");
	const hasPublicGameField = Object.prototype.hasOwnProperty.call(normalizedSettings, "public_game");

	if (!hasTimeControlField && !hasIncrementField && !hasRatedGameField && !hasAllowSpectatorsField && !hasPublicGameField) {
		const error = new Error("No game settings were provided for update");
		error.code = "NO_SETTINGS_UPDATE_FIELDS";
		throw error;
	}

	if (hasTimeControlField !== hasIncrementField) {
		const error = new Error("time_control and increment must be provided together");
		error.code = "TIME_CONTROL_AND_INCREMENT_REQUIRED";
		throw error;
	}

	const normalizedTimeControl = hasTimeControlField
		? normalizeText(normalizedSettings.time_control)
		: "";
	const normalizedIncrement = hasIncrementField
		? normalizeText(normalizedSettings.increment)
		: "";

	if (hasTimeControlField && !normalizedTimeControl) {
		const error = new Error("time_control is required");
		error.code = "TIME_CONTROL_REQUIRED";
		throw error;
	}

	if (hasIncrementField && !normalizedIncrement) {
		const error = new Error("increment is required");
		error.code = "INCREMENT_REQUIRED";
		throw error;
	}

	const nextRatedGame = hasRatedGameField
		? parseBooleanOrThrow(normalizedSettings.rated_game, {
			errorCode: "INVALID_RATED_GAME",
			errorMessage: "rated_game must be a boolean",
		})
		: null;

	const nextAllowSpectators = hasAllowSpectatorsField
		? parseBooleanOrThrow(normalizedSettings.allow_spectators, {
			errorCode: "INVALID_ALLOW_SPECTATORS",
			errorMessage: "allow_spectators must be a boolean",
		})
		: null;

	const nextPublicGame = hasPublicGameField
		? parseBooleanOrThrow(normalizedSettings.public_game, {
			errorCode: "INVALID_PUBLIC_GAME",
			errorMessage: "public_game must be a boolean",
		})
		: null;

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		const gameResult = await executor.query(
			`SELECT ${GAME_SELECT_FIELDS}
			 FROM gameplay.games
			 WHERE game_id = $1
			 FOR UPDATE`,
			[normalizedGameId]
		);

		if (gameResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		const game = gameResult.rows[0];
		const canEditLobby = await hasLobbyEditAccess(
			{ gameId: normalizedGameId, actingUserId: normalizedActingUserId },
			executor
		);

		if (!canEditLobby) {
			const error = new Error("You do not have access to this game");
			error.code = "GAME_ACCESS_DENIED";
			throw error;
		}

		const normalizedGameStatus = normalizeText(game.status).toLowerCase();
		if (normalizedGameStatus !== "in_progress") {
			const error = new Error("Game settings can only be changed while lobby is open");
			error.code = "GAME_NOT_IN_LOBBY";
			throw error;
		}

		const updatedGameResult = await executor.query(
			`UPDATE gameplay.games
			 SET time_control = $1,
			 	 increment = $2,
			 	 rated_game = $3,
			 	 allow_spectators = $4,
			 	 public_game = $5
			 WHERE game_id = $6
			 RETURNING ${GAME_SELECT_FIELDS}`,
			[
				hasTimeControlField ? normalizedTimeControl : game.time_control,
				hasIncrementField ? normalizedIncrement : game.increment,
				hasRatedGameField ? nextRatedGame : game.rated_game,
				hasAllowSpectatorsField ? nextAllowSpectators : game.allow_spectators,
				hasPublicGameField ? nextPublicGame : game.public_game,
				normalizedGameId,
			]
		);

		if (updatedGameResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		if (client) await client.query("COMMIT");

		return {
			game: updatedGameResult.rows[0],
		};
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function updateLobbyTeamNameByHost(
	{ game_id, team_id, team_name, acting_user_id },
	queryExecutor = pool
) {
	const normalizedGameId = normalizeGameId(game_id);

	if (normalizedGameId == null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	const normalizedTeamId = normalizeTeamId(team_id);

	if (normalizedTeamId == null) {
		const error = new Error("team_id must be a valid positive integer");
		error.code = "INVALID_TEAM_ID";
		throw error;
	}

	const normalizedTeamName = normalizeText(team_name);

	if (!normalizedTeamName) {
		const error = new Error("team_name is required");
		error.code = "TEAM_NAME_REQUIRED";
		throw error;
	}

	const normalizedActingUserId = normalizeUserId(acting_user_id);

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		const gameResult = await executor.query(
			`SELECT ${GAME_SELECT_FIELDS}
			 FROM gameplay.games
			 WHERE game_id = $1
			 FOR UPDATE`,
			[normalizedGameId]
		);

		if (gameResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		const game = gameResult.rows[0];
		const canEditLobby = await hasLobbyEditAccess(
			{ gameId: normalizedGameId, actingUserId: normalizedActingUserId },
			executor
		);

		if (!canEditLobby) {
			const error = new Error("You do not have access to this game");
			error.code = "GAME_ACCESS_DENIED";
			throw error;
		}

		const normalizedGameStatus = normalizeText(game.status).toLowerCase();
		if (normalizedGameStatus !== "in_progress") {
			const error = new Error("Team names can only be changed while lobby is open");
			error.code = "GAME_NOT_IN_LOBBY";
			throw error;
		}

		const teamResult = await executor.query(
			`UPDATE gameplay.teams
			 SET team_name = $1
			 WHERE team_id = $2
			   AND game_id = $3
			 RETURNING team_id, game_id, team_name, forfeit_offer_count, created_at`,
			[normalizedTeamName, normalizedTeamId, normalizedGameId]
		);

		if (teamResult.rowCount === 0) {
			const error = new Error("Team not found in this game");
			error.code = "TEAM_NOT_FOUND";
			throw error;
		}

		if (client) await client.query("COMMIT");

		return {
			game,
			team: teamResult.rows[0],
		};
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function markGameStarted(gameId, queryExecutor = pool) {
	const normalizedGameId = normalizeGameId(gameId);

	if (normalizedGameId == null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		const existingGameResult = await executor.query(
			`SELECT ${GAME_SELECT_FIELDS}
			 FROM gameplay.games
			 WHERE game_id = $1
			 FOR UPDATE`,
			[normalizedGameId]
		);

		if (existingGameResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		const existingGame = existingGameResult.rows[0];
		const existingStatus = normalizeText(existingGame.status).toLowerCase();

		if (existingStatus === "started") {
			if (client) await client.query("COMMIT");
			return existingGame;
		}

		const result = await executor.query(
			`UPDATE gameplay.games
			 SET status = 'started',
				 started_at = COALESCE(started_at, NOW()),
				 finished_at = NULL,
				 winner_team_id = NULL,
				 finish_reason = NULL,
				 result = NULL,
				 clock_last_synced_at = NOW(),
				 active_board1_team_member_id = (
				 	SELECT tm.team_member_id
				 	FROM gameplay.team_members tm
				 	JOIN gameplay.teams t ON t.team_id = tm.team_id
				 	WHERE t.game_id = $1 AND tm.board_number = 1 AND LOWER(tm.piece_color) = 'white'
				 	LIMIT 1
				 ),
				 active_board2_team_member_id = (
				 	SELECT tm.team_member_id
				 	FROM gameplay.team_members tm
				 	JOIN gameplay.teams t ON t.team_id = tm.team_id
				 	WHERE t.game_id = $1 AND tm.board_number = 2 AND LOWER(tm.piece_color) = 'white'
				 	LIMIT 1
				 )
			 WHERE game_id = $1
			 RETURNING ${GAME_SELECT_FIELDS}`,
			[normalizedGameId]
		);

		if (result.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		await executor.query(
			`UPDATE gameplay.team_members tm
			 SET remaining_seconds = $2
			 FROM gameplay.teams t
			 WHERE tm.team_id = t.team_id
			   AND t.game_id = $1`,
			[normalizedGameId, parseInitialSecondsFromTimeControl(result.rows[0]?.time_control)]
		);

		await executor.query(
			`INSERT INTO gameplay.player_reserves (team_member_id, piece_type, quantity)
			 SELECT tm.team_member_id, reserve_piece.piece_type, 0
			 FROM gameplay.team_members tm
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 CROSS JOIN (VALUES ('n'), ('r'), ('q'), ('b'), ('p')) AS reserve_piece(piece_type)
			 WHERE t.game_id = $1
			 ON CONFLICT (team_member_id, piece_type) DO NOTHING`,
			[normalizedGameId]
		);

		if (client) await client.query("COMMIT");

		return result.rows[0];
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function markGameFinished(gameId, options = {}, queryExecutor = pool) {
	const normalizedGameId = normalizeGameId(gameId);

	if (normalizedGameId == null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	const winnerTeamId = normalizeTeamId(options?.winner_team_id);
	const finishReason = normalizeText(options?.finish_reason) || null;
	const normalizedResult = normalizeText(options?.result) || null;
	const finishedAt = options?.finished_at instanceof Date ? options.finished_at : new Date();

	const result = await queryExecutor.query(
		`UPDATE gameplay.games
		 SET status = 'finished',
			 finished_at = $2,
			 winner_team_id = $3,
			 finish_reason = $4,
			 result = COALESCE($5, result)
		 WHERE game_id = $1
		 RETURNING ${GAME_SELECT_FIELDS}`,
		[normalizedGameId, finishedAt, winnerTeamId, finishReason, normalizedResult]
	);

	if (result.rowCount === 0) {
		const error = new Error("Game not found");
		error.code = "GAME_NOT_FOUND";
		throw error;
	}

	const finishedGame = result.rows[0];
	applyRatingForFinishedGame({
		gameId: finishedGame.game_id,
		winnerTeamId: finishedGame.winner_team_id,
		ratedGame: finishedGame.rated_game,
	}).catch((err) => console.error("[rating] Failed to apply rating:", err));

	return finishedGame;
}

export async function synchronizeGameClock(gameId, queryExecutor = pool) {
	const normalizedGameId = normalizeGameId(gameId);

	if (normalizedGameId == null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		const gameResult = await executor.query(
			`SELECT ${GAME_SELECT_FIELDS}
			 FROM gameplay.games
			 WHERE game_id = $1
			 FOR UPDATE`,
			[normalizedGameId]
		);

		if (gameResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		let game = gameResult.rows[0];
		const normalizedStatus = normalizeText(game.status).toLowerCase();

		if (normalizedStatus !== "started") {
			if (client) await client.query("COMMIT");
			return game;
		}

		const initialSeconds = parseInitialSecondsFromTimeControl(game.time_control);
		await executor.query(
			`UPDATE gameplay.team_members tm
			 SET remaining_seconds = $2
			 FROM gameplay.teams t
			 WHERE tm.team_id = t.team_id
			   AND t.game_id = $1
			   AND tm.remaining_seconds IS NULL`,
			[normalizedGameId, initialSeconds]
		);

		if (!normalizeTeamId(game.active_board1_team_member_id) || !normalizeTeamId(game.active_board2_team_member_id)) {
			const activeMembersResult = await executor.query(
				`SELECT
					MAX(CASE WHEN tm.board_number = 1 AND LOWER(tm.piece_color) = 'white' THEN tm.team_member_id END) AS board1_active,
					MAX(CASE WHEN tm.board_number = 2 AND LOWER(tm.piece_color) = 'white' THEN tm.team_member_id END) AS board2_active
				 FROM gameplay.team_members tm
				 JOIN gameplay.teams t ON t.team_id = tm.team_id
				 WHERE t.game_id = $1`,
				[normalizedGameId]
			);

			const board1Active = normalizeId(activeMembersResult.rows[0]?.board1_active);
			const board2Active = normalizeId(activeMembersResult.rows[0]?.board2_active);

			const updatedGameResult = await executor.query(
				`UPDATE gameplay.games
				 SET active_board1_team_member_id = COALESCE(active_board1_team_member_id, $2),
					 active_board2_team_member_id = COALESCE(active_board2_team_member_id, $3)
				 WHERE game_id = $1
				 RETURNING ${GAME_SELECT_FIELDS}`,
				[normalizedGameId, board1Active, board2Active]
			);

			game = updatedGameResult.rows[0] ?? game;
		}

		const clockLastSyncedAt = game.clock_last_synced_at ? new Date(game.clock_last_synced_at) : null;
		if (!clockLastSyncedAt || Number.isNaN(clockLastSyncedAt.getTime())) {
			const updatedGameResult = await executor.query(
				`UPDATE gameplay.games
				 SET clock_last_synced_at = NOW()
				 WHERE game_id = $1
				 RETURNING ${GAME_SELECT_FIELDS}`,
				[normalizedGameId]
			);

			if (client) await client.query("COMMIT");
			return updatedGameResult.rows[0] ?? game;
		}

		const now = new Date();
		const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - clockLastSyncedAt.getTime()) / 1000));

		if (elapsedSeconds <= 0) {
			if (client) await client.query("COMMIT");
			return game;
		}

		const activeMemberIds = Array.from(new Set([
			normalizeTeamId(game.active_board1_team_member_id),
			normalizeTeamId(game.active_board2_team_member_id),
		].filter(Boolean)));

		if (activeMemberIds.length > 0) {
			await executor.query(
				`UPDATE gameplay.team_members
				 SET remaining_seconds = GREATEST(0, COALESCE(remaining_seconds, 0) - $1)
				 WHERE team_member_id = ANY($2::int[])`,
				[elapsedSeconds, activeMemberIds]
			);
		}

		const syncedGameResult = await executor.query(
			`UPDATE gameplay.games
			 SET clock_last_synced_at = $2
			 WHERE game_id = $1
			 RETURNING ${GAME_SELECT_FIELDS}`,
			[normalizedGameId, now]
		);

		game = syncedGameResult.rows[0] ?? game;

		if (activeMemberIds.length > 0) {
			const timedOutResult = await executor.query(
				`SELECT tm.team_member_id, tm.team_id, COALESCE(tm.remaining_seconds, 0) AS remaining_seconds
				 FROM gameplay.team_members tm
				 WHERE tm.team_member_id = ANY($1::int[])
				   AND COALESCE(tm.remaining_seconds, 0) <= 0`,
				[activeMemberIds]
			);

			if (timedOutResult.rowCount > 0) {
				const allTeamsResult = await executor.query(
					`SELECT team_id
					 FROM gameplay.teams
					 WHERE game_id = $1
					 ORDER BY team_id ASC`,
					[normalizedGameId]
				);

				const allTeamIds = allTeamsResult.rows.map((row) => normalizeTeamId(row.team_id)).filter(Boolean);
				const timedOutTeamIds = Array.from(new Set(timedOutResult.rows.map((row) => normalizeTeamId(row.team_id)).filter(Boolean)));

				let winnerTeamId = null;
				if (allTeamIds.length === 2 && timedOutTeamIds.length === 1) {
					winnerTeamId = allTeamIds.find((teamId) => teamId !== timedOutTeamIds[0]) ?? null;
				}

				let winnerTeamName = "";
				if (winnerTeamId) {
					const winnerTeamResult = await executor.query(
						`SELECT team_name
						 FROM gameplay.teams
						 WHERE game_id = $1 AND team_id = $2
						 LIMIT 1`,
						[normalizedGameId, winnerTeamId]
					);

					winnerTeamName = normalizeText(winnerTeamResult.rows[0]?.team_name);
				}

				const finishResult = await executor.query(
					`UPDATE gameplay.games
					 SET status = 'finished',
						 finished_at = $2,
						 winner_team_id = $3,
						 finish_reason = 'timeout',
						 result = $4
					 WHERE game_id = $1
					 RETURNING ${GAME_SELECT_FIELDS}`,
					[
						normalizedGameId,
						now,
						winnerTeamId,
						winnerTeamId
							? `${winnerTeamName || `Team ${winnerTeamId}`} won on time`
							: "Game ended on time",
					]
				);

				game = finishResult.rows[0] ?? game;
			}
		}

		if (client) await client.query("COMMIT");
		return game;
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function deleteLobbyGameByHost({ game_id, acting_user_id }, queryExecutor = pool) {
	const normalizedGameId = normalizeGameId(game_id);

	if (normalizedGameId == null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	const normalizedActingUserId = normalizeUserId(acting_user_id);

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		const gameResult = await executor.query(
			`SELECT ${GAME_SELECT_FIELDS}
			 FROM gameplay.games
			 WHERE game_id = $1
			 FOR UPDATE`,
			[normalizedGameId]
		);

		if (gameResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		const game = gameResult.rows[0];
		const normalizedHostUserId = normalizeUserId(game.user_id);

		if (!normalizedHostUserId || normalizedHostUserId !== normalizedActingUserId) {
			const error = new Error("Only the game host can close this lobby");
			error.code = "GAME_HOST_REQUIRED";
			throw error;
		}

		const normalizedGameStatus = normalizeText(game.status).toLowerCase();
		if (normalizedGameStatus === "finished") {
			const error = new Error("Finished games cannot be deleted");
			error.code = "GAME_ALREADY_FINISHED";
			throw error;
		}

		const participantsResult = await executor.query(
			`SELECT DISTINCT LOWER(tm.user_id::text) AS user_id
			 FROM gameplay.team_members tm
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 WHERE t.game_id = $1
			   AND tm.user_id IS NOT NULL`,
			[normalizedGameId]
		);

		await executor.query(
			`DELETE FROM gameplay.game_chats gc
			 USING gameplay.team_members tm, gameplay.teams t
			 WHERE gc.team_member_id = tm.team_member_id
			   AND tm.team_id = t.team_id
			   AND t.game_id = $1`,
			[normalizedGameId]
		);

		await executor.query(
			`DELETE FROM gameplay.team_members tm
			 USING gameplay.teams t
			 WHERE tm.team_id = t.team_id
			   AND t.game_id = $1`,
			[normalizedGameId]
		);

		await executor.query(
			`DELETE FROM gameplay.teams
			 WHERE game_id = $1`,
			[normalizedGameId]
		);

		const deletedGameResult = await executor.query(
			`DELETE FROM gameplay.games
			 WHERE game_id = $1
			 RETURNING ${GAME_SELECT_FIELDS}`,
			[normalizedGameId]
		);

		if (deletedGameResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		if (client) await client.query("COMMIT");

		const kickedUserIds = participantsResult.rows
			.map((row) => normalizeUserId(row.user_id))
			.filter((userId) => Boolean(userId) && userId !== normalizedActingUserId);

		return {
			game: deletedGameResult.rows[0],
			host_user_id: normalizedHostUserId,
			kicked_user_ids: kickedUserIds,
		};
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function deleteGameBySystem({ game_id }, queryExecutor = pool) {
	const normalizedGameId = normalizeGameId(game_id);

	if (normalizedGameId == null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		const gameResult = await executor.query(
			`SELECT ${GAME_SELECT_FIELDS}
			 FROM gameplay.games
			 WHERE game_id = $1
			 FOR UPDATE`,
			[normalizedGameId]
		);

		if (gameResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		const game = gameResult.rows[0];
		const normalizedGameStatus = normalizeText(game.status).toLowerCase();

		if (normalizedGameStatus === "finished") {
			const error = new Error("Finished games cannot be deleted");
			error.code = "GAME_ALREADY_FINISHED";
			throw error;
		}

		if (normalizedGameStatus !== "in_progress") {
			const error = new Error("Only lobby games can be deleted by system cleanup");
			error.code = "GAME_NOT_IN_LOBBY";
			throw error;
		}

		const participantsResult = await executor.query(
			`SELECT DISTINCT LOWER(tm.user_id::text) AS user_id
			 FROM gameplay.team_members tm
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 WHERE t.game_id = $1
			   AND tm.user_id IS NOT NULL`,
			[normalizedGameId]
		);

		await executor.query(
			`DELETE FROM gameplay.game_chats gc
			 USING gameplay.team_members tm, gameplay.teams t
			 WHERE gc.team_member_id = tm.team_member_id
			   AND tm.team_id = t.team_id
			   AND t.game_id = $1`,
			[normalizedGameId]
		);

		await executor.query(
			`DELETE FROM gameplay.team_members tm
			 USING gameplay.teams t
			 WHERE tm.team_id = t.team_id
			   AND t.game_id = $1`,
			[normalizedGameId]
		);

		await executor.query(
			`DELETE FROM gameplay.teams
			 WHERE game_id = $1`,
			[normalizedGameId]
		);

		const deletedGameResult = await executor.query(
			`DELETE FROM gameplay.games
			 WHERE game_id = $1
			 RETURNING ${GAME_SELECT_FIELDS}`,
			[normalizedGameId]
		);

		if (deletedGameResult.rowCount === 0) {
			const error = new Error("Game not found");
			error.code = "GAME_NOT_FOUND";
			throw error;
		}

		if (client) await client.query("COMMIT");

		const normalizedHostUserId = normalizeUserId(game.user_id);
		const kickedUserIds = participantsResult.rows
			.map((row) => normalizeUserId(row.user_id))
			.filter((userId) => Boolean(userId) && userId !== normalizedHostUserId);

		return {
			game: deletedGameResult.rows[0],
			host_user_id: normalizedHostUserId,
			kicked_user_ids: kickedUserIds,
		};
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function deleteAllNonFinishedGamesByHost({ acting_user_id }, queryExecutor = pool) {
	const normalizedActingUserId = normalizeUserId(acting_user_id);

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const nonFinishedGamesResult = await queryExecutor.query(
		`SELECT game_id
		 FROM gameplay.games
		 WHERE LOWER(user_id::text) = $1
		   AND status IS DISTINCT FROM 'finished'
		 ORDER BY game_id ASC`,
		[normalizedActingUserId]
	);

	const deletedGames = [];

	for (const row of nonFinishedGamesResult.rows) {
		try {
			const deletionResult = await deleteLobbyGameByHost(
				{ game_id: row.game_id, acting_user_id: normalizedActingUserId },
				queryExecutor
			);
			deletedGames.push(deletionResult);
		} catch {
		}
	}

	return deletedGames;
}

export async function getPublicLobbyGames(limit = 20, queryExecutor = pool) {
	const safeLimit = Math.min(Math.max(Number.isInteger(Number(limit)) ? Number(limit) : 20, 1), 50);

	const result = await queryExecutor.query(
		`SELECT
			g.game_id,
			g.game_name,
			g.time_control,
			g.increment,
			COUNT(tm.team_member_id)::int AS total_slots,
			COUNT(tm.team_member_id) FILTER (WHERE tm.user_id IS NOT NULL AND tm.joined_at IS NOT NULL AND tm.is_bot IS NOT TRUE)::int AS joined_players,
			COUNT(tm.team_member_id) FILTER (WHERE tm.user_id IS NULL AND tm.joined_at IS NULL)::int AS open_slots
		 FROM gameplay.games g
		 JOIN gameplay.teams t ON t.game_id = g.game_id
		 JOIN gameplay.team_members tm ON tm.team_id = t.team_id
		 WHERE g.status = 'in_progress'
		   AND g.public_game = TRUE
		 GROUP BY g.game_id
		 HAVING COUNT(tm.team_member_id) FILTER (WHERE tm.user_id IS NULL AND tm.joined_at IS NULL) > 0
		 ORDER BY g.game_id DESC
		 LIMIT $1`,
		[safeLimit]
	);

	return result.rows;
}

export async function getGameStats(queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT
			COUNT(*) FILTER (WHERE status = 'started')::int AS active_games,
			COUNT(*) FILTER (WHERE status = 'in_progress' AND public_game = TRUE)::int AS open_lobbies
		 FROM gameplay.games
		 WHERE status IN ('started', 'in_progress')`
	);
	return result.rows[0];
}

export async function assignRematchPlayers(newGameId, sourceGameId, queryExecutor = pool) {
	const normalizedNewGameId = Number.parseInt(String(newGameId ?? ""), 10);
	const normalizedSourceGameId = Number.parseInt(String(sourceGameId ?? ""), 10);

	if (!Number.isInteger(normalizedNewGameId) || normalizedNewGameId <= 0) {
		const error = new Error("new_game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	if (!Number.isInteger(normalizedSourceGameId) || normalizedSourceGameId <= 0) {
		const error = new Error("source_game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	// Get source game team members with team rank (1=team A, 2=team B)
	const sourceResult = await queryExecutor.query(
		`SELECT
			tm.user_id,
			tm.is_bot,
			tm.board_number,
			ROW_NUMBER() OVER (ORDER BY t.team_id) AS team_rank
		 FROM gameplay.teams t
		 JOIN gameplay.team_members tm ON tm.team_id = t.team_id
		 WHERE t.game_id = $1
		   AND tm.user_id IS NOT NULL
		 ORDER BY t.team_id, tm.board_number`,
		[normalizedSourceGameId]
	);

	if (sourceResult.rows.length === 0) {
		return;
	}

	// Get new game team member slots
	const newResult = await queryExecutor.query(
		`SELECT
			tm.team_member_id,
			tm.board_number,
			ROW_NUMBER() OVER (ORDER BY t.team_id) AS team_rank
		 FROM gameplay.teams t
		 JOIN gameplay.team_members tm ON tm.team_id = t.team_id
		 WHERE t.game_id = $1
		 ORDER BY t.team_id, tm.board_number`,
		[normalizedNewGameId]
	);

	// Build map: "team_rank-board_number" -> team_member_id
	const newMemberMap = {};
	for (const row of newResult.rows) {
		newMemberMap[`${row.team_rank}-${row.board_number}`] = row.team_member_id;
	}

	// Assign each source player to the matching slot in the new game
	for (const src of sourceResult.rows) {
		const key = `${src.team_rank}-${src.board_number}`;
		const newTeamMemberId = newMemberMap[key];
		if (!newTeamMemberId) continue;

		await queryExecutor.query(
			`UPDATE gameplay.team_members
			 SET user_id = $1,
			     is_bot = $2,
			     joined_at = NOW()
			 WHERE team_member_id = $3
			   AND user_id IS NULL`,
			[src.user_id, src.is_bot, newTeamMemberId]
		);
	}
}

export async function getSpectatorGames(limit = 20, queryExecutor = pool) {
	const safeLimit = Math.min(Math.max(Number.isInteger(Number(limit)) ? Number(limit) : 20, 1), 50);

	const result = await queryExecutor.query(
		`SELECT
			g.game_id,
			g.game_name,
			g.time_control,
			g.increment,
			g.started_at,
			json_agg(
				json_build_object(
					'team_id', t.team_id,
					'team_name', t.team_name,
					'members', (
						SELECT COALESCE(json_agg(
							json_build_object(
								'board_number', tm.board_number,
								'piece_color', tm.piece_color,
								'is_bot', tm.is_bot,
								'username', COALESCE(u.username, 'Unknown'),
								'rating', COALESCE(u.rating, 1200)
							) ORDER BY tm.board_number
						), '[]'::json)
						FROM gameplay.team_members tm
						LEFT JOIN neon_auth.users u ON u.user_id::text = tm.user_id::text
						WHERE tm.team_id = t.team_id
					)
				) ORDER BY t.team_id
			) AS teams
		 FROM gameplay.games g
		 JOIN gameplay.teams t ON t.game_id = g.game_id
		 WHERE g.status = 'started'
		   AND g.allow_spectators = TRUE
		 GROUP BY g.game_id
		 ORDER BY g.started_at DESC
		 LIMIT $1`,
		[safeLimit]
	);

	return result.rows;
}
