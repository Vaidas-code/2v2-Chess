import pool from "../config/db.js";

const CHAT_SELECT_FIELDS = "chat_id, team_member_id, message, is_system, created_at";

function normalizeText(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim();
}

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

function normalizeUserId(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim().toLowerCase();
}

async function ensureUserCanAccessGame({ gameId, actingUserId }, queryExecutor = pool) {
	const accessResult = await queryExecutor.query(
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
		[gameId, actingUserId]
	);

	if (accessResult.rowCount === 0) {
		const error = new Error("You do not have access to this game");
		error.code = "GAME_ACCESS_DENIED";
		throw error;
	}
}

async function ensureUserCanAccessTeam({ teamId, actingUserId }, queryExecutor = pool) {
	const accessResult = await queryExecutor.query(
		`SELECT 1
		 FROM gameplay.team_members tm
		 WHERE tm.team_id = $1
		   AND LOWER(tm.user_id::text) = $2
		 LIMIT 1`,
		[teamId, actingUserId]
	);

	if (accessResult.rowCount === 0) {
		const error = new Error("You do not have access to this team chat");
		error.code = "TEAM_ACCESS_DENIED";
		throw error;
	}
}

export async function createChatMessage({ team_member_id, game_id, message, acting_user_id, chat_type = 'game' }, queryExecutor = pool) {
	const normalizedTeamMemberId = normalizeId(team_member_id);
	const normalizedGameId = normalizeId(game_id);
	const normalizedMessage = normalizeText(message);
	const normalizedActingUserId = normalizeUserId(acting_user_id);
	const normalizedChatType = typeof chat_type === 'string' ? chat_type.trim().toLowerCase() : 'game';

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	if (!normalizedMessage) {
		const error = new Error("message is required");
		error.code = "MESSAGE_REQUIRED";
		throw error;
	}

	if (normalizedChatType !== 'game' && normalizedChatType !== 'team') {
		const error = new Error("chat_type must be 'game' or 'team'");
		error.code = "INVALID_CHAT_TYPE";
		throw error;
	}

	if (normalizedChatType === 'team' && normalizedTeamMemberId === null) {
		const error = new Error("team_member_id must be a valid positive integer");
		error.code = "INVALID_TEAM_MEMBER_ID";
		throw error;
	}

	if (normalizedChatType === 'game' && normalizedTeamMemberId === null && normalizedGameId === null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	if (normalizedChatType === 'team') {
		const memberCheck = await queryExecutor.query(
			`SELECT tm.team_member_id, tm.team_id, tm.user_id, tm.board_number, tm.piece_color, t.game_id
			 FROM gameplay.team_members tm
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 WHERE tm.team_member_id = $1
			 LIMIT 1`,
			[normalizedTeamMemberId]
		);

		if (memberCheck.rowCount === 0) {
			const error = new Error("Team member not found");
			error.code = "TEAM_MEMBER_NOT_FOUND";
			throw error;
		}

		const memberContext = memberCheck.rows[0];
		const normalizedMemberUserId = normalizeUserId(memberContext.user_id);

		if (!normalizedMemberUserId || normalizedMemberUserId !== normalizedActingUserId) {
			const error = new Error("You can only post chat as your own team member slot");
			error.code = "TEAM_MEMBER_ACCESS_DENIED";
			throw error;
		}

		await ensureUserCanAccessTeam({ teamId: memberContext.team_id, actingUserId: normalizedActingUserId }, queryExecutor);

		const result = await queryExecutor.query(
			`INSERT INTO gameplay.game_chats (team_member_id, sender_user_id, message, is_system, chat_type)
			 VALUES ($1, $2::uuid, $3, FALSE, 'team')
			 RETURNING ${CHAT_SELECT_FIELDS}, sender_user_id, chat_type`,
			[normalizedTeamMemberId, acting_user_id, normalizedMessage]
		);

		return {
			...result.rows[0],
			game_id: memberContext.game_id,
			team_id: memberContext.team_id,
			board_number: memberContext.board_number,
			piece_color: memberContext.piece_color,
		};
	}

	if (normalizedTeamMemberId !== null) {
		const memberCheck = await queryExecutor.query(
			`SELECT tm.team_member_id, tm.team_id, tm.user_id, tm.board_number, tm.piece_color, t.game_id
			 FROM gameplay.team_members tm
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 WHERE tm.team_member_id = $1
			 LIMIT 1`,
			[normalizedTeamMemberId]
		);

		if (memberCheck.rowCount > 0) {
			const memberContext = memberCheck.rows[0];
			const normalizedMemberUserId = normalizeUserId(memberContext.user_id);

			if (normalizedMemberUserId && normalizedMemberUserId === normalizedActingUserId) {
				await ensureUserCanAccessGame({ gameId: memberContext.game_id, actingUserId: normalizedActingUserId }, queryExecutor);

				const result = await queryExecutor.query(
					`INSERT INTO gameplay.game_chats (team_member_id, sender_user_id, message, is_system, chat_type)
					 VALUES ($1, $2::uuid, $3, FALSE, 'game')
					 RETURNING ${CHAT_SELECT_FIELDS}, sender_user_id, chat_type`,
					[normalizedTeamMemberId, acting_user_id, normalizedMessage]
				);

				return {
					...result.rows[0],
					game_id: memberContext.game_id,
					team_id: memberContext.team_id,
					board_number: memberContext.board_number,
					piece_color: memberContext.piece_color,
				};
			}
		}
	}

	await ensureUserCanAccessGame({ gameId: normalizedGameId, actingUserId: normalizedActingUserId }, queryExecutor);

	const result = await queryExecutor.query(
		`INSERT INTO gameplay.game_chats (team_member_id, sender_user_id, message, is_system, chat_type)
		 VALUES (NULL, $1::uuid, $2, FALSE, 'game')
		 RETURNING ${CHAT_SELECT_FIELDS}, sender_user_id, chat_type`,
		[acting_user_id, normalizedMessage]
	);

	return {
		...result.rows[0],
		game_id: normalizedGameId,
		team_id: null,
		board_number: null,
		piece_color: null,
	};
}

export async function getChatMessagesByGameId({ game_id, chat_type, acting_user_id }, queryExecutor = pool) {
	const normalizedGameId = normalizeId(game_id);
	const normalizedChatType = typeof chat_type === 'string' ? chat_type.trim().toLowerCase() : 'game';
	const normalizedActingUserId = normalizeUserId(acting_user_id);

	if (normalizedGameId === null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	if (normalizedChatType !== 'game' && normalizedChatType !== 'team') {
		const error = new Error("chat_type must be 'game' or 'team'");
		error.code = "INVALID_CHAT_TYPE";
		throw error;
	}

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	await ensureUserCanAccessGame({ gameId: normalizedGameId, actingUserId: normalizedActingUserId }, queryExecutor);

	const result = await queryExecutor.query(
		`SELECT 
			gc.chat_id, 
			gc.team_member_id, 
			gc.sender_user_id,
			gc.message, 
			gc.is_system, 
			gc.created_at,
			gc.chat_type,
			tm.team_id,
			COALESCE(u_member.username, u_sender.username) AS username,
			COALESCE(u_member.avatar, u_sender.avatar) AS avatar
		FROM gameplay.game_chats gc
		LEFT JOIN gameplay.team_members tm ON gc.team_member_id = tm.team_member_id
		LEFT JOIN gameplay.teams t_member ON tm.team_id = t_member.team_id
		LEFT JOIN neon_auth.users u_member ON tm.user_id = u_member.user_id
		LEFT JOIN neon_auth.users u_sender ON gc.sender_user_id = u_sender.user_id
		WHERE (
			t_member.game_id = $1
			OR (t_member.game_id IS NULL AND gc.chat_type = 'game' AND EXISTS (
				SELECT 1
				FROM gameplay.games g_owner
				WHERE g_owner.game_id = $1
				  AND (
					LOWER(g_owner.user_id::text) = LOWER(COALESCE(gc.sender_user_id::text, ''))
					OR EXISTS (
						SELECT 1
						FROM gameplay.inbox_items ii
						WHERE ii.item_type = 'game_invite'
						  AND ii.source_id = g_owner.game_id
						  AND LOWER(ii.user_id::text) = LOWER(COALESCE(gc.sender_user_id::text, ''))
					)
				  )
			))
		)
		AND gc.chat_type = $2
		ORDER BY gc.created_at ASC`,
		[normalizedGameId, normalizedChatType]
	);

	return result.rows.map((row) => ({
		chat_id: row.chat_id,
		team_member_id: row.team_member_id,
		sender_user_id: row.sender_user_id,
		message: row.message,
		is_system: row.is_system,
		created_at: row.created_at,
		chat_type: row.chat_type,
		team_id: row.team_id,
		username: row.username,
		avatar: row.avatar,
	}));
}

export async function getChatMessagesByTeamId({ team_id, chat_type, acting_user_id }, queryExecutor = pool) {
	const normalizedTeamId = normalizeId(team_id);
	const normalizedChatType = typeof chat_type === 'string' ? chat_type.trim().toLowerCase() : 'team';
	const normalizedActingUserId = normalizeUserId(acting_user_id);

	if (normalizedTeamId === null) {
		const error = new Error("team_id must be a valid positive integer");
		error.code = "INVALID_TEAM_ID";
		throw error;
	}

	if (normalizedChatType !== 'team') {
		const error = new Error("Team chat must use chat_type 'team'");
		error.code = "INVALID_CHAT_TYPE";
		throw error;
	}

	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	await ensureUserCanAccessTeam({ teamId: normalizedTeamId, actingUserId: normalizedActingUserId }, queryExecutor);

	const result = await queryExecutor.query(
		`SELECT 
			gc.chat_id, 
			gc.team_member_id, 
			gc.message, 
			gc.is_system, 
			gc.created_at,
			gc.chat_type,
			tm.team_id,
			u.username,
			u.avatar
		FROM gameplay.game_chats gc
		JOIN gameplay.team_members tm ON gc.team_member_id = tm.team_member_id
		JOIN neon_auth.users u ON tm.user_id = u.user_id
		WHERE tm.team_id = $1
		AND gc.chat_type = 'team'
		ORDER BY gc.created_at ASC`,
		[normalizedTeamId]
	);

	return result.rows.map((row) => ({
		chat_id: row.chat_id,
		team_member_id: row.team_member_id,
		message: row.message,
		is_system: row.is_system,
		created_at: row.created_at,
		chat_type: row.chat_type,
		team_id: row.team_id,
		username: row.username,
		avatar: row.avatar,
	}));
}
