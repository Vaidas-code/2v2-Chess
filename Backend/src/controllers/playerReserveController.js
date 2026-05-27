import { getReservesByTeamMemberId } from "../models/playerReserveModel.js";

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

function getReservesErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "GAME_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "INVALID_TEAM_MEMBER_ID") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

export async function getTeamMemberReservesHandler(req, res) {
	const teamMemberId = normalizeId(req.params?.teamMemberId);
	const actingUserId = req.auth?.id;

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	if (teamMemberId === null) {
		return res.status(400).json({
			ok: false,
			error: "team_member_id must be a valid positive integer",
		});
	}

	try {
		const data = await getReservesByTeamMemberId(teamMemberId, undefined, {
			acting_user_id: actingUserId,
		});
		return res.status(200).json({ ok: true, ...data });
	} catch (error) {
		console.error("Error fetching team member reserves:", error);
		const { status, error: msg } = getReservesErrorResponse(error);
		return res.status(status).json({ ok: false, error: msg });
	}
}
