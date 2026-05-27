import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

async function main() {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	try {
		await client.query("BEGIN");

		await client.query(
			`ALTER TABLE gameplay.game_chats 
			 ADD COLUMN IF NOT EXISTS chat_type TEXT DEFAULT 'game'`
		);

		await client.query(
			`UPDATE gameplay.game_chats 
			 SET chat_type = 'game' 
			 WHERE chat_type IS NULL`
		);

		await client.query(
			`ALTER TABLE gameplay.game_chats 
			 ALTER COLUMN chat_type SET NOT NULL`
		);

		await client.query(
			`ALTER TABLE gameplay.game_chats 
			 ADD CONSTRAINT game_chats_chat_type_check 
			 CHECK (chat_type IN ('game', 'team'))`
		);

		await client.query(
			`CREATE INDEX IF NOT EXISTS idx_game_chats_chat_type 
			 ON gameplay.game_chats (chat_type)`
		);

		await client.query("COMMIT");

		const summary = await client.query(
			`SELECT column_name, data_type, column_default, is_nullable
			 FROM information_schema.columns
			 WHERE table_schema = 'gameplay'
			   AND table_name = 'game_chats'
			   AND column_name = 'chat_type'`
		);

		console.log("chat_type_migration=success", JSON.stringify(summary.rows[0] ?? {}));
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
