import { createChatMessage, getChatMessagesByGameId, getChatMessagesByTeamId } from "../models/chatModel.js";
import { emitGameChatCreated } from "../realtime/gameSocketHub.js";

function getCreateChatErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (
		error?.code === "INVALID_TEAM_MEMBER_ID" ||
		error?.code === "INVALID_GAME_ID" ||
		error?.code === "MESSAGE_REQUIRED" ||
		error?.code === "INVALID_CHAT_TYPE"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (error?.code === "GAME_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getGetChatErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "GAME_ACCESS_DENIED" || error?.code === "TEAM_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (
		error?.code === "INVALID_GAME_ID" ||
		error?.code === "INVALID_TEAM_ID" ||
		error?.code === "INVALID_CHAT_TYPE"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "GAME_NOT_FOUND" || error?.code === "TEAM_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

export async function postChatMessage(req, res) {
	const teamMemberId = req.body?.team_member_id;
	const gameId = req.body?.game_id;
	const actingUserId = req.auth?.id;
	const message = typeof req.body?.message === "string" ? req.body.message.trim() : String(req.body?.message ?? "").trim();
	const chatType = typeof req.body?.chat_type === "string" ? req.body.chat_type.trim().toLowerCase() : "game";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	if (!message) {
		return res.status(400).json({ ok: false, error: "message is required" });
	}

	if (chatType === "team" && !teamMemberId) {
		return res.status(400).json({ ok: false, error: "team_member_id is required for team chat" });
	}

	if (chatType === "game" && !teamMemberId && !gameId) {
		return res.status(400).json({ ok: false, error: "game_id is required for game chat when not joined to a slot" });
	}

	try {
		const chat = await createChatMessage({
			team_member_id: teamMemberId,
			game_id: gameId,
			message,
			acting_user_id: actingUserId,
			chat_type: chatType,
		});

		emitGameChatCreated({
			gameId: chat.game_id,
			chat,
		});

		return res.status(201).json({ ok: true, chat });
	} catch (error) {
		console.error("Error creating chat message:", error);
		const { status, error: msg } = getCreateChatErrorResponse(error);
		return res.status(status).json({ ok: false, error: msg });
	}
}

export async function getChatMessages(req, res) {
	const gameId = typeof req.params?.gameId === "string" ? req.params.gameId.trim() : "";
	const chatType = typeof req.query?.chat_type === "string" ? req.query.chat_type.trim() : "game";
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	if (!gameId) {
		return res.status(400).json({ ok: false, error: "gameId is required" });
	}

	try {
		const messages = await getChatMessagesByGameId({
			game_id: gameId,
			chat_type: chatType,
			acting_user_id: actingUserId,
		});

		return res.status(200).json({ ok: true, messages });
	} catch (error) {
		console.error("Error fetching chat messages:", error);
		const { status, error: msg } = getGetChatErrorResponse(error);
		return res.status(status).json({ ok: false, error: msg });
	}
}

export async function getTeamChatMessages(req, res) {
	const teamId = typeof req.params?.teamId === "string" ? req.params.teamId.trim() : "";
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	if (!teamId) {
		return res.status(400).json({ ok: false, error: "teamId is required" });
	}

	try {
		const messages = await getChatMessagesByTeamId({
			team_id: teamId,
			chat_type: "team",
			acting_user_id: actingUserId,
		});

		return res.status(200).json({ ok: true, messages });
	} catch (error) {
		console.error("Error fetching team chat messages:", error);
		const { status, error: msg } = getGetChatErrorResponse(error);
		return res.status(status).json({ ok: false, error: msg });
	}
}
