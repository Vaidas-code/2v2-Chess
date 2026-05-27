import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

async function main() {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	try {
		await client.query("BEGIN");

		await client.query(
			`CREATE TABLE IF NOT EXISTS gameplay.inbox_items (
				inbox_item_id BIGSERIAL PRIMARY KEY,
				user_id UUID NOT NULL REFERENCES neon_auth.users(user_id) ON DELETE CASCADE,
				item_type TEXT NOT NULL,
				source_id BIGINT NOT NULL,
				message TEXT,
				received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				is_read BOOLEAN NOT NULL DEFAULT FALSE,
				read_at TIMESTAMPTZ,
				CONSTRAINT inbox_items_user_item_source_unique UNIQUE (user_id, item_type, source_id),
				CONSTRAINT inbox_items_read_consistency CHECK (read_at IS NULL OR is_read = TRUE)
			)`
		);

		await client.query(
			"CREATE INDEX IF NOT EXISTS idx_inbox_items_user_received_at ON gameplay.inbox_items (user_id, received_at DESC)"
		);

		await client.query(
			"CREATE INDEX IF NOT EXISTS idx_inbox_items_user_is_read ON gameplay.inbox_items (user_id, is_read)"
		);

		await client.query("COMMIT");

		const summary = await client.query(
			`SELECT column_name, data_type, is_nullable
			 FROM information_schema.columns
			 WHERE table_schema = 'gameplay'
			   AND table_name = 'inbox_items'
			 ORDER BY ordinal_position ASC`
		);

		console.log("inbox_items_migration=success", JSON.stringify({ columns: summary.rows }));
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
