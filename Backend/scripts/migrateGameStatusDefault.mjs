import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

async function main() {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	try {
		await client.query("BEGIN");

		await client.query("UPDATE gameplay.games SET status = 'in_progress' WHERE status IS NULL");
		await client.query("ALTER TABLE gameplay.games ALTER COLUMN status SET DEFAULT 'in_progress'");
		await client.query("ALTER TABLE gameplay.games ALTER COLUMN status SET NOT NULL");

		await client.query("COMMIT");

		const summary = await client.query(
			`SELECT column_default, is_nullable
			 FROM information_schema.columns
			 WHERE table_schema = 'gameplay'
			   AND table_name = 'games'
			   AND column_name = 'status'`
		);

		console.log("game_status_default_migration=success", JSON.stringify(summary.rows[0] ?? {}));
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
