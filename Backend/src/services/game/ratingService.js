import pool from "../../config/db.js";

const DEFAULT_MMR = 1500;
const DEFAULT_SIGMA = 350;
const SIGMA_MIN = 60;
const SIGMA_MAX = 400;
const PREMADE_PENALTY = 35;

const NEW_PLAYER_GAMES = 30;
const RAPID_SIGMA_GAMES = 25;
const HIGH_RANK_THRESHOLD = 2400;
const TOP_RANK_THRESHOLD = 3000;

const OVERPERFORM_GAMES = 15;
const OVERPERFORM_WINRATE = 0.7;

const INACTIVITY_GRACE_DAYS = 14;
const INACTIVITY_RESET_DAYS = 60;
const INACTIVITY_SIGMA_DAILY = 2;

const MIN_RATED_GAME_SECONDS = parsePositiveInt(process.env.MIN_RATED_GAME_SECONDS, 90);
const MIN_RATED_GAME_MOVES = parsePositiveInt(process.env.MIN_RATED_GAME_MOVES, 8);

const DISCONNECT_PENALTY_MULTIPLIER = 1.15;
const TEAMMATE_DISCONNECT_LOSS_MULTIPLIER = 0.5;
const OPPONENT_DISCONNECT_GAIN_MULTIPLIER = 0.75;

let ratingColumnsReadyPromise;
let ratingGameColumnsReadyPromise;

function parsePositiveInt(value, fallback) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function toNumber(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function toInt(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizeUserId(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeText(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function hasInviteBetweenUsers({ gameId, userAId, userBId }, queryExecutor) {
	const normalizedUserA = normalizeUserId(userAId);
	const normalizedUserB = normalizeUserId(userBId);

	if (!normalizedUserA || !normalizedUserB) {
		return false;
	}

	const result = await queryExecutor.query(
		`SELECT 1
		 FROM gameplay.inbox_items ii
		 WHERE ii.item_type = 'game_invite'
		   AND ii.source_id = $3
		   AND (
			(LOWER(ii.user_id::text) = $1 AND LOWER(ii.sender_user_id::text) = $2)
			OR
			(LOWER(ii.user_id::text) = $2 AND LOWER(ii.sender_user_id::text) = $1)
		   )
		 LIMIT 1`,
		[normalizedUserA, normalizedUserB, Number(gameId)]
	);

	return result.rowCount > 0;
}

async function isPremadeTeamByInvite({ gameId, teamPlayers, queryExecutor }) {
	if (!Array.isArray(teamPlayers) || teamPlayers.length !== 2) {
		return false;
	}

	const [playerA, playerB] = teamPlayers;
	return hasInviteBetweenUsers({
		gameId,
		userAId: playerA.user_id,
		userBId: playerB.user_id,
	}, queryExecutor);
}

async function getWinLossSummaryByUserIds({ userIds, gameId }, queryExecutor) {
	if (!Array.isArray(userIds) || userIds.length === 0) {
		return new Map();
	}

	const result = await queryExecutor.query(
		`WITH user_games AS (
			SELECT
				tm.user_id,
				g.game_id,
				g.finished_at,
				g.winner_team_id,
				g.result,
				t.team_id,
				COUNT(tm_bot.team_member_id) FILTER (WHERE tm_bot.is_bot)::int AS bot_count
			FROM gameplay.games g
			JOIN gameplay.teams t ON t.game_id = g.game_id
			JOIN gameplay.team_members tm ON tm.team_id = t.team_id
			LEFT JOIN gameplay.team_members tm_bot ON tm_bot.team_id = t.team_id
			WHERE tm.user_id = ANY($1::uuid[])
			  AND g.status = 'finished'
			  AND g.rated_game = TRUE
			  AND g.game_id <> $2
			GROUP BY tm.user_id, g.game_id, g.finished_at, g.winner_team_id, g.result, t.team_id
		),
		filtered AS (
			SELECT * FROM user_games WHERE bot_count = 0
		)
		SELECT
			user_id,
			COUNT(*)::int AS games_played,
			COUNT(*) FILTER (
				WHERE winner_team_id IS NOT NULL
				  AND team_id = winner_team_id
				  AND LOWER(COALESCE(result, '')) <> 'draw'
			)::int AS wins,
			COUNT(*) FILTER (
				WHERE winner_team_id IS NOT NULL
				  AND team_id <> winner_team_id
				  AND LOWER(COALESCE(result, '')) <> 'draw'
			)::int AS losses,
			MAX(finished_at) AS last_rated_at
		FROM filtered
		GROUP BY user_id`,
		[userIds, Number(gameId)]
	);

	const summaryByUser = new Map();
	for (const row of result.rows) {
		summaryByUser.set(normalizeUserId(String(row.user_id)), {
			games_played: toInt(row.games_played, 0),
			wins: toInt(row.wins, 0),
			losses: toInt(row.losses, 0),
			last_rated_at: row.last_rated_at ?? null,
		});
	}

	return summaryByUser;
}

async function getRecentWinStreaksByUserIds({ userIds, gameId }, queryExecutor) {
	if (!Array.isArray(userIds) || userIds.length === 0) {
		return new Map();
	}

	const result = await queryExecutor.query(
		`WITH user_games AS (
			SELECT
				tm.user_id,
				g.game_id,
				g.finished_at,
				g.winner_team_id,
				g.result,
				t.team_id,
				COUNT(tm_bot.team_member_id) FILTER (WHERE tm_bot.is_bot)::int AS bot_count
			FROM gameplay.games g
			JOIN gameplay.teams t ON t.game_id = g.game_id
			JOIN gameplay.team_members tm ON tm.team_id = t.team_id
			LEFT JOIN gameplay.team_members tm_bot ON tm_bot.team_id = t.team_id
			WHERE tm.user_id = ANY($1::uuid[])
			  AND g.status = 'finished'
			  AND g.rated_game = TRUE
			  AND g.game_id <> $2
			GROUP BY tm.user_id, g.game_id, g.finished_at, g.winner_team_id, g.result, t.team_id
		),
		filtered AS (
			SELECT * FROM user_games WHERE bot_count = 0
		),
		ranked AS (
			SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY finished_at DESC) AS rn
			FROM filtered
		)
		SELECT user_id, winner_team_id, result, team_id, rn
		FROM ranked
		WHERE rn <= 10
		ORDER BY user_id, rn`,
		[userIds, Number(gameId)]
	);

	const streakByUser = new Map();
	const stateByUser = new Map();

	for (const row of result.rows) {
		const userId = normalizeUserId(String(row.user_id));
		if (!userId) continue;

		const state = stateByUser.get(userId) ?? { streak: 0, broken: false };
		if (state.broken) {
			stateByUser.set(userId, state);
			continue;
		}

		const winnerTeamId = toInt(row.winner_team_id, null);
		const teamId = toInt(row.team_id, null);
		const resultText = normalizeText(row.result);
		const isWin = winnerTeamId !== null && teamId !== null && winnerTeamId === teamId && resultText !== "draw";

		if (isWin) {
			state.streak += 1;
		} else {
			state.broken = true;
		}

		stateByUser.set(userId, state);
	}

	for (const [userId, state] of stateByUser.entries()) {
		streakByUser.set(userId, state.streak);
	}

	return streakByUser;
}

async function getDerivedPlayerStats({ userIds, gameId }, queryExecutor) {
	const uniqueUserIds = Array.from(new Set((userIds || []).map(normalizeUserId).filter(Boolean)));
	if (uniqueUserIds.length === 0) {
		return new Map();
	}

	const [summaryByUser, winStreakByUser] = await Promise.all([
		getWinLossSummaryByUserIds({ userIds: uniqueUserIds, gameId }, queryExecutor),
		getRecentWinStreaksByUserIds({ userIds: uniqueUserIds, gameId }, queryExecutor),
	]);

	const derived = new Map();
	for (const userId of uniqueUserIds) {
		const summary = summaryByUser.get(userId) ?? {
			games_played: 0,
			wins: 0,
			losses: 0,
			last_rated_at: null,
		};
		derived.set(userId, {
			games_played: summary.games_played,
			wins: summary.wins,
			losses: summary.losses,
			last_rated_at: summary.last_rated_at,
			win_streak: winStreakByUser.get(userId) ?? 0,
		});
	}

	return derived;
}

async function ensureRatingColumns() {
	if (ratingColumnsReadyPromise) {
		return ratingColumnsReadyPromise;
	}

	ratingColumnsReadyPromise = (async () => {
		await pool.query("ALTER TABLE neon_auth.users ADD COLUMN IF NOT EXISTS mmr DOUBLE PRECISION");
		await pool.query("ALTER TABLE neon_auth.users ADD COLUMN IF NOT EXISTS sigma DOUBLE PRECISION");

		await pool.query("ALTER TABLE neon_auth.users ALTER COLUMN mmr SET DEFAULT 1500");
		await pool.query("ALTER TABLE neon_auth.users ALTER COLUMN sigma SET DEFAULT 350");
		await pool.query("ALTER TABLE neon_auth.users ALTER COLUMN rating SET DEFAULT 1500");
	})();

	try {
		await ratingColumnsReadyPromise;
	} catch (error) {
		ratingColumnsReadyPromise = null;
		throw error;
	}
}

async function ensureRatingGameColumns() {
	if (ratingGameColumnsReadyPromise) {
		return ratingGameColumnsReadyPromise;
	}

	ratingGameColumnsReadyPromise = (async () => {
		await pool.query("ALTER TABLE gameplay.games ADD COLUMN IF NOT EXISTS rating_applied_at TIMESTAMPTZ");
	})();

	try {
		await ratingGameColumnsReadyPromise;
	} catch (error) {
		ratingGameColumnsReadyPromise = null;
		throw error;
	}
}

function computeTeamStrength(players, isPremade) {
	const mmrs = players.map((player) => player.mmr);
	if (mmrs.length === 0) return DEFAULT_MMR;

	const highest = Math.max(...mmrs);
	const lowest = Math.min(...mmrs);
	const baseStrength = highest * 0.65 + lowest * 0.35;
	return isPremade ? baseStrength - PREMADE_PENALTY : baseStrength;
}

function expectedWinProbability(teamStrength, opponentStrength) {
	return 1 / (1 + Math.pow(10, (opponentStrength - teamStrength) / 400));
}

function computeKFactor(player) {
	if (player.games_played < NEW_PLAYER_GAMES) {
		return 60;
	}
	if (player.mmr > HIGH_RANK_THRESHOLD) {
		return 18;
	}
	return 28;
}

function computeInactivityDays(lastRatedAt, now) {
	if (!lastRatedAt) return 0;
	const lastTime = new Date(lastRatedAt).getTime();
	if (!Number.isFinite(lastTime)) return 0;
	const msPerDay = 24 * 60 * 60 * 1000;
	return Math.max(0, Math.floor((now - lastTime) / msPerDay));
}

function applyInactivitySigma(sigma, inactivityDays) {
	if (inactivityDays <= INACTIVITY_GRACE_DAYS) {
		return sigma;
	}

	const extraDays = inactivityDays - INACTIVITY_GRACE_DAYS;
	const increased = sigma + extraDays * INACTIVITY_SIGMA_DAILY;
	let nextSigma = clamp(increased, SIGMA_MIN, SIGMA_MAX);

	if (inactivityDays >= INACTIVITY_RESET_DAYS) {
		nextSigma = Math.max(nextSigma, SIGMA_MAX * 0.85);
	}

	return clamp(nextSigma, SIGMA_MIN, SIGMA_MAX);
}

function computeVisibleRankUpdate({
	currentVisible,
	nextMmr,
	delta,
}) {
	let visible = currentVisible;

	if (delta > 0) {
		if (nextMmr >= currentVisible + 100) {
			const visibleDelta = delta * 0.35;
			visible = currentVisible + visibleDelta;
			if (visible > nextMmr) {
				visible = nextMmr;
			}
		}
	} else if (delta < 0) {
		const visibleDelta = delta * 0.25;
		visible = currentVisible + visibleDelta;
	}

	return {
		nextVisible: Math.round(visible),
	};
}

function normalizePlayerRow(row) {
	const baseRating = toNumber(row.rating, DEFAULT_MMR);
	const mmr = toNumber(row.mmr, baseRating);
	const sigma = clamp(toNumber(row.sigma, DEFAULT_SIGMA), SIGMA_MIN, SIGMA_MAX);

	return {
		user_id: normalizeUserId(row.user_id),
		mmr,
		sigma,
		rating: baseRating,
	};
}

function computeWinRate(wins, losses) {
	const total = wins + losses;
	if (total <= 0) return 0;
	return wins / total;
}

function computeGapFactor(teamStrength, opponentStrength) {
	const gap = Math.abs(teamStrength - opponentStrength);
	return Math.min(1, gap / 800);
}

function computeHighRankTax(players, deltas) {
	const totalPositive = deltas.reduce((sum, delta) => sum + Math.max(0, delta), 0);
	const hasTopRank = players.some((player) => player.mmr >= TOP_RANK_THRESHOLD);
	if (!hasTopRank || totalPositive <= 0) return 0;
	return Math.min(6, totalPositive * 0.03);
}

function applyZeroSumAdjustment(players, deltas) {
	const totalDelta = deltas.reduce((sum, delta) => sum + delta, 0);
	const tax = computeHighRankTax(players, deltas);
	const adjustment = (totalDelta + tax) / players.length;
	return deltas.map((delta) => delta - adjustment);
}

function getMixedSkillMultiplier(player, teamPlayers, outcome) {
	if (teamPlayers.length < 2 || outcome === 0.5) {
		return 1;
	}

	const sorted = [...teamPlayers].sort((a, b) => a.mmr - b.mmr);
	const weakest = sorted[0];
	const strongest = sorted[sorted.length - 1];

	if (player.user_id === strongest.user_id) {
		return outcome === 1 ? 0.7 : 1.3;
	}

	if (player.user_id === weakest.user_id) {
		return outcome === 1 ? 1.3 : 0.7;
	}

	return 1;
}

// Smurf/feeding detection removed; derived-only approach avoids storing extra state.

/**
 * Applies hybrid MMR/sigma updates for finished rated 2v2 bughouse games.
 * Safe to call fire-and-forget (.catch) — errors are logged but don't propagate.
 */
export async function applyRatingForFinishedGame({ gameId, winnerTeamId, ratedGame, options = {} }) {
	if (!gameId) return;

	await ensureRatingColumns();
	await ensureRatingGameColumns();

	const client = await pool.connect();
	const executor = client;
	const now = Date.now();

	try {
		await executor.query("BEGIN");

		const gameResult = await executor.query(
			`SELECT
				g.game_id,
				g.rated_game,
				g.winner_team_id,
				g.result,
				g.finish_reason,
				g.started_at,
				g.finished_at,
				g.move_count,
				g.rating_applied_at
			 FROM gameplay.games g
			 WHERE g.game_id = $1
			 FOR UPDATE`,
			[gameId]
		);

		if (gameResult.rowCount === 0) {
			await executor.query("ROLLBACK");
			return;
		}

		const game = gameResult.rows[0];
		const isRated = Boolean(game.rated_game) && Boolean(ratedGame ?? game.rated_game);
		if (!isRated) {
			await executor.query(
				"UPDATE gameplay.games SET rating_applied_at = NOW() WHERE game_id = $1 AND rating_applied_at IS NULL",
				[gameId]
			);
			await executor.query("COMMIT");
			return;
		}

		if (game.rating_applied_at) {
			await executor.query("COMMIT");
			return;
		}

		const startedAt = game.started_at ? new Date(game.started_at) : null;
		const finishedAt = game.finished_at ? new Date(game.finished_at) : null;
		const durationSeconds = startedAt && finishedAt
			? Math.max(0, Math.floor((finishedAt.getTime() - startedAt.getTime()) / 1000))
			: 0;
		const moveCount = toInt(game.move_count, 0);
		const belowThreshold =
			(durationSeconds > 0 && durationSeconds < MIN_RATED_GAME_SECONDS) ||
			(moveCount > 0 && moveCount < MIN_RATED_GAME_MOVES);

		if (belowThreshold) {
			await executor.query(
				"UPDATE gameplay.games SET rating_applied_at = NOW() WHERE game_id = $1 AND rating_applied_at IS NULL",
				[gameId]
			);
			await executor.query("COMMIT");
			return;
		}

		const membersResult = await executor.query(
			`SELECT
				t.team_id,
				tm.user_id,
				tm.is_bot,
				tm.board_number,
				u.mmr,
				u.sigma,
				u.rating
			 FROM gameplay.teams t
			 JOIN gameplay.team_members tm ON tm.team_id = t.team_id
			 LEFT JOIN neon_auth.users u ON u.user_id = tm.user_id
			 WHERE t.game_id = $1
			 ORDER BY t.team_id ASC, tm.board_number ASC`,
			[gameId]
		);

		const teams = new Map();
		let hasBot = false;

		for (const row of membersResult.rows) {
			if (!teams.has(row.team_id)) {
				teams.set(row.team_id, {
					team_id: row.team_id,
					players: [],
				});
			}

			const team = teams.get(row.team_id);
			if (row.is_bot) {
				hasBot = true;
				continue;
			}
			if (!row.user_id) continue;
			team.players.push(normalizePlayerRow(row));
		}

		if (hasBot) {
			await executor.query(
				"UPDATE gameplay.games SET rating_applied_at = NOW() WHERE game_id = $1 AND rating_applied_at IS NULL",
				[gameId]
			);
			await executor.query("COMMIT");
			return;
		}

		const sortedTeams = Array.from(teams.values()).sort((a, b) => a.team_id - b.team_id);
		if (sortedTeams.length !== 2) {
			await executor.query(
				"UPDATE gameplay.games SET rating_applied_at = NOW() WHERE game_id = $1 AND rating_applied_at IS NULL",
				[gameId]
			);
			await executor.query("COMMIT");
			return;
		}

		const [teamA, teamB] = sortedTeams;
		if (teamA.players.length !== 2 || teamB.players.length !== 2) {
			await executor.query(
				"UPDATE gameplay.games SET rating_applied_at = NOW() WHERE game_id = $1 AND rating_applied_at IS NULL",
				[gameId]
			);
			await executor.query("COMMIT");
			return;
		}

		const uniqueUserIds = new Set([...teamA.players, ...teamB.players].map((player) => player.user_id));
		if (uniqueUserIds.size !== teamA.players.length + teamB.players.length) {
			await executor.query(
				"UPDATE gameplay.games SET rating_applied_at = NOW() WHERE game_id = $1 AND rating_applied_at IS NULL",
				[gameId]
			);
			await executor.query("COMMIT");
			return;
		}

		const allPlayers = [...teamA.players, ...teamB.players];
		const derivedStats = await getDerivedPlayerStats({
			userIds: allPlayers.map((player) => player.user_id),
			gameId,
		}, executor);

		for (const player of allPlayers) {
			const derived = derivedStats.get(player.user_id) ?? {
				games_played: 0,
				win_streak: 0,
				wins: 0,
				losses: 0,
				last_rated_at: null,
			};
			player.games_played = derived.games_played;
			player.win_streak = derived.win_streak;
			player.wins = derived.wins;
			player.losses = derived.losses;
			player.last_rated_at = derived.last_rated_at;
		}

		const normalizedResult = normalizeText(game.result);
		const resolvedWinnerTeamId = winnerTeamId ?? game.winner_team_id ?? null;
		const isDraw = normalizedResult === "draw" || (!resolvedWinnerTeamId && normalizedResult.includes("draw"));

		if (!resolvedWinnerTeamId && !isDraw) {
			await executor.query(
				"UPDATE gameplay.games SET rating_applied_at = NOW() WHERE game_id = $1 AND rating_applied_at IS NULL",
				[gameId]
			);
			await executor.query("COMMIT");
			return;
		}

		const disconnectingUserIds = new Set(
			(options.disconnecting_user_ids || options.disconnectingUserIds || [])
				.map(normalizeUserId)
				.filter(Boolean)
		);
		const disconnectingTeamIds = new Set(
			(options.disconnecting_team_ids || options.disconnectingTeamIds || [])
				.map((value) => toInt(value, null))
				.filter(Boolean)
		);

		const isPremadeA = await isPremadeTeamByInvite({
			gameId,
			teamPlayers: teamA.players,
			queryExecutor: executor,
		});
		const isPremadeB = await isPremadeTeamByInvite({
			gameId,
			teamPlayers: teamB.players,
			queryExecutor: executor,
		});

		const teamStrengthA = computeTeamStrength(teamA.players, isPremadeA);
		const teamStrengthB = computeTeamStrength(teamB.players, isPremadeB);
		const expectedA = expectedWinProbability(teamStrengthA, teamStrengthB);
		const expectedB = 1 - expectedA;


		const playerDeltas = new Map();

		for (const team of [teamA, teamB]) {
			const opponentTeam = team === teamA ? teamB : teamA;
			const teamStrength = team === teamA ? teamStrengthA : teamStrengthB;
			const opponentStrength = team === teamA ? teamStrengthB : teamStrengthA;
			const expected = team === teamA ? expectedA : expectedB;
			const outcome = isDraw
				? 0.5
				: team.team_id === resolvedWinnerTeamId
					? 1
					: 0;

			const teamIsPremade = team === teamA ? isPremadeA : isPremadeB;

			const wasUnderdog = teamStrength < opponentStrength;
			const wasFavorite = teamStrength > opponentStrength;
			const gapFactor = computeGapFactor(teamStrength, opponentStrength);
			const opponentHasDisconnect = opponentTeam.players.some((player) => disconnectingUserIds.has(player.user_id));

			for (const player of team.players) {
				const kFactor = computeKFactor(player);
				let delta = kFactor * (outcome - expected);

				const sigmaFactor = player.sigma / SIGMA_MAX;
				const winStreakFactor = Math.min(player.win_streak ?? 0, 10) * 0.02;
				const underdogBoost = 1 + gapFactor * 0.4 + sigmaFactor * 0.2 + winStreakFactor;
				const favoriteWinReduction = Math.max(0.7, 1 - gapFactor * 0.25);
				const favoriteUpsetPenalty = Math.min(1.7, 1 + gapFactor * 0.45);
				const underdogLossReduction = Math.max(0.85, 1 - gapFactor * 0.1);

				if (outcome === 1 && wasUnderdog) {
					delta *= underdogBoost;
				} else if (outcome === 1 && wasFavorite) {
					delta *= favoriteWinReduction;
				} else if (outcome === 0 && wasFavorite) {
					delta *= favoriteUpsetPenalty;
				} else if (outcome === 0 && wasUnderdog) {
					delta *= underdogLossReduction;
				}

				delta *= getMixedSkillMultiplier(player, team.players, outcome);
				if (teamIsPremade && outcome !== 0.5) {
					delta *= outcome === 1 ? 0.9 : 1.1;
				}

				if (player.games_played < RAPID_SIGMA_GAMES) {
					const boost = 1 + ((RAPID_SIGMA_GAMES - player.games_played) / RAPID_SIGMA_GAMES) * 0.25;
					delta *= boost;
				}

				const winRate = computeWinRate(player.wins, player.losses);
				if (outcome === 1 && player.games_played >= OVERPERFORM_GAMES && winRate > OVERPERFORM_WINRATE) {
					delta *= 1.5;
				}

				if (player.mmr >= TOP_RANK_THRESHOLD) {
					if (outcome === 1 && teamStrength - opponentStrength > 200) {
						delta *= Math.max(0.35, 1 - gapFactor * 0.6);
					} else if (outcome === 0 && teamStrength > opponentStrength) {
						delta *= Math.min(2, 1 + gapFactor * 0.8);
					}
				}

				const isDisconnecting =
					disconnectingUserIds.has(player.user_id) || disconnectingTeamIds.has(team.team_id);
				const teammateDisconnected = team.players.some(
					(teammate) => teammate.user_id !== player.user_id && disconnectingUserIds.has(teammate.user_id)
				);

				if (outcome === 0 && isDisconnecting) {
					delta *= DISCONNECT_PENALTY_MULTIPLIER;
				} else if (outcome === 0 && teammateDisconnected) {
					delta *= TEAMMATE_DISCONNECT_LOSS_MULTIPLIER;
				} else if (outcome === 1 && opponentHasDisconnect) {
					delta *= OPPONENT_DISCONNECT_GAIN_MULTIPLIER;
				}

				playerDeltas.set(player.user_id, {
					delta,
					outcome,
					teamStrength,
					opponentStrength,
					wasUnderdog,
					wasFavorite,
					gapFactor,
				});
			}
		}

		const deltas = allPlayers.map((player) => playerDeltas.get(player.user_id)?.delta ?? 0);
		const adjustedDeltas = applyZeroSumAdjustment(allPlayers, deltas);

		for (let i = 0; i < allPlayers.length; i += 1) {
			const player = allPlayers[i];
			const details = playerDeltas.get(player.user_id);
			if (!details) continue;

			const delta = adjustedDeltas[i];
			const outcome = details.outcome;
			const teamWon = outcome === 1;
			const teamLost = outcome === 0;
			const isUpsetOutcome =
				(teamWon && details.wasUnderdog) || (teamLost && details.wasFavorite);

			const inactivityDays = computeInactivityDays(player.last_rated_at, now);
			let sigma = applyInactivitySigma(player.sigma, inactivityDays);
			let sigmaDecrease = 2;
			if (isUpsetOutcome) {
				sigmaDecrease += 2;
			}
			if (player.games_played < RAPID_SIGMA_GAMES) {
				sigmaDecrease += 2;
			}
			sigma = clamp(sigma - sigmaDecrease, SIGMA_MIN, SIGMA_MAX);

			let nextMmr = player.mmr + delta;
			if (!Number.isFinite(nextMmr)) {
				nextMmr = player.mmr;
			}

			let wins = player.wins;
			let losses = player.losses;
			if (outcome === 1) {
				wins += 1;
			} else if (outcome === 0) {
				losses += 1;
			} else {
			}

			const visibleUpdate = computeVisibleRankUpdate({
				currentVisible: player.rating,
				nextMmr,
				delta,
			});

			const nextVisible = visibleUpdate.nextVisible;
			const ratingDisplay = Math.round(nextVisible);

			await executor.query(
				`UPDATE neon_auth.users
				 SET
					mmr = $2,
					sigma = $3,
					rating = $4,
					updated_at = NOW()
				 WHERE user_id = $1`,
				[
					player.user_id,
					nextMmr,
					sigma,
					ratingDisplay,
				]
			);
		}

		await executor.query(
			"UPDATE gameplay.games SET rating_applied_at = NOW() WHERE game_id = $1 AND rating_applied_at IS NULL",
			[gameId]
		);
		await executor.query("COMMIT");
	} catch (error) {
		await executor.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function applySeasonalSoftReset({ userIds } = {}) {
	await ensureRatingColumns();

	const hasFilter = Array.isArray(userIds) && userIds.length > 0;
	const params = hasFilter ? [userIds] : [];
	const whereClause = hasFilter ? "WHERE user_id = ANY($1::uuid[])" : "";

	await pool.query(
		`UPDATE neon_auth.users
		 SET
			mmr = (COALESCE(mmr, ${DEFAULT_MMR}) * 0.75) + 375,
			rating = ROUND((COALESCE(rating, ${DEFAULT_MMR}) * 0.75) + 375),
			sigma = LEAST(${SIGMA_MAX}, COALESCE(sigma, ${DEFAULT_SIGMA}) + 20),
			updated_at = NOW()
		 ${whereClause}`,
		params
	);
}
