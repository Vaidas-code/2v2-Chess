const BASE_STRENGTH_RANGE = 75;
const RANGE_EXPAND_SECONDS = 20;
const RANGE_EXPAND_STEP = 50;
const MAX_STRENGTH_RANGE = 400;

export function getAllowedTeamStrengthDelta(queueSeconds) {
	const safeSeconds = Math.max(0, Number(queueSeconds) || 0);
	const steps = Math.floor(safeSeconds / RANGE_EXPAND_SECONDS);
	return Math.min(MAX_STRENGTH_RANGE, BASE_STRENGTH_RANGE + steps * RANGE_EXPAND_STEP);
}

export function computeWeightedTeamStrength(players, premadePenalty = 0) {
	if (!Array.isArray(players) || players.length === 0) return 0;
	const mmrs = players.map((player) => Number(player?.mmr ?? 0));
	const highest = Math.max(...mmrs);
	const lowest = Math.min(...mmrs);
	return highest * 0.65 + lowest * 0.35 - premadePenalty;
}

export function scoreMatchup({
	teamA,
	teamB,
	queueSecondsA = 0,
	queueSecondsB = 0,
}) {
	const strengthDiff = Math.abs((teamA?.strength ?? 0) - (teamB?.strength ?? 0));
	const sigmaDiff = Math.abs((teamA?.avgSigma ?? 0) - (teamB?.avgSigma ?? 0));
	const premadeMismatch = Boolean(teamA?.isPremade) !== Boolean(teamB?.isPremade);
	const queueSeconds = Math.max(Number(queueSecondsA) || 0, Number(queueSecondsB) || 0);

	const strengthScore = strengthDiff;
	const sigmaScore = sigmaDiff * 0.35;
	const premadeScore = premadeMismatch ? 50 : 0;
	const queueBonus = Math.min(200, queueSeconds) * -0.5;

	return strengthScore + sigmaScore + premadeScore + queueBonus;
}
