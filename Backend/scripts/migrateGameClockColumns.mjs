import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

async function main() {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	try {
		await client.query("BEGIN");

		await client.query("ALTER TABLE gameplay.games ADD COLUMN IF NOT EXISTS winner_team_id INTEGER");
		await client.query("ALTER TABLE gameplay.games ADD COLUMN IF NOT EXISTS finish_reason TEXT");
		await client.query("ALTER TABLE gameplay.games ADD COLUMN IF NOT EXISTS clock_last_synced_at TIMESTAMPTZ");
		await client.query("ALTER TABLE gameplay.games ADD COLUMN IF NOT EXISTS active_board1_team_member_id INTEGER");
		await client.query("ALTER TABLE gameplay.games ADD COLUMN IF NOT EXISTS active_board2_team_member_id INTEGER");

		await client.query("ALTER TABLE gameplay.team_members ADD COLUMN IF NOT EXISTS remaining_seconds INTEGER");
		await client.query("UPDATE gameplay.team_members SET remaining_seconds = 300 WHERE remaining_seconds IS NULL");
		await client.query("ALTER TABLE gameplay.team_members ALTER COLUMN remaining_seconds SET DEFAULT 300");
		await client.query("ALTER TABLE gameplay.team_members ALTER COLUMN remaining_seconds SET NOT NULL");

		await client.query(
			`UPDATE gameplay.games g
			 SET clock_last_synced_at = COALESCE(g.clock_last_synced_at, NOW()),
				 active_board1_team_member_id = COALESCE(
					g.active_board1_team_member_id,
					(
						SELECT tm.team_member_id
						FROM gameplay.team_members tm
						JOIN gameplay.teams t ON t.team_id = tm.team_id
						WHERE t.game_id = g.game_id
						  AND tm.board_number = 1
						  AND LOWER(tm.piece_color) = 'white'
						LIMIT 1
					)
				 ),
				 active_board2_team_member_id = COALESCE(
					g.active_board2_team_member_id,
					(
						SELECT tm.team_member_id
						FROM gameplay.team_members tm
						JOIN gameplay.teams t ON t.team_id = tm.team_id
						WHERE t.game_id = g.game_id
						  AND tm.board_number = 2
						  AND LOWER(tm.piece_color) = 'white'
						LIMIT 1
					)
				 )
			 WHERE g.clock_last_synced_at IS NULL
			    OR g.active_board1_team_member_id IS NULL
			    OR g.active_board2_team_member_id IS NULL`
		);

		await client.query("COMMIT");

		const summaryResult = await client.query(
			`SELECT
				(SELECT COUNT(*)::int FROM gameplay.games) AS games_total,
				(SELECT COUNT(*)::int FROM gameplay.games WHERE clock_last_synced_at IS NOT NULL) AS games_with_clock_sync,
				(SELECT COUNT(*)::int FROM gameplay.team_members) AS team_members_total,
				(SELECT COUNT(*)::int FROM gameplay.team_members WHERE remaining_seconds IS NOT NULL) AS members_with_remaining_seconds`
		);

		console.log("game_clock_columns_migration=success", JSON.stringify(summaryResult.rows[0] ?? {}));
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
