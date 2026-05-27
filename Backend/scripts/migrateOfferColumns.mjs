import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

async function main() {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	try {
		await client.query("BEGIN");

		await client.query("ALTER TABLE gameplay.games ADD COLUMN IF NOT EXISTS draw_offer_count INTEGER DEFAULT 0");
		await client.query("UPDATE gameplay.games SET draw_offer_count = 0 WHERE draw_offer_count IS NULL");
		await client.query("ALTER TABLE gameplay.games ALTER COLUMN draw_offer_count SET DEFAULT 0");
		await client.query("ALTER TABLE gameplay.games ALTER COLUMN draw_offer_count SET NOT NULL");

		await client.query("ALTER TABLE gameplay.teams ADD COLUMN IF NOT EXISTS forfeit_offer_count INTEGER DEFAULT 0");
		await client.query("UPDATE gameplay.teams SET forfeit_offer_count = 0 WHERE forfeit_offer_count IS NULL");
		await client.query("ALTER TABLE gameplay.teams ALTER COLUMN forfeit_offer_count SET DEFAULT 0");
		await client.query("ALTER TABLE gameplay.teams ALTER COLUMN forfeit_offer_count SET NOT NULL");

		await client.query("ALTER TABLE gameplay.team_members ADD COLUMN IF NOT EXISTS draw_offer_accepted BOOLEAN DEFAULT FALSE");
		await client.query("UPDATE gameplay.team_members SET draw_offer_accepted = FALSE WHERE draw_offer_accepted IS NULL");
		await client.query("ALTER TABLE gameplay.team_members ALTER COLUMN draw_offer_accepted SET DEFAULT FALSE");
		await client.query("ALTER TABLE gameplay.team_members ALTER COLUMN draw_offer_accepted SET NOT NULL");

		await client.query(
			"ALTER TABLE gameplay.team_members ADD COLUMN IF NOT EXISTS forfeit_offer_accepted BOOLEAN DEFAULT FALSE"
		);
		await client.query("UPDATE gameplay.team_members SET forfeit_offer_accepted = FALSE WHERE forfeit_offer_accepted IS NULL");
		await client.query("ALTER TABLE gameplay.team_members ALTER COLUMN forfeit_offer_accepted SET DEFAULT FALSE");
		await client.query("ALTER TABLE gameplay.team_members ALTER COLUMN forfeit_offer_accepted SET NOT NULL");

		await client.query(
			`UPDATE gameplay.games g
			 SET draw_offer_count = counts.accepted_members
			 FROM (
				SELECT t.game_id, COUNT(*) FILTER (WHERE tm.draw_offer_accepted)::int AS accepted_members
				FROM gameplay.team_members tm
				JOIN gameplay.teams t ON t.team_id = tm.team_id
				GROUP BY t.game_id
			 ) AS counts
			 WHERE g.game_id = counts.game_id`
		);

		await client.query(
			`UPDATE gameplay.teams t
			 SET forfeit_offer_count = counts.accepted_members
			 FROM (
				SELECT team_id, COUNT(*) FILTER (WHERE forfeit_offer_accepted)::int AS accepted_members
				FROM gameplay.team_members
				GROUP BY team_id
			 ) AS counts
			 WHERE t.team_id = counts.team_id`
		);

		await client.query("COMMIT");

		const summary = await client.query(
			`SELECT
				(SELECT COUNT(*)::int FROM gameplay.games) AS games_total,
				(SELECT COUNT(*)::int FROM gameplay.games WHERE draw_offer_count = 0) AS games_draw_zero,
				(SELECT COUNT(*)::int FROM gameplay.teams) AS teams_total,
				(SELECT COUNT(*)::int FROM gameplay.teams WHERE forfeit_offer_count = 0) AS teams_forfeit_zero`
		);

		console.log("offer_migration=success", JSON.stringify(summary.rows[0] ?? {}));
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