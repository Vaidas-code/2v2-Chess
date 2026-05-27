import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;
const DEFAULT_GAME_NAME = "Casual chess room";

async function main() {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	const escapedDefaultGameName = DEFAULT_GAME_NAME.replace(/'/g, "''");

	try {
		await client.query("BEGIN");

		await client.query(
			`ALTER TABLE gameplay.games ADD COLUMN IF NOT EXISTS game_name TEXT DEFAULT '${escapedDefaultGameName}'`
		);
		await client.query(
			"UPDATE gameplay.games SET game_name = $1 WHERE game_name IS NULL OR BTRIM(game_name) = ''",
			[DEFAULT_GAME_NAME]
		);
		await client.query(
			`ALTER TABLE gameplay.games ALTER COLUMN game_name SET DEFAULT '${escapedDefaultGameName}'`
		);
		await client.query("ALTER TABLE gameplay.games ALTER COLUMN game_name SET NOT NULL");

		await client.query("COMMIT");

		const summary = await client.query(
			`SELECT
				COUNT(*)::int AS total_games,
				COUNT(*) FILTER (WHERE game_name = $1)::int AS games_with_default_name
			 FROM gameplay.games`,
			[DEFAULT_GAME_NAME]
		);

		console.log("game_name_migration=success", JSON.stringify(summary.rows[0] ?? {}));
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
