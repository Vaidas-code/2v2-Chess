import { submitDrawOffer, submitForfeitOffer } from "../models/gameOfferModel.js";
import { emitGameOfferUpdated, emitGameStatusUpdated, emitLobbyGameUpdated } from "../realtime/gameSocketHub.js";

function getGameOfferErrorResponse(error) {
	if (error?.code === "INVALID_TEAM_MEMBER_ID") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "AUTH_USER_REQUIRED") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_ACCESS_DENIED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "TEAM_MEMBER_NOT_FOUND" || error?.code === "TEAM_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (
		error?.code === "TEAM_MEMBER_NOT_JOINED" ||
		error?.code === "GAME_ALREADY_FINISHED" ||
		error?.code === "DRAW_ALREADY_ACCEPTED" ||
		error?.code === "FORFEIT_ALREADY_ACCEPTED"
	) {
		return { status: 409, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

export async function offerDrawHandler(req, res) {
	const teamMemberId = req.body?.team_member_id;
	const actingUserId = req.auth?.id;

	if (!teamMemberId) {
		return res.status(400).json({ ok: false, error: "team_member_id is required" });
	}

	try {
		const draw_offer = await submitDrawOffer({
			team_member_id: teamMemberId,
			acting_user_id: actingUserId,
		});

		emitGameOfferUpdated({
			gameId: draw_offer.game?.game_id,
			offer: {
				type: "draw",
				...draw_offer,
			},
		});

		if (draw_offer.game?.game_id) {
			emitGameStatusUpdated({
				gameId: draw_offer.game.game_id,
				game: draw_offer.game,
			});

			emitLobbyGameUpdated({
				game: draw_offer.game,
			});
		}

		return res.status(200).json({ ok: true, draw_offer });
	} catch (error) {
		console.error("Error submitting draw offer:", error);
		const { status, error: message } = getGameOfferErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function offerForfeitHandler(req, res) {
	const teamMemberId = req.body?.team_member_id;
	const actingUserId = req.auth?.id;

	if (!teamMemberId) {
		return res.status(400).json({ ok: false, error: "team_member_id is required" });
	}

	try {
		const forfeit_offer = await submitForfeitOffer({
			team_member_id: teamMemberId,
			acting_user_id: actingUserId,
		});

		emitGameOfferUpdated({
			gameId: forfeit_offer.game?.game_id,
			offer: {
				type: "forfeit",
				...forfeit_offer,
			},
		});

		if (forfeit_offer.game?.game_id) {
			emitGameStatusUpdated({
				gameId: forfeit_offer.game.game_id,
				game: forfeit_offer.game,
			});

			emitLobbyGameUpdated({
				game: forfeit_offer.game,
			});
		}

		return res.status(200).json({ ok: true, forfeit_offer });
	} catch (error) {
		console.error("Error submitting forfeit offer:", error);
		const { status, error: message } = getGameOfferErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}
