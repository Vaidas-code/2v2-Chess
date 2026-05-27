import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

async function main() {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	try {
		await client.query("BEGIN");
		await client.query("ALTER TABLE neon_auth.users DROP COLUMN IF EXISTS failed_login_attempts");
		await client.query("ALTER TABLE neon_auth.users DROP COLUMN IF EXISTS locked_until");
		await client.query("COMMIT");

		const summary = await client.query(
			`SELECT column_name
			 FROM information_schema.columns
			 WHERE table_schema = 'neon_auth'
			   AND table_name = 'users'
			   AND column_name IN ('failed_login_attempts', 'locked_until')
			 ORDER BY column_name ASC`
		);

		console.log("drop_login_security_columns=success", JSON.stringify({ remaining_columns: summary.rows }));
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
