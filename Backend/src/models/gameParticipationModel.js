import pool from "../config/db.js";

function createActiveGameError(message, activeGameId) {
	const error = new Error(message);
	error.code = "USER_ALREADY_IN_ACTIVE_GAME";
	error.activeGameId = activeGameId ?? null;
	return error;
}

export async function findActiveGamesForUser(userId, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`WITH active_games AS (
			SELECT g.game_id, TRUE AS is_creator, FALSE AS is_member
			FROM gameplay.games g
			WHERE g.user_id = $1
			  AND g.status IS DISTINCT FROM 'finished'

			UNION ALL

			SELECT g.game_id, FALSE AS is_creator, TRUE AS is_member
			FROM gameplay.team_members tm
			JOIN gameplay.teams t ON t.team_id = tm.team_id
			JOIN gameplay.games g ON g.game_id = t.game_id
			WHERE tm.user_id = $1
			  AND g.status IS DISTINCT FROM 'finished'
		)
		SELECT game_id, BOOL_OR(is_creator) AS is_creator, BOOL_OR(is_member) AS is_member
		FROM active_games
		GROUP BY game_id
		ORDER BY game_id ASC`,
		[userId]
	);

	return result.rows.map((row) => ({
		game_id: Number(row.game_id),
		is_creator: row.is_creator,
		is_member: row.is_member,
	}));
}

export async function ensureUserCanCreateGame(userId, queryExecutor = pool) {
	const activeGames = await findActiveGamesForUser(userId, queryExecutor);

	if (activeGames.length > 0) {
		throw createActiveGameError("User is already in an active game", activeGames[0].game_id);
	}
}

export async function ensureUserCanJoinGame({ userId, targetGameId }, queryExecutor = pool) {
	const activeGames = await findActiveGamesForUser(userId, queryExecutor);

	if (activeGames.length === 0) {
		return;
	}

	const normalizedTargetGameId = Number(targetGameId);
	const matchingGame = activeGames.find((game) => game.game_id === normalizedTargetGameId);

	if (!matchingGame) {
		throw createActiveGameError("User is already in another active game", activeGames[0].game_id);
	}

	if (matchingGame.is_member) {
		throw createActiveGameError("User is already in this active game", matchingGame.game_id);
	}
}
