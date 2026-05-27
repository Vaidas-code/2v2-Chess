import {
	acceptInboxInvite,
	createGameInviteInboxItem,
	deleteInboxItemForUser,
	getInboxItemsForUser,
	getInboxSummaryForUser,
} from "../models/inboxModel.js";
import { emitGameInviteUpdated, emitInboxUpdated } from "../realtime/gameSocketHub.js";

function getInboxErrorResponse(error) {
	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (
		error?.code === "INVALID_GAME_ID" ||
		error?.code === "USERNAME_REQUIRED" ||
		error?.code === "INVALID_INBOX_ITEM_ID"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "GAME_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "INVITE_SELF") {
		return { status: 409, error: error.message };
	}

	if (
		error?.code === "USER_NOT_FOUND" ||
		error?.code === "GAME_NOT_FOUND" ||
		error?.code === "INBOX_ITEM_NOT_FOUND"
	) {
		return { status: 404, error: error.message };
	}

	if (error?.code === "GAME_ALREADY_FINISHED") {
		return { status: 409, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

export async function sendGameInviteToInbox(req, res) {
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";
	const gameId = req.body?.game_id;
	const username = typeof req.body?.username === "string" ? req.body.username.trim() : String(req.body?.username ?? "").trim();

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const invite = await createGameInviteInboxItem({
			game_id: gameId,
			username,
			sender_user_id: actingUserId,
		});

		emitInboxUpdated({
			userId: invite.user_id,
			reason: "invite-received",
			itemType: invite.item_type,
		});

		emitGameInviteUpdated({
			gameId: invite.source_id,
			action: "sent",
			invite,
		});

		return res.status(201).json({ ok: true, invite });
	} catch (error) {
		console.error("Error sending game invite to inbox:", error);
		const { status, error: message } = getInboxErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function getInboxItems(req, res) {
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";
	const limit = Number(req.query?.limit ?? 100);

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const items = await getInboxItemsForUser({ user_id: actingUserId, limit });
		return res.status(200).json({ ok: true, items });
	} catch (error) {
		console.error("Error fetching inbox items:", error);
		const { status, error: message } = getInboxErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function getInboxSummary(req, res) {
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const summary = await getInboxSummaryForUser({ user_id: actingUserId });
		return res.status(200).json({ ok: true, summary });
	} catch (error) {
		console.error("Error fetching inbox summary:", error);
		const { status, error: message } = getInboxErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function acceptInboxInviteItem(req, res) {
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";
	const inboxItemId = typeof req.params?.inboxItemId === "string" ? req.params.inboxItemId.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const acceptedInvite = await acceptInboxInvite({
			inbox_item_id: inboxItemId,
			user_id: actingUserId,
		});

		emitInboxUpdated({
			userId: actingUserId,
			reason: "invite-accepted",
			itemType: "game_invite",
		});

		emitInboxUpdated({
			userId: acceptedInvite.sender_user_id,
			reason: "invite-accepted-by-recipient",
			itemType: "game_invite",
		});

		emitGameInviteUpdated({
			gameId: acceptedInvite.game_id,
			action: "accepted",
			invite: acceptedInvite,
		});

		return res.status(200).json({ ok: true, invite: acceptedInvite });
	} catch (error) {
		console.error("Error accepting inbox invite:", error);
		const { status, error: message } = getInboxErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function removeInboxItem(req, res) {
	const actingUserId = typeof req.auth?.id === "string" ? req.auth.id.trim() : "";
	const inboxItemId = typeof req.params?.inboxItemId === "string" ? req.params.inboxItemId.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const deletedItem = await deleteInboxItemForUser({
			inbox_item_id: inboxItemId,
			user_id: actingUserId,
		});

		emitInboxUpdated({
			userId: actingUserId,
			reason: "invite-removed",
			itemType: "game_invite",
		});

		emitInboxUpdated({
			userId: deletedItem.sender_user_id,
			reason: "invite-responded",
			itemType: "game_invite",
		});

		emitGameInviteUpdated({
			gameId: deletedItem.source_id,
			action: "declined",
			invite: deletedItem,
		});

		return res.status(200).json({ ok: true, item: deletedItem });
	} catch (error) {
		console.error("Error deleting inbox item:", error);
		const { status, error: message } = getInboxErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}
