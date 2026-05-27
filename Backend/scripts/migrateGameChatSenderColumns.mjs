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
			 ADD COLUMN IF NOT EXISTS sender_user_id UUID REFERENCES neon_auth.users(user_id)`
		);

		await client.query(
			`UPDATE gameplay.game_chats gc
			 SET sender_user_id = tm.user_id
			 FROM gameplay.team_members tm
			 WHERE gc.team_member_id = tm.team_member_id
			   AND gc.sender_user_id IS NULL`
		);

		await client.query(
			`ALTER TABLE gameplay.game_chats
			 ALTER COLUMN team_member_id DROP NOT NULL`
		);

		await client.query(
			`CREATE INDEX IF NOT EXISTS idx_game_chats_sender_user_id
			 ON gameplay.game_chats(sender_user_id)`
		);

		await client.query("COMMIT");

		const summary = await client.query(
			`SELECT
				(SELECT COUNT(*)::int FROM gameplay.game_chats) AS chats_total,
				(SELECT COUNT(*)::int FROM gameplay.game_chats WHERE sender_user_id IS NOT NULL) AS chats_with_sender,
				(SELECT COUNT(*)::int FROM gameplay.game_chats WHERE team_member_id IS NULL) AS chats_without_team_member`
		);

		console.log("game_chat_sender_migration=success", JSON.stringify(summary.rows[0] ?? {}));
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
