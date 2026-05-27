import pool from "../config/db.js";
import { getLiveClockSnapshot } from "../services/game/liveMovePipelineService.js";

const GAME_SELECT_FIELDS =
	"game_id, status, result, started_at, finished_at, time_control, increment, created_by, move_count, user_id, invite_token, game_name, rated_game, allow_spectators, public_game, draw_offer_count, winner_team_id, finish_reason, clock_last_synced_at, active_board1_team_member_id, active_board2_team_member_id";

function normalizePositiveInteger(value) {
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

export async function getGameRealtimeSnapshot(gameId, queryExecutor = pool) {
	const normalizedGameId = normalizePositiveInteger(gameId);

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
	const liveClockSnapshot = await getLiveClockSnapshot(normalizedGameId, queryExecutor).catch(() => null);

	const teamsResult = await queryExecutor.query(
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
		[normalizedGameId]
	);

	const teamsMap = new Map();

	for (const row of teamsResult.rows) {
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

		const memberId = Number(row.team_member_id);
		const liveRemainingSeconds = Number(
			liveClockSnapshot?.remaining_seconds_by_member?.[memberId]
		);

		team.members.push({
			team_member_id: row.team_member_id,
			user_id: row.team_member_user_id,
			username: row.username ?? null,
			avatar: row.avatar ?? null,
			is_bot: row.is_bot,
			board_number: row.board_number,
			piece_color: row.piece_color,
			remaining_seconds: Number.isFinite(liveRemainingSeconds)
				? Math.max(0, Math.floor(liveRemainingSeconds))
				: Number(row.remaining_seconds ?? 0),
			draw_offer_accepted: row.draw_offer_accepted,
			forfeit_offer_accepted: row.forfeit_offer_accepted,
			joined_at: row.joined_at,
			is_available: isAvailable,
		});
	}

	const movesResult = await queryExecutor.query(
		`SELECT
			m.move_id,
			t.game_id,
			m.team_member_id,
			tm.team_id,
			tm.board_number,
			tm.piece_color,
			tm.user_id,
			tm.is_bot,
			m.move_number,
			m.move_uci,
			m.captured_piece,
			m.fen_after_move
		 FROM gameplay.moves m
		 JOIN gameplay.team_members tm ON tm.team_member_id = m.team_member_id
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1
		 ORDER BY m.move_number ASC, m.move_id ASC`,
		[normalizedGameId]
	);

	const reservesResult = await queryExecutor.query(
		`SELECT
			pr.team_member_id,
			pr.piece_type,
			pr.quantity
		 FROM gameplay.player_reserves pr
		 JOIN gameplay.team_members tm ON tm.team_member_id = pr.team_member_id
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1
		 ORDER BY pr.team_member_id ASC, pr.piece_type ASC`,
		[normalizedGameId]
	);

	const reservesByTeamMember = {};
	for (const row of reservesResult.rows) {
		const key = String(row.team_member_id);
		if (!Array.isArray(reservesByTeamMember[key])) {
			reservesByTeamMember[key] = [];
		}

		reservesByTeamMember[key].push({
			piece_type: row.piece_type,
			quantity: Number(row.quantity ?? 0),
		});
	}

	const boardStatesResult = await queryExecutor.query(
		`SELECT DISTINCT ON (tm.board_number)
			tm.board_number,
			m.move_id,
			m.move_number,
			m.move_uci,
			m.fen_after_move
		 FROM gameplay.moves m
		 JOIN gameplay.team_members tm ON tm.team_member_id = m.team_member_id
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE t.game_id = $1
		 ORDER BY tm.board_number ASC, m.move_number DESC, m.move_id DESC`,
		[normalizedGameId]
	);

	return {
		game: {
			...game,
			active_board1_team_member_id:
				liveClockSnapshot?.active_board1_team_member_id ?? game.active_board1_team_member_id,
			active_board2_team_member_id:
				liveClockSnapshot?.active_board2_team_member_id ?? game.active_board2_team_member_id,
			move_count: liveClockSnapshot?.move_count ?? game.move_count,
			clock_last_synced_at: liveClockSnapshot?.clock_last_synced_at ?? game.clock_last_synced_at,
			state_version: liveClockSnapshot?.state_version ?? Number(game.move_count ?? 0),
		},
		teams: Array.from(teamsMap.values()),
		moves: movesResult.rows,
		reserves_by_team_member: reservesByTeamMember,
		board_states: boardStatesResult.rows,
		state_version: liveClockSnapshot?.state_version ?? Number(game.move_count ?? 0),
	};
}

export async function getLobbyRealtimeSnapshot(queryExecutor = pool) {
	const gamesResult = await queryExecutor.query(
		`SELECT ${GAME_SELECT_FIELDS}
		 FROM gameplay.games
		 ORDER BY game_id DESC
		 LIMIT 100`
	);

	return {
		games: gamesResult.rows,
	};
}
