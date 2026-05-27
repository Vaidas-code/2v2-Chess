import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

async function main() {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	try {
		await client.query("BEGIN");

		await client.query(
			`CREATE TABLE IF NOT EXISTS gameplay.player_reserves (
				reserve_id BIGSERIAL PRIMARY KEY,
				team_member_id INTEGER NOT NULL REFERENCES gameplay.team_members(team_member_id) ON DELETE CASCADE,
				piece_type CHAR(1) NOT NULL,
				quantity INTEGER NOT NULL DEFAULT 0,
				CONSTRAINT player_reserves_piece_type_check CHECK (piece_type IN ('n', 'r', 'q', 'b', 'p')),
				CONSTRAINT player_reserves_quantity_check CHECK (quantity >= 0),
				CONSTRAINT player_reserves_team_member_piece_unique UNIQUE (team_member_id, piece_type)
			)`
		);

		await client.query(
			`INSERT INTO gameplay.player_reserves (team_member_id, piece_type, quantity)
			 SELECT tm.team_member_id, reserve_piece.piece_type, 0
			 FROM gameplay.team_members tm
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 JOIN gameplay.games g ON g.game_id = t.game_id
			 CROSS JOIN (VALUES ('n'), ('r'), ('q'), ('b'), ('p')) AS reserve_piece(piece_type)
			 WHERE g.status = 'started'
			 ON CONFLICT (team_member_id, piece_type) DO NOTHING`
		);

		await client.query("COMMIT");

		const summaryResult = await client.query(
			`SELECT
				(SELECT COUNT(*)::int FROM gameplay.player_reserves) AS total_reserve_rows,
				(SELECT COUNT(*)::int FROM gameplay.player_reserves WHERE quantity = 0) AS zero_quantity_rows`
		);

		console.log("player_reserves_migration=success", JSON.stringify(summaryResult.rows[0] ?? {}));
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
