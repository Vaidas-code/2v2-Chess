import pool from "../config/db.js";

let reportTableReadyPromise;

export async function ensureReportTable() {
	if (!reportTableReadyPromise) {
		reportTableReadyPromise = (async () => {
			await pool.query(`
				CREATE TABLE IF NOT EXISTS neon_auth.user_reports (
					report_id         BIGSERIAL PRIMARY KEY,
					user_id           UUID        NOT NULL REFERENCES neon_auth.users(user_id) ON DELETE CASCADE,
					reported_user_id  UUID        NOT NULL REFERENCES neon_auth.users(user_id) ON DELETE CASCADE,
					reason            TEXT        NOT NULL,
					created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
				)
			`);
			await pool.query(`
				ALTER TABLE neon_auth.user_reports
				ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ DEFAULT NULL
			`);

			await pool.query(
				"ALTER TABLE neon_auth.user_reports ADD COLUMN IF NOT EXISTS user_id UUID"
			);
			await pool.query(
				"ALTER TABLE neon_auth.user_reports ADD COLUMN IF NOT EXISTS reported_user_id UUID"
			);

			await pool.query(
				`DO $$
				BEGIN
					IF EXISTS (
						SELECT 1
						FROM information_schema.columns
						WHERE table_schema = 'neon_auth'
						  AND table_name = 'user_reports'
						  AND column_name = 'reporter_id'
					) AND EXISTS (
						SELECT 1
						FROM information_schema.columns
						WHERE table_schema = 'neon_auth'
						  AND table_name = 'user_reports'
						  AND column_name = 'reported_id'
					) THEN
						UPDATE neon_auth.user_reports
						SET
							user_id = COALESCE(user_id, CASE WHEN reporter_id ~* '^[0-9a-f\\-]{36}$' THEN reporter_id::uuid END),
							reported_user_id = COALESCE(reported_user_id, CASE WHEN reported_id ~* '^[0-9a-f\\-]{36}$' THEN reported_id::uuid END)
						WHERE user_id IS NULL OR reported_user_id IS NULL;
					END IF;
				END$$;`
			);

			await pool.query(
				"ALTER TABLE neon_auth.user_reports DROP COLUMN IF EXISTS reporter_id"
			);
			await pool.query(
				"ALTER TABLE neon_auth.user_reports DROP COLUMN IF EXISTS reported_id"
			);

			await pool.query(
				`DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1
						FROM pg_constraint
						WHERE conname = 'user_reports_user_id_fkey'
					) THEN
						ALTER TABLE neon_auth.user_reports
						ADD CONSTRAINT user_reports_user_id_fkey
						FOREIGN KEY (user_id) REFERENCES neon_auth.users(user_id) ON DELETE CASCADE;
					END IF;
				END$$;`
			);
			await pool.query(
				`DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1
						FROM pg_constraint
						WHERE conname = 'user_reports_reported_user_id_fkey'
					) THEN
						ALTER TABLE neon_auth.user_reports
						ADD CONSTRAINT user_reports_reported_user_id_fkey
						FOREIGN KEY (reported_user_id) REFERENCES neon_auth.users(user_id) ON DELETE CASCADE;
					END IF;
				END$$;`
			);
		})();
	}
	return reportTableReadyPromise;
}

function normalizeUserId(value) {
	if (typeof value !== "string") return "";
	return value.trim().toLowerCase();
}

function normalizeText(value) {
	return typeof value === "string" ? value.trim() : "";
}

export async function createReport({ user_id, reported_user_id, reason }, queryExecutor = pool) {
	await ensureReportTable();

	const normalizedReporterId = normalizeUserId(user_id);
	const normalizedReportedId = normalizeUserId(reported_user_id);
	const normalizedReason = normalizeText(reason);

	if (!normalizedReporterId) {
		const error = new Error("user_id is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	if (!normalizedReportedId) {
		const error = new Error("reported_user_id is required");
		error.code = "REPORTED_USER_ID_REQUIRED";
		throw error;
	}

	if (!normalizedReason) {
		const error = new Error("reason is required");
		error.code = "REASON_REQUIRED";
		throw error;
	}

	if (normalizedReason.length > 1000) {
		const error = new Error("reason must be at most 1000 characters");
		error.code = "REASON_TOO_LONG";
		throw error;
	}

	if (normalizedReporterId === normalizedReportedId) {
		const error = new Error("You cannot report yourself");
		error.code = "SELF_REPORT";
		throw error;
	}

	const result = await queryExecutor.query(
		`INSERT INTO neon_auth.user_reports (user_id, reported_user_id, reason)
		 VALUES ($1, $2, $3)
		 RETURNING report_id, user_id, reported_user_id, reason, created_at`,
		[normalizedReporterId, normalizedReportedId, normalizedReason]
	);

	return result.rows[0];
}

export async function getReportsByUserId(reported_user_id, queryExecutor = pool) {
	await ensureReportTable();

	const normalizedId = normalizeUserId(reported_user_id);
	if (!normalizedId) {
		const error = new Error("reported_user_id is required");
		error.code = "REPORTED_USER_ID_REQUIRED";
		throw error;
	}

	const result = await queryExecutor.query(
		`SELECT
			r.report_id,
			r.user_id,
			u.username AS reporter_username,
			r.reason,
			r.created_at
		 FROM neon_auth.user_reports r
		 LEFT JOIN neon_auth.users u ON u.user_id = r.user_id
		 WHERE r.reported_user_id = $1
		 ORDER BY r.created_at DESC`,
		[normalizedId]
	);

	return result.rows;
}

export async function getAllReports(queryExecutor = pool) {
	await ensureReportTable();

	const result = await queryExecutor.query(
		`SELECT
			r.report_id,
			r.user_id,
			reporter.username AS reporter_username,
			r.reported_user_id,
			reported.username AS reported_username,
			r.reason,
			r.created_at,
			r.read_at
		 FROM neon_auth.user_reports r
		 LEFT JOIN neon_auth.users reporter ON reporter.user_id = r.user_id
		 LEFT JOIN neon_auth.users reported ON reported.user_id = r.reported_user_id
		 ORDER BY r.read_at NULLS FIRST, r.created_at DESC`
	);

	return result.rows;
}

export async function markReportRead(reportId, queryExecutor = pool) {
	await ensureReportTable();

	const normalizedId = Number(reportId);
	if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
		const error = new Error("report_id must be a valid positive integer");
		error.code = "INVALID_REPORT_ID";
		throw error;
	}

	const result = await queryExecutor.query(
		`UPDATE neon_auth.user_reports
		 SET read_at = NOW()
		 WHERE report_id = $1 AND read_at IS NULL
		 RETURNING report_id, read_at`,
		[normalizedId]
	);

	return result.rows[0] ?? null;
}

export async function getReportCountByUserId(reported_user_id, queryExecutor = pool) {
	await ensureReportTable();

	const normalizedId = normalizeUserId(reported_user_id);
	if (!normalizedId) return 0;

	const result = await queryExecutor.query(
		`SELECT COUNT(*)::int AS report_count
		 FROM neon_auth.user_reports
		 WHERE reported_user_id = $1`,
		[normalizedId]
	);

	return Number(result.rows[0]?.report_count ?? 0);
}
