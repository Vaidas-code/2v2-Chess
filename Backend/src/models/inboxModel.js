import pool from "../config/db.js";

function normalizeText(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim();
}

function normalizeUserId(value) {
	return normalizeText(value).toLowerCase();
}

function normalizePositiveInteger(value) {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}

	if (typeof value !== "string") {
		return null;
	}

	const normalizedValue = value.trim();
	if (!normalizedValue) {
		return null;
	}

	const parsedValue = Number(normalizedValue);
	return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
}

async function ensureUserCanAccessGame({ gameId, userId }, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT 1
		 FROM gameplay.games g
		 WHERE g.game_id = $1 AND LOWER(g.user_id::text) = $2

		 UNION

		 SELECT 1
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1 AND LOWER(tm.user_id::text) = $2
		 LIMIT 1`,
		[gameId, userId]
	);

	if (result.rowCount === 0) {
		const error = new Error("You do not have access to this game");
		error.code = "GAME_ACCESS_DENIED";
		throw error;
	}
}

export async function createGameInviteInboxItem({ game_id, username, sender_user_id }, queryExecutor = pool) {
	const normalizedGameId = normalizePositiveInteger(game_id);
	const normalizedUsername = normalizeText(username);
	const normalizedSenderUserId = normalizeUserId(sender_user_id);

	if (normalizedGameId === null) {
		const error = new Error("game_id must be a valid positive integer");
		error.code = "INVALID_GAME_ID";
		throw error;
	}

	if (!normalizedUsername) {
		const error = new Error("username is required");
		error.code = "USERNAME_REQUIRED";
		throw error;
	}

	if (!normalizedSenderUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		const senderResult = await executor.query(
			"SELECT user_id, username FROM neon_auth.users WHERE LOWER(user_id::text) = $1 LIMIT 1",
			[normalizedSenderUserId]
		);

		if (senderResult.rowCount === 0) {
			const error = new Error("Sender user not found");
			error.code = "USER_NOT_FOUND";
			throw error;
		}

		const gameResult = await executor.query(
			`SELECT game_id, status, game_name
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
		const normalizedGameStatus = normalizeText(game.status).toLowerCase();

		if (normalizedGameStatus === "finished") {
			const error = new Error("Cannot invite to a finished game");
			error.code = "GAME_ALREADY_FINISHED";
			throw error;
		}

		await ensureUserCanAccessGame(
			{ gameId: normalizedGameId, userId: normalizedSenderUserId },
			executor
		);

		const recipientResult = await executor.query(
			`SELECT user_id, username
			 FROM neon_auth.users
			 WHERE LOWER(username) = LOWER($1)
			 LIMIT 1`,
			[normalizedUsername]
		);

		if (recipientResult.rowCount === 0) {
			const error = new Error("User not found");
			error.code = "USER_NOT_FOUND";
			throw error;
		}

		const recipient = recipientResult.rows[0];
		const normalizedRecipientUserId = normalizeUserId(recipient.user_id);

		if (normalizedRecipientUserId === normalizedSenderUserId) {
			const error = new Error("You cannot invite yourself");
			error.code = "INVITE_SELF";
			throw error;
		}

		const insertResult = await executor.query(
			`INSERT INTO gameplay.inbox_items (
				user_id,
				item_type,
				source_id,
				message,
				received_at,
				is_read,
				read_at,
				sender_user_id
			)
			VALUES ($1::uuid, 'game_invite', $2, NULL, NOW(), FALSE, NULL, $3::uuid)
			ON CONFLICT (user_id, item_type, source_id)
			DO UPDATE SET
				sender_user_id = EXCLUDED.sender_user_id,
				received_at = NOW(),
				is_read = FALSE,
				read_at = NULL
			RETURNING inbox_item_id, user_id, item_type, source_id, message, received_at, is_read, read_at, sender_user_id`,
			[recipient.user_id, normalizedGameId, senderResult.rows[0].user_id]
		);

		if (client) await client.query("COMMIT");

		return {
			...insertResult.rows[0],
			game_name: game.game_name,
			sender_username: senderResult.rows[0].username,
			recipient_username: recipient.username,
		};
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function getInboxItemsForUser({ user_id, limit = 100 }, queryExecutor = pool) {
	const normalizedUserId = normalizeUserId(user_id);

	if (!normalizedUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 100;

	const result = await queryExecutor.query(
		`SELECT
			ii.inbox_item_id,
			ii.user_id,
			ii.item_type,
			ii.source_id,
			ii.message,
			ii.received_at,
			ii.is_read,
			ii.read_at,
			ii.sender_user_id,
			sender.username AS sender_username,
			g.game_name,
			g.status AS game_status
		 FROM gameplay.inbox_items ii
		 LEFT JOIN neon_auth.users sender ON sender.user_id = ii.sender_user_id
		 LEFT JOIN gameplay.games g ON ii.item_type = 'game_invite' AND g.game_id = ii.source_id
		 WHERE LOWER(ii.user_id::text) = $1
		 ORDER BY ii.received_at DESC, ii.inbox_item_id DESC
		 LIMIT $2`,
		[normalizedUserId, normalizedLimit]
	);

	return result.rows;
}

export async function getInboxSummaryForUser({ user_id }, queryExecutor = pool) {
	const normalizedUserId = normalizeUserId(user_id);

	if (!normalizedUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const result = await queryExecutor.query(
		`SELECT
			COUNT(*) FILTER (WHERE is_read = FALSE)::int AS unread_count,
			COUNT(*) FILTER (WHERE is_read = FALSE AND item_type = 'game_invite')::int AS unread_invite_count,
			COUNT(*) FILTER (WHERE is_read = FALSE AND item_type = 'chat_message')::int AS unread_chat_count
		 FROM gameplay.inbox_items
		 WHERE LOWER(user_id::text) = $1`,
		[normalizedUserId]
	);

	return result.rows[0] ?? {
		unread_count: 0,
		unread_invite_count: 0,
		unread_chat_count: 0,
	};
}

export async function acceptInboxInvite({ inbox_item_id, user_id }, queryExecutor = pool) {
	const normalizedInboxItemId = normalizePositiveInteger(inbox_item_id);
	const normalizedUserId = normalizeUserId(user_id);

	if (normalizedInboxItemId === null) {
		const error = new Error("inbox_item_id must be a valid positive integer");
		error.code = "INVALID_INBOX_ITEM_ID";
		throw error;
	}

	if (!normalizedUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const result = await queryExecutor.query(
		`UPDATE gameplay.inbox_items
		 SET is_read = TRUE,
			 read_at = COALESCE(read_at, NOW())
		 WHERE inbox_item_id = $1
		   AND LOWER(user_id::text) = $2
		   AND item_type = 'game_invite'
		 RETURNING inbox_item_id, source_id, item_type, user_id, sender_user_id`,
		[normalizedInboxItemId, normalizedUserId]
	);

	if (result.rowCount === 0) {
		const error = new Error("Invite not found");
		error.code = "INBOX_ITEM_NOT_FOUND";
		throw error;
	}

	const gameCheck = await queryExecutor.query(
		`SELECT game_id, status
		 FROM gameplay.games
		 WHERE game_id = $1
		 LIMIT 1`,
		[result.rows[0].source_id]
	);

	if (gameCheck.rowCount === 0) {
		const error = new Error("Game not found");
		error.code = "GAME_NOT_FOUND";
		throw error;
	}

	if (normalizeText(gameCheck.rows[0].status).toLowerCase() === "finished") {
		const error = new Error("Game is already finished");
		error.code = "GAME_ALREADY_FINISHED";
		throw error;
	}

	return {
		inbox_item_id: result.rows[0].inbox_item_id,
		game_id: gameCheck.rows[0].game_id,
		user_id: result.rows[0].user_id,
		sender_user_id: result.rows[0].sender_user_id,
		item_type: result.rows[0].item_type,
	};
}

export async function deleteInboxItemForUser({ inbox_item_id, user_id }, queryExecutor = pool) {
	const normalizedInboxItemId = normalizePositiveInteger(inbox_item_id);
	const normalizedUserId = normalizeUserId(user_id);

	if (normalizedInboxItemId === null) {
		const error = new Error("inbox_item_id must be a valid positive integer");
		error.code = "INVALID_INBOX_ITEM_ID";
		throw error;
	}

	if (!normalizedUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const result = await queryExecutor.query(
		`DELETE FROM gameplay.inbox_items
		 WHERE inbox_item_id = $1
		   AND LOWER(user_id::text) = $2
		 RETURNING inbox_item_id, source_id, item_type, user_id, sender_user_id`,
		[normalizedInboxItemId, normalizedUserId]
	);

	if (result.rowCount === 0) {
		const error = new Error("Inbox item not found");
		error.code = "INBOX_ITEM_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}
