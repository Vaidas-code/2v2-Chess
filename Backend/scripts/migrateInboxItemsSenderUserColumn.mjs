import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

async function main() {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	try {
		await client.query("BEGIN");

		await client.query("ALTER TABLE gameplay.inbox_items ADD COLUMN IF NOT EXISTS sender_user_id UUID");
		await client.query(
			`ALTER TABLE gameplay.inbox_items
			 ADD CONSTRAINT inbox_items_sender_user_fk
			 FOREIGN KEY (sender_user_id)
			 REFERENCES neon_auth.users(user_id)
			 ON DELETE SET NULL`
		).catch(async (error) => {
			if (error?.code !== "42710") {
				throw error;
			}
		});

		await client.query(
			"CREATE INDEX IF NOT EXISTS idx_inbox_items_sender_user_id ON gameplay.inbox_items (sender_user_id)"
		);

		await client.query("COMMIT");

		const summary = await client.query(
			`SELECT column_name, data_type, is_nullable
			 FROM information_schema.columns
			 WHERE table_schema = 'gameplay'
			   AND table_name = 'inbox_items'
			   AND column_name = 'sender_user_id'`
		);

		console.log("inbox_sender_column_migration=success", JSON.stringify(summary.rows[0] ?? {}));
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
