import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

async function main() {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	try {
		await client.query("BEGIN");

		await client.query("ALTER TABLE gameplay.games ADD COLUMN IF NOT EXISTS rated_game BOOLEAN DEFAULT FALSE");
		await client.query("UPDATE gameplay.games SET rated_game = FALSE WHERE rated_game IS NULL");
		await client.query("ALTER TABLE gameplay.games ALTER COLUMN rated_game SET DEFAULT FALSE");
		await client.query("ALTER TABLE gameplay.games ALTER COLUMN rated_game SET NOT NULL");

		await client.query("ALTER TABLE gameplay.games ADD COLUMN IF NOT EXISTS allow_spectators BOOLEAN DEFAULT TRUE");
		await client.query("UPDATE gameplay.games SET allow_spectators = TRUE WHERE allow_spectators IS NULL");
		await client.query("ALTER TABLE gameplay.games ALTER COLUMN allow_spectators SET DEFAULT TRUE");
		await client.query("ALTER TABLE gameplay.games ALTER COLUMN allow_spectators SET NOT NULL");

		await client.query("ALTER TABLE gameplay.games ADD COLUMN IF NOT EXISTS public_game BOOLEAN DEFAULT TRUE");
		await client.query("UPDATE gameplay.games SET public_game = TRUE WHERE public_game IS NULL");
		await client.query("ALTER TABLE gameplay.games ALTER COLUMN public_game SET DEFAULT TRUE");
		await client.query("ALTER TABLE gameplay.games ALTER COLUMN public_game SET NOT NULL");

		await client.query("COMMIT");

		const summary = await client.query(
			`SELECT
				COUNT(*)::int AS total_games,
				COUNT(*) FILTER (WHERE rated_game = FALSE)::int AS rated_game_false_count,
				COUNT(*) FILTER (WHERE allow_spectators = TRUE)::int AS allow_spectators_true_count,
				COUNT(*) FILTER (WHERE public_game = TRUE)::int AS public_game_true_count
			 FROM gameplay.games`
		);

		console.log("game_settings_migration=success", JSON.stringify(summary.rows[0] ?? {}));
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
