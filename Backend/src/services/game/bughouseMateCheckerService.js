import pool from "../../config/db.js";
import { checkAndFinishForcedCheckmate } from "../../models/moveModel.js";
import { emitGameStatusUpdated } from "../../realtime/gameSocketHub.js";
import { invalidateLiveGameCache } from "./liveMovePipelineService.js";

const DEFAULT_CHECK_INTERVAL_MS = 4000;

let checkerIntervalId = null;
let isRunning = false;

async function runMateCheck() {
	if (isRunning) return;
	isRunning = true;

	try {
		const startedGamesResult = await pool.query(
			`SELECT game_id FROM gameplay.games WHERE status = 'started' LIMIT 50`
		);

		for (const row of startedGamesResult.rows) {
			try {
				const finishedGame = await checkAndFinishForcedCheckmate(row.game_id);

				if (finishedGame) {
					const gameId = Number(finishedGame.game_id);
					console.log("[mate-checker] Forced checkmate detected, finishing game", { gameId });
					emitGameStatusUpdated({ gameId, game: finishedGame });
					void invalidateLiveGameCache(finishedGame.game_id);
				}
			} catch (gameError) {
				console.error("[mate-checker] Error checking game", row.game_id, gameError?.message ?? gameError);
			}
		}
	} catch (error) {
		console.error("[mate-checker] Error fetching started games:", error?.message ?? error);
	} finally {
		isRunning = false;
	}
}

export function startBughouseMateChecker(intervalMs = DEFAULT_CHECK_INTERVAL_MS) {
	if (checkerIntervalId != null) return;
	checkerIntervalId = setInterval(runMateCheck, intervalMs);
	console.log(`[mate-checker] Started (interval: ${intervalMs}ms)`);
}

export function stopBughouseMateChecker() {
	if (checkerIntervalId != null) {
		clearInterval(checkerIntervalId);
		checkerIntervalId = null;
		console.log("[mate-checker] Stopped");
	}
}
