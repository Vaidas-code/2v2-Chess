import dotenv from "dotenv";
import pkg from "pg";

const { Pool } = pkg;

dotenv.config();

const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
	console.error("Unexpected error on idle client", err);
});

export default pool;
