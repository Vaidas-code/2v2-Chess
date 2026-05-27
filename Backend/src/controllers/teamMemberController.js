import { joinBotTeamMember, joinTeamMember, leaveTeamMember, listAllBotNames, removeBotTeamMember } from "../models/teamMemberModel.js";
import { emitGameTeamMemberUpdated } from "../realtime/gameSocketHub.js";

function getJoinTeamMemberErrorResponse(error) {
	if (
		error?.code === "INVALID_TEAM_MEMBER_ID" ||
		error?.code === "INVALID_USER_ID" ||
		error?.code === "USER_ID_REQUIRED"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "USER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_ALREADY_JOINED") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "USER_ALREADY_IN_ACTIVE_GAME") {
		return { status: 409, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getJoinBotTeamMemberErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "GAME_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (
		error?.code === "INVALID_TEAM_MEMBER_ID" ||
		error?.code === "USERNAME_REQUIRED" ||
		error?.code === "INVALID_BOT_USERNAME"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "BOT_USER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_ALREADY_JOINED") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "USER_ALREADY_IN_ACTIVE_GAME") {
		return { status: 409, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

export async function joinTeamMemberHandler(req, res) {
	const teamMemberId = req.params?.teamMemberId;
	const userId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!userId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const member = await joinTeamMember({ team_member_id: teamMemberId, user_id: userId });

		emitGameTeamMemberUpdated({
			gameId: member.game_id,
			teamMember: member,
			action: "joined-human",
		});

		return res.status(200).json({ ok: true, team_member: member });
	} catch (error) {
		console.error("Error joining team member:", error);
		const { status, error: msg } = getJoinTeamMemberErrorResponse(error);
		return res.status(status).json({ ok: false, error: msg });
	}
}

export async function joinBotTeamMemberHandler(req, res) {
	const teamMemberId = req.params?.teamMemberId;
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";
	const username = typeof req.body?.username === "string" ? req.body.username.trim() : String(req.body?.username ?? "").trim();

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const member = await joinBotTeamMember({
			team_member_id: teamMemberId,
			username,
			acting_user_id: actingUserId,
		});

		emitGameTeamMemberUpdated({
			gameId: member.game_id,
			teamMember: member,
			action: "joined-bot",
		});

		return res.status(200).json({ ok: true, team_member: member });
	} catch (error) {
		console.error("Error adding bot team member:", error);
		const { status, error: msg } = getJoinBotTeamMemberErrorResponse(error);
		return res.status(status).json({ ok: false, error: msg });
	}
}

function getLeaveBotTeamMemberErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (
		error?.code === "INVALID_TEAM_MEMBER_ID" ||
		error?.code === "USER_ID_REQUIRED" ||
		error?.code === "INVALID_USER_ID"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (error?.code === "NOT_SLOT_OCCUPANT") {
		return { status: 403, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getRemoveBotTeamMemberErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "GAME_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (
		error?.code === "INVALID_TEAM_MEMBER_ID" ||
		error?.code === "USER_ID_REQUIRED" ||
		error?.code === "INVALID_USER_ID"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_ALREADY_EMPTY" || error?.code === "TEAM_MEMBER_NOT_BOT") {
		return { status: 409, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

export async function leaveTeamMemberHandler(req, res) {
	const teamMemberId = req.params?.teamMemberId;
	const userId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!userId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const member = await leaveTeamMember({ team_member_id: teamMemberId, user_id: userId });

		emitGameTeamMemberUpdated({
			gameId: member.game_id,
			teamMember: member,
			action: "left",
		});

		return res.status(200).json({ ok: true, team_member: member });
	} catch (error) {
		console.error("Error leaving team member:", error);
		const { status, error: msg } = getLeaveBotTeamMemberErrorResponse(error);
		return res.status(status).json({ ok: false, error: msg });
	}
}

export async function removeBotTeamMemberHandler(req, res) {
	const teamMemberId = req.params?.teamMemberId;
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const member = await removeBotTeamMember({
			team_member_id: teamMemberId,
			acting_user_id: actingUserId,
		});

		emitGameTeamMemberUpdated({
			gameId: member.game_id,
			teamMember: member,
			action: "removed-bot",
		});

		return res.status(200).json({ ok: true, team_member: member });
	} catch (error) {
		console.error("Error removing bot team member:", error);
		const { status, error: msg } = getRemoveBotTeamMemberErrorResponse(error);
		return res.status(status).json({ ok: false, error: msg });
	}
}

export async function getAllBotNamesHandler(req, res) {
	try {
		const bot_names = await listAllBotNames();
		return res.status(200).json({ ok: true, bot_names });
	} catch (error) {
		console.error("Error fetching bot names:", error);
		return res.status(500).json({ ok: false, error: "Internal server error" });
	}
}
