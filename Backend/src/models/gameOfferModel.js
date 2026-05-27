import pool from "../config/db.js";
import { applyRatingForFinishedGame } from "../services/game/ratingService.js";

const GAME_SELECT_FIELDS =
	"game_id, status, result, started_at, finished_at, time_control, increment, created_by, move_count, user_id, invite_token, game_name, rated_game, allow_spectators, public_game, draw_offer_count, winner_team_id, finish_reason, clock_last_synced_at, active_board1_team_member_id, active_board2_team_member_id";

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
	return normalizeText(value).toLowerCase();
}

async function getTeamMemberContextForOffer(teamMemberId, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT
			tm.team_member_id,
			tm.team_id,
			tm.user_id,
			tm.joined_at,
			tm.draw_offer_accepted,
			tm.forfeit_offer_accepted,
			t.team_name,
			t.game_id,
			g.status,
			g.result
		 FROM gameplay.team_members tm
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 JOIN gameplay.games g ON g.game_id = t.game_id
		 WHERE tm.team_member_id = $1
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

function validateOfferActor({ context, actingUserId }) {
	const normalizedActingUserId = normalizeUserId(actingUserId);
	if (!normalizedActingUserId) {
		const error = new Error("Authentication required");
		error.code = "AUTH_USER_REQUIRED";
		throw error;
	}

	const memberUserId = normalizeUserId(context.user_id);
	if (!memberUserId || memberUserId !== normalizedActingUserId) {
		const error = new Error("You can only submit offers for your own team member slot");
		error.code = "TEAM_MEMBER_ACCESS_DENIED";
		throw error;
	}
}

function validateOfferContext(context) {
	if (!context.joined_at) {
		const error = new Error("Team member has not joined yet");
		error.code = "TEAM_MEMBER_NOT_JOINED";
		throw error;
	}

	if (String(context.status).toLowerCase() === "finished") {
		const error = new Error("Game is already finished");
		error.code = "GAME_ALREADY_FINISHED";
		throw error;
	}
}

async function getGameById(gameId, queryExecutor = pool) {
	const result = await queryExecutor.query(
		`SELECT ${GAME_SELECT_FIELDS}
		 FROM gameplay.games
		 WHERE game_id = $1
		 LIMIT 1`,
		[gameId]
	);

	return result.rows[0] ?? null;
}

export async function submitDrawOffer({ team_member_id, acting_user_id }, queryExecutor = pool) {
	const normalizedTeamMemberId = normalizeId(team_member_id);

	if (normalizedTeamMemberId === null) {
		const error = new Error("team_member_id must be a valid positive integer");
		error.code = "INVALID_TEAM_MEMBER_ID";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		const context = await getTeamMemberContextForOffer(normalizedTeamMemberId, executor);
		validateOfferActor({ context, actingUserId: acting_user_id });
		validateOfferContext(context);

		if (context.draw_offer_accepted) {
			const error = new Error("Draw offer already accepted by this member");
			error.code = "DRAW_ALREADY_ACCEPTED";
			throw error;
		}

		await executor.query(
			"UPDATE gameplay.team_members SET draw_offer_accepted = TRUE WHERE team_member_id = $1",
			[normalizedTeamMemberId]
		);

		const countsResult = await executor.query(
			`SELECT
				COUNT(*) FILTER (WHERE NOT tm.is_bot)::int AS total_members,
				COUNT(*) FILTER (WHERE tm.draw_offer_accepted AND NOT tm.is_bot)::int AS accepted_members
			 FROM gameplay.team_members tm
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 WHERE t.game_id = $1`,
			[context.game_id]
		);

		const { total_members: totalMembers, accepted_members: acceptedMembers } = countsResult.rows[0];

		const shouldFinishAsDraw = totalMembers > 0 && acceptedMembers >= totalMembers;
		const gameUpdateResult = shouldFinishAsDraw
			? await executor.query(
					`UPDATE gameplay.games
					 SET draw_offer_count = $1,
						 result = 'draw',
						 status = 'finished',
						 finished_at = COALESCE(finished_at, NOW())
					 WHERE game_id = $2
					 RETURNING ${GAME_SELECT_FIELDS}`,
					[acceptedMembers, context.game_id]
				)
			: await executor.query(
					`UPDATE gameplay.games
					 SET draw_offer_count = $1
					 WHERE game_id = $2
					 RETURNING ${GAME_SELECT_FIELDS}`,
					[acceptedMembers, context.game_id]
				);

		if (client) await client.query("COMMIT");

		return {
			team_member_id: normalizedTeamMemberId,
			accepted_count: acceptedMembers,
			required_count: totalMembers,
			game: gameUpdateResult.rows[0],
		};
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}

export async function submitForfeitOffer({ team_member_id, acting_user_id }, queryExecutor = pool) {
	const normalizedTeamMemberId = normalizeId(team_member_id);

	if (normalizedTeamMemberId === null) {
		const error = new Error("team_member_id must be a valid positive integer");
		error.code = "INVALID_TEAM_MEMBER_ID";
		throw error;
	}

	const isPool = typeof queryExecutor.connect === "function";
	const client = isPool ? await queryExecutor.connect() : null;
	const executor = client ?? queryExecutor;

	try {
		if (client) await client.query("BEGIN");

		const context = await getTeamMemberContextForOffer(normalizedTeamMemberId, executor);
		validateOfferActor({ context, actingUserId: acting_user_id });
		validateOfferContext(context);

		if (context.forfeit_offer_accepted) {
			const error = new Error("Forfeit offer already accepted by this member");
			error.code = "FORFEIT_ALREADY_ACCEPTED";
			throw error;
		}

		await executor.query(
			"UPDATE gameplay.team_members SET forfeit_offer_accepted = TRUE WHERE team_member_id = $1",
			[normalizedTeamMemberId]
		);

		const teamCountsResult = await executor.query(
			`SELECT
				COUNT(*) FILTER (WHERE NOT is_bot)::int AS total_members,
				COUNT(*) FILTER (WHERE forfeit_offer_accepted AND NOT is_bot)::int AS accepted_members
			 FROM gameplay.team_members
			 WHERE team_id = $1`,
			[context.team_id]
		);

		const { total_members: totalMembers, accepted_members: acceptedMembers } = teamCountsResult.rows[0];

		const forfeitingTeamResult = await executor.query(
			`UPDATE gameplay.teams
			 SET forfeit_offer_count = $1
			 WHERE team_id = $2
			 RETURNING team_id, game_id, team_name, forfeit_offer_count`,
			[acceptedMembers, context.team_id]
		);

		const forfeitingTeam = forfeitingTeamResult.rows[0];

		if (!forfeitingTeam) {
			const error = new Error("Forfeiting team not found");
			error.code = "TEAM_NOT_FOUND";
			throw error;
		}

		let game = await getGameById(context.game_id, executor);
		let winnerTeam = null;
		const shouldFinishWithForfeit = totalMembers > 0 && acceptedMembers >= totalMembers;

		if (shouldFinishWithForfeit) {
			const winnerResult = await executor.query(
				`SELECT team_id, team_name
				 FROM gameplay.teams
				 WHERE game_id = $1 AND team_id <> $2
				 ORDER BY team_id ASC
				 LIMIT 1`,
				[context.game_id, context.team_id]
			);

			if (winnerResult.rowCount === 0) {
				const error = new Error("Winner team not found");
				error.code = "WINNER_TEAM_NOT_FOUND";
				throw error;
			}

			winnerTeam = winnerResult.rows[0];

			const gameUpdateResult = await executor.query(
				`UPDATE gameplay.games
				 SET status = 'finished',
					 result = $1,
					 finished_at = COALESCE(finished_at, NOW())
				 WHERE game_id = $2
				 RETURNING ${GAME_SELECT_FIELDS}`,
				[winnerTeam.team_name, context.game_id]
			);

			game = gameUpdateResult.rows[0];
		}

		if (client) await client.query("COMMIT");

		if (shouldFinishWithForfeit && winnerTeam && game) {
			applyRatingForFinishedGame({
				gameId: game.game_id,
				winnerTeamId: winnerTeam.team_id,
				ratedGame: game.rated_game,
			}).catch((err) => console.error("[rating] Failed to apply rating:", err));
		}

		return {
			team_member_id: normalizedTeamMemberId,
			accepted_count: acceptedMembers,
			required_count: totalMembers,
			forfeiting_team: forfeitingTeam,
			winner_team: winnerTeam,
			game,
		};
	} catch (error) {
		if (client) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (client) client.release();
	}
}
