import pool from "../config/db.js";
import crypto from "crypto";
import { hashPassword, verifyPassword } from "../security/passwordHasher.js";
import { ensureReportTable, getReportsByUserId } from "./reportModel.js";

const USER_SELECT_FIELDS =
	"user_id, username, email, role, banned, ban_reason, rating, online_status, email_verified, email_verification_expires, created_at, updated_at, avatar";
const USER_CREATE_RETURN_FIELDS = `${USER_SELECT_FIELDS}, email_verification_token`;
const USER_AUTH_SELECT_FIELDS = `${USER_SELECT_FIELDS}, password_hash`;
const USER_REFRESH_SELECT_FIELDS = `${USER_SELECT_FIELDS}, refresh_token_hash, refresh_token_expires_at`;

const AVATAR_FILENAMES = [
	'Avatar1_NO_BG.png',
	'Avatar2_NO_BG.png',
	'Avatar3_NO_BG.png',
	'Avatar4_NO_BG.png',
	'Avatar5_NO_BG.png',
	'Avatar6_NO_BG.png',
	'Avatar7_NO_BG.png',
	'Avatar_8_NO_BG.png',
	'Avatar9_NO_BG.png',
	'Avatar10_NO_BG.png',
];

function pickRandomAvatar() {
	return AVATAR_FILENAMES[Math.floor(Math.random() * AVATAR_FILENAMES.length)];
}

function parsePositiveInt(value, fallback) {
	const parsedValue = Number(value);
	return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

const MAX_FAILED_LOGIN_ATTEMPTS = parsePositiveInt(process.env.LOGIN_MAX_FAILED_ATTEMPTS, 3);
const ACCOUNT_LOCK_MINUTES = parsePositiveInt(process.env.LOGIN_LOCK_MINUTES, 15);

let refreshTokenColumnsReadyPromise;
let passwordResetColumnsReadyPromise;
let oauthAccountTableReadyPromise;
let avatarColumnReadyPromise;
const loginSecurityStateByUserId = new Map();

function normalizeOptionalText(value) {
	if (typeof value !== "string") {
		return null;
	}

	const trimmedValue = value.trim();
	return trimmedValue === "" ? null : trimmedValue;
}

function normalizeUserId(userId) {
	if (typeof userId === "number" && Number.isFinite(userId)) {
		return String(userId);
	}

	if (typeof userId !== "string") {
		return "";
	}

	return userId.trim();
}

function normalizeEmailAddress(email) {
	return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function normalizeOauthProvider(provider) {
	return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

function normalizeOauthProviderUserId(providerUserId) {
	return typeof providerUserId === "string" ? providerUserId.trim() : "";
}

function getLoginSecurityState(userId) {
	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
		return null;
	}

	const existingState = loginSecurityStateByUserId.get(normalizedUserId);

	if (existingState) {
		return existingState;
	}

	const initialState = { failedAttempts: 0, lockedUntilMs: 0 };
	loginSecurityStateByUserId.set(normalizedUserId, initialState);
	return initialState;
}

function isLockActiveForUser(userId) {
	const state = getLoginSecurityState(userId);

	if (!state) {
		return false;
	}

	if (typeof state.lockedUntilMs !== "number") {
		return false;
	}

	if (state.lockedUntilMs <= Date.now()) {
		state.lockedUntilMs = 0;
		return false;
	}

	return true;
}

async function ensureAvatarColumn() {
	if (avatarColumnReadyPromise) {
		return avatarColumnReadyPromise;
	}

	avatarColumnReadyPromise = (async () => {
		await pool.query("ALTER TABLE neon_auth.users ADD COLUMN IF NOT EXISTS avatar TEXT");
	})();

	try {
		await avatarColumnReadyPromise;
	} catch (error) {
		avatarColumnReadyPromise = null;
		const wrappedError = new Error("Avatar column setup failed");
		wrappedError.code = "AUTH_CONFIGURATION_ERROR";
		wrappedError.cause = error;
		throw wrappedError;
	}
}

async function ensureLoginSecurityColumns() {
	await ensureAvatarColumn();
}

async function ensureRefreshTokenColumns() {
	if (refreshTokenColumnsReadyPromise) {
		return refreshTokenColumnsReadyPromise;
	}

	refreshTokenColumnsReadyPromise = (async () => {
		await ensureAvatarColumn();
		await pool.query("ALTER TABLE neon_auth.users ADD COLUMN IF NOT EXISTS refresh_token_hash TEXT");
		await pool.query("ALTER TABLE neon_auth.users ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ");
	})();

	try {
		await refreshTokenColumnsReadyPromise;
	} catch (error) {
		refreshTokenColumnsReadyPromise = null;
		const wrappedError = new Error("Refresh token storage setup failed");
		wrappedError.code = "AUTH_CONFIGURATION_ERROR";
		wrappedError.cause = error;
		throw wrappedError;
	}
}

async function ensurePasswordResetColumns() {
	if (passwordResetColumnsReadyPromise) {
		return passwordResetColumnsReadyPromise;
	}

	passwordResetColumnsReadyPromise = (async () => {
		await pool.query("ALTER TABLE neon_auth.users ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT");
		await pool.query("ALTER TABLE neon_auth.users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ");
	})();

	try {
		await passwordResetColumnsReadyPromise;
	} catch (error) {
		passwordResetColumnsReadyPromise = null;
		const wrappedError = new Error("Password reset storage setup failed");
		wrappedError.code = "AUTH_CONFIGURATION_ERROR";
		wrappedError.cause = error;
		throw wrappedError;
	}
}

async function ensureOauthAccountTable() {
	if (oauthAccountTableReadyPromise) {
		return oauthAccountTableReadyPromise;
	}

	oauthAccountTableReadyPromise = (async () => {
		await pool.query(
			`CREATE TABLE IF NOT EXISTS neon_auth.user_oauth_accounts (
				oauth_account_id BIGSERIAL PRIMARY KEY,
				user_id UUID NOT NULL REFERENCES neon_auth.users(user_id) ON DELETE CASCADE,
				provider TEXT NOT NULL,
				provider_user_id TEXT NOT NULL,
				provider_email TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				UNIQUE (provider, provider_user_id),
				UNIQUE (user_id, provider)
			)`
		);
		await pool.query("CREATE INDEX IF NOT EXISTS idx_user_oauth_accounts_user_id ON neon_auth.user_oauth_accounts (user_id)");
	})();

	try {
		await oauthAccountTableReadyPromise;
	} catch (error) {
		oauthAccountTableReadyPromise = null;
		const wrappedError = new Error("OAuth account storage setup failed");
		wrappedError.code = "AUTH_CONFIGURATION_ERROR";
		wrappedError.cause = error;
		throw wrappedError;
	}
}

function hashOpaqueToken(token) {
	const normalizedToken = typeof token === "string" ? token.trim() : "";

	if (!normalizedToken) {
		const error = new Error("Refresh token is required");
		error.code = "INVALID_REFRESH_TOKEN";
		throw error;
	}

	return crypto.createHash("sha256").update(normalizedToken).digest("hex");
}

function safeTimingEqual(leftValue, rightValue) {
	if (typeof leftValue !== "string" || typeof rightValue !== "string") {
		return false;
	}

	const leftBuffer = Buffer.from(leftValue, "utf8");
	const rightBuffer = Buffer.from(rightValue, "utf8");

	if (leftBuffer.length !== rightBuffer.length) {
		return false;
	}

	return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeExpiryDate(value) {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		return null;
	}

	return value.toISOString();
}

async function resetLoginAttempts(userId, queryExecutor = pool) {
	const state = getLoginSecurityState(userId);

	if (!state) {
		return;
	}

	state.failedAttempts = 0;
	state.lockedUntilMs = 0;
}

async function markFailedLoginAttempt(user, queryExecutor = pool) {
	const state = getLoginSecurityState(user?.user_id);

	if (!state) {
		return;
	}

	const currentAttempts = Number.isInteger(state.failedAttempts) && state.failedAttempts >= 0
		? state.failedAttempts
		: 0;
	const nextAttempts = currentAttempts + 1;

	if (nextAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
		state.failedAttempts = 0;
		state.lockedUntilMs = Date.now() + ACCOUNT_LOCK_MINUTES * 60 * 1000;
		return;
	}

	state.failedAttempts = nextAttempts;
}

async function ensureUsernameIsAvailable(username, queryExecutor = pool) {
	const normalizedUsername = typeof username === "string" ? username.trim() : "";

	if (!normalizedUsername) {
		const error = new Error("username is required");
		error.code = "INVALID_USERNAME";
		throw error;
	}

	if (normalizedUsername.toUpperCase().includes("_BOT")) {
		const error = new Error("username cannot contain _BOT");
		error.code = "INVALID_USERNAME";
		throw error;
	}

	const existingUser = await queryExecutor.query(
		"SELECT user_id FROM neon_auth.users WHERE LOWER(username) = LOWER($1) LIMIT 1",
		[normalizedUsername]
	);

	if (existingUser.rowCount > 0) {
		const error = new Error("Username is already taken");
		error.code = "USERNAME_TAKEN";
		throw error;
	}

	return normalizedUsername;
}

async function ensureUsernameIsAvailableForUpdate(username, userId, queryExecutor = pool) {
	const normalizedUsername = typeof username === "string" ? username.trim() : "";

	if (!normalizedUsername) {
		const error = new Error("username is required");
		error.code = "INVALID_USERNAME";
		throw error;
	}

	if (normalizedUsername.toUpperCase().includes("_BOT")) {
		const error = new Error("username cannot contain _BOT");
		error.code = "INVALID_USERNAME";
		throw error;
	}

	const existingUser = await queryExecutor.query(
		"SELECT user_id FROM neon_auth.users WHERE LOWER(username) = LOWER($1) AND CAST(user_id AS TEXT) <> $2 LIMIT 1",
		[normalizedUsername, userId]
	);

	if (existingUser.rowCount > 0) {
		const error = new Error("Username is already taken");
		error.code = "USERNAME_TAKEN";
		throw error;
	}

	return normalizedUsername;
}

export async function createUser({ username, email, password, password_hash, role, ban_reason }, queryExecutor = pool) {
	await ensureAvatarColumn();
	const normalizedUsername = await ensureUsernameIsAvailable(username, queryExecutor);

	const normalizedRole = normalizeOptionalText(role);
	const normalizedBanReason = normalizeOptionalText(ban_reason);
	const normalizedPassword = typeof password === "string" ? password.trim() : "";
	const normalizedLegacyPasswordHash = typeof password_hash === "string" ? password_hash.trim() : "";
	const rawPassword = normalizedPassword || normalizedLegacyPasswordHash;

	if (!rawPassword) {
		const error = new Error("Password is required");
		error.code = "PASSWORD_REQUIRED";
		throw error;
	}

	const hashedPassword = await hashPassword(rawPassword);
	const emailVerificationToken = crypto.randomUUID();
	const avatar = pickRandomAvatar();

	const insertColumns = ["username", "email", "password_hash", "ban_reason", "email_verified", "email_verification_token", "avatar"];
	const insertValues = [normalizedUsername, email, hashedPassword, normalizedBanReason, false, emailVerificationToken, avatar];

	if (normalizedRole) {
		insertColumns.splice(3, 0, "role");
		insertValues.splice(3, 0, normalizedRole);
	}

	const valuePlaceholders = insertValues.map((_, index) => `$${index + 1}`).join(", ");
	const insertQuery = `INSERT INTO neon_auth.users (${insertColumns.join(", ")}) VALUES (${valuePlaceholders}) RETURNING ${USER_CREATE_RETURN_FIELDS}`;
	const result = await queryExecutor.query(insertQuery, insertValues);

	return result.rows[0];
}

function normalizeToken(token) {
	if (typeof token !== "string") {
		return "";
	}

	return token.trim();
}

export async function verifyUserEmailByToken(token) {
	const normalizedToken = normalizeToken(token);

	if (!normalizedToken) {
		const error = new Error("Verification token is required");
		error.code = "TOKEN_REQUIRED";
		throw error;
	}

	const userResult = await pool.query(
		`UPDATE neon_auth.users
		 SET email_verified = TRUE,
			 email_verification_token = NULL,
			 email_verification_expires = NULL
		 WHERE email_verification_token = $1
		 RETURNING ${USER_SELECT_FIELDS}`,
		[normalizedToken]
	);

	if (userResult.rowCount > 0) {
		return userResult.rows[0];
	}

	const error = new Error("Invalid verification token");
	error.code = "TOKEN_INVALID";
	throw error;
}

export async function authenticateUser({ email, password, password_hash }) {
	await ensureLoginSecurityColumns();

	const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
	const normalizedPasswordHash = typeof password_hash === "string" ? password_hash.trim() : "";
	const normalizedPassword = typeof password === "string" ? password.trim() : "";
	const rawPassword = normalizedPassword || normalizedPasswordHash;

	if (!normalizedEmail || !rawPassword) {
		const error = new Error("Email and password are required");
		error.code = "MISSING_LOGIN_FIELDS";
		throw error;
	}

	const result = await pool.query(
		`SELECT ${USER_AUTH_SELECT_FIELDS}
		 FROM neon_auth.users
		 WHERE LOWER(email) = LOWER($1)
		 LIMIT 1`,
		[normalizedEmail]
	);

	if (result.rowCount === 0) {
		const error = new Error("Invalid email or password");
		error.code = "INVALID_CREDENTIALS";
		throw error;
	}

	const userWithPasswordHash = result.rows[0];

	if (isLockActiveForUser(userWithPasswordHash.user_id)) {
		const error = new Error("Account is locked due to failed login attempts");
		error.code = "ACCOUNT_LOCKED";
		throw error;
	}

	if (userWithPasswordHash.email_verified !== true) {
		const error = new Error("Verify email first");
		error.code = "EMAIL_NOT_VERIFIED";
		throw error;
	}

	const isPasswordValid = await verifyPassword(rawPassword, userWithPasswordHash.password_hash);

	if (!isPasswordValid) {
		await markFailedLoginAttempt(userWithPasswordHash);

		const error = new Error("Invalid email or password");
		error.code = "INVALID_CREDENTIALS";
		throw error;
	}

	await resetLoginAttempts(userWithPasswordHash.user_id);

	const { password_hash: _, ...user } = userWithPasswordHash;

	return user;
}

export async function storeRefreshTokenForUser(userId, refreshToken, refreshTokenExpiresAt = null, queryExecutor = pool) {
	await ensureRefreshTokenColumns();

	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	const refreshTokenHash = hashOpaqueToken(refreshToken);
	const normalizedRefreshTokenExpiresAt = normalizeExpiryDate(refreshTokenExpiresAt);

	const result = await queryExecutor.query(
		`UPDATE neon_auth.users
		 SET refresh_token_hash = $2,
			 refresh_token_expires_at = $3,
			 updated_at = NOW()
		 WHERE CAST(user_id AS TEXT) = $1
		 RETURNING ${USER_SELECT_FIELDS}`,
		[normalizedUserId, refreshTokenHash, normalizedRefreshTokenExpiresAt]
	);

	if (result.rowCount === 0) {
		const error = new Error("User not found");
		error.code = "USER_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}

export async function clearRefreshTokenForUser(userId, queryExecutor = pool) {
	await ensureRefreshTokenColumns();

	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	const result = await queryExecutor.query(
		`UPDATE neon_auth.users
		 SET refresh_token_hash = NULL,
			 refresh_token_expires_at = NULL,
			 updated_at = NOW()
		 WHERE CAST(user_id AS TEXT) = $1
		 RETURNING ${USER_SELECT_FIELDS}`,
		[normalizedUserId]
	);

	if (result.rowCount === 0) {
		const error = new Error("User not found");
		error.code = "USER_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}

export async function authenticateRefreshSession({ userId, email, refreshToken }) {
	await ensureRefreshTokenColumns();

	const normalizedUserId = normalizeUserId(userId);
	const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

	if (!normalizedUserId) {
		const error = new Error("Invalid or expired refresh token");
		error.code = "INVALID_REFRESH_TOKEN";
		throw error;
	}

	const providedRefreshTokenHash = hashOpaqueToken(refreshToken);

	const result = await pool.query(
		`SELECT ${USER_REFRESH_SELECT_FIELDS}
		 FROM neon_auth.users
		 WHERE CAST(user_id AS TEXT) = $1
		 LIMIT 1`,
		[normalizedUserId]
	);

	if (result.rowCount === 0) {
		const error = new Error("Invalid or expired refresh token");
		error.code = "INVALID_REFRESH_TOKEN";
		throw error;
	}

	const userWithRefreshData = result.rows[0];

	if (!userWithRefreshData.refresh_token_hash) {
		const error = new Error("Invalid or expired refresh token");
		error.code = "INVALID_REFRESH_TOKEN";
		throw error;
	}

	if (normalizedEmail && String(userWithRefreshData.email || "").toLowerCase() !== normalizedEmail) {
		const error = new Error("Invalid or expired refresh token");
		error.code = "INVALID_REFRESH_TOKEN";
		throw error;
	}

	if (
		userWithRefreshData.refresh_token_expires_at &&
		new Date(userWithRefreshData.refresh_token_expires_at).getTime() <= Date.now()
	) {
		const error = new Error("Invalid or expired refresh token");
		error.code = "INVALID_REFRESH_TOKEN";
		throw error;
	}

	if (!safeTimingEqual(userWithRefreshData.refresh_token_hash, providedRefreshTokenHash)) {
		const error = new Error("Invalid or expired refresh token");
		error.code = "INVALID_REFRESH_TOKEN";
		throw error;
	}

	if (userWithRefreshData.email_verified !== true) {
		const error = new Error("Verify email first");
		error.code = "EMAIL_NOT_VERIFIED";
		throw error;
	}

	const { refresh_token_hash: _, refresh_token_expires_at: __, ...user } = userWithRefreshData;
	return user;
}

export async function findUserByEmail(email, queryExecutor = pool) {
	await ensureAvatarColumn();

	const normalizedEmail = normalizeEmailAddress(email);

	if (!normalizedEmail) {
		return null;
	}

	const result = await queryExecutor.query(
		`SELECT ${USER_SELECT_FIELDS}
		 FROM neon_auth.users
		 WHERE LOWER(email) = LOWER($1)
		 ORDER BY created_at ASC
		 LIMIT 1`,
		[normalizedEmail]
	);

	return result.rowCount > 0 ? result.rows[0] : null;
}

export async function findUserByOAuthAccount({ provider, providerUserId }, queryExecutor = pool) {
	await ensureAvatarColumn();
	await ensureOauthAccountTable();

	const normalizedProvider = normalizeOauthProvider(provider);
	const normalizedProviderUserId = normalizeOauthProviderUserId(providerUserId);

	if (!normalizedProvider || !normalizedProviderUserId) {
		return null;
	}

	const result = await queryExecutor.query(
		`SELECT u.user_id, u.username, u.email, u.role, u.banned, u.ban_reason, u.rating, u.online_status, u.email_verified, u.email_verification_expires, u.created_at, u.updated_at, u.avatar
		 FROM neon_auth.user_oauth_accounts oa
		 JOIN neon_auth.users u ON u.user_id = oa.user_id
		 WHERE oa.provider = $1 AND oa.provider_user_id = $2
		 LIMIT 1`,
		[normalizedProvider, normalizedProviderUserId]
	);

	return result.rowCount > 0 ? result.rows[0] : null;
}

export async function markUserEmailVerified(userId, queryExecutor = pool) {
	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	const result = await queryExecutor.query(
		`UPDATE neon_auth.users
		 SET email_verified = TRUE,
			 email_verification_token = NULL,
			 email_verification_expires = NULL,
			 updated_at = NOW()
		 WHERE CAST(user_id AS TEXT) = $1
		 RETURNING ${USER_SELECT_FIELDS}`,
		[normalizedUserId]
	);

	if (result.rowCount === 0) {
		const error = new Error("User not found");
		error.code = "USER_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}

export async function linkOAuthAccountToUser({ userId, provider, providerUserId, providerEmail }, queryExecutor = pool) {
	await ensureOauthAccountTable();

	const normalizedUserId = normalizeUserId(userId);
	const normalizedProvider = normalizeOauthProvider(provider);
	const normalizedProviderUserId = normalizeOauthProviderUserId(providerUserId);
	const normalizedProviderEmail = normalizeEmailAddress(providerEmail) || null;

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	if (!normalizedProvider || !normalizedProviderUserId) {
		const error = new Error("OAuth provider and provider user id are required");
		error.code = "INVALID_OAUTH_ACCOUNT";
		throw error;
	}

	try {
		const result = await queryExecutor.query(
			`INSERT INTO neon_auth.user_oauth_accounts (user_id, provider, provider_user_id, provider_email)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (user_id, provider)
			 DO UPDATE SET
				provider_user_id = EXCLUDED.provider_user_id,
				provider_email = EXCLUDED.provider_email,
				updated_at = NOW()
			 RETURNING oauth_account_id, user_id, provider, provider_user_id, provider_email, created_at, updated_at`,
			[normalizedUserId, normalizedProvider, normalizedProviderUserId, normalizedProviderEmail]
		);

		return result.rows[0];
	} catch (error) {
		if (error?.code === "23505") {
			const conflictError = new Error("OAuth account is already linked to another user");
			conflictError.code = "OAUTH_ACCOUNT_CONFLICT";
			throw conflictError;
		}

		throw error;
	}
}

export async function createOAuthUser({ username, email, role, ban_reason }, queryExecutor = pool) {
	await ensureAvatarColumn();

	const normalizedEmail = normalizeEmailAddress(email);

	if (!normalizedEmail) {
		const error = new Error("Email is required");
		error.code = "EMAIL_REQUIRED";
		throw error;
	}

	const normalizedUsername = await ensureUsernameIsAvailable(username, queryExecutor);

	const normalizedRole = normalizeOptionalText(role);
	const normalizedBanReason = normalizeOptionalText(ban_reason);
	const avatar = pickRandomAvatar();
	const insertColumns = [
		"username",
		"email",
		"password_hash",
		"ban_reason",
		"email_verified",
		"email_verification_token",
		"email_verification_expires",
		"avatar",
	];
	const insertValues = [normalizedUsername, normalizedEmail, null, normalizedBanReason, true, null, null, avatar];

	if (normalizedRole) {
		insertColumns.splice(3, 0, "role");
		insertValues.splice(3, 0, normalizedRole);
	}

	const valuePlaceholders = insertValues.map((_, index) => `$${index + 1}`).join(", ");
	const result = await queryExecutor.query(
		`INSERT INTO neon_auth.users (${insertColumns.join(", ")}) VALUES (${valuePlaceholders}) RETURNING ${USER_SELECT_FIELDS}`,
		insertValues
	);

	return result.rows[0];
}

export async function setPasswordResetTokenForEmail({ email, resetToken, expiresAt }, queryExecutor = pool) {
	await ensurePasswordResetColumns();

	const normalizedEmail = normalizeEmailAddress(email);
	const normalizedResetToken = typeof resetToken === "string" ? resetToken.trim() : "";
	const normalizedExpiresAt = normalizeExpiryDate(expiresAt);

	if (!normalizedEmail) {
		const error = new Error("Email is required");
		error.code = "EMAIL_REQUIRED";
		throw error;
	}

	if (!normalizedResetToken || !normalizedExpiresAt) {
		const error = new Error("Reset token and expiry are required");
		error.code = "INVALID_PASSWORD_RESET_REQUEST";
		throw error;
	}

	const resetTokenHash = hashOpaqueToken(normalizedResetToken);

	const result = await queryExecutor.query(
		`UPDATE neon_auth.users
		 SET password_reset_token_hash = $2,
			 password_reset_expires_at = $3,
			 updated_at = NOW()
		 WHERE LOWER(email) = LOWER($1)
		 RETURNING user_id`,
		[normalizedEmail, resetTokenHash, normalizedExpiresAt]
	);

	return result.rowCount > 0;
}

export async function resetPasswordByToken({ resetToken, newPassword }, queryExecutor = pool) {
	await ensurePasswordResetColumns();
	await ensureLoginSecurityColumns();
	await ensureRefreshTokenColumns();

	const normalizedResetToken = typeof resetToken === "string" ? resetToken.trim() : "";
	const normalizedPassword = typeof newPassword === "string" ? newPassword.trim() : "";

	if (!normalizedResetToken) {
		const error = new Error("Reset token is required");
		error.code = "RESET_TOKEN_REQUIRED";
		throw error;
	}

	const resetTokenHash = hashOpaqueToken(normalizedResetToken);
	const hashedPassword = await hashPassword(normalizedPassword);

	const result = await queryExecutor.query(
		`UPDATE neon_auth.users
		 SET password_hash = $2,
			 password_reset_token_hash = NULL,
			 password_reset_expires_at = NULL,
			 refresh_token_hash = NULL,
			 refresh_token_expires_at = NULL,
			 updated_at = NOW()
		 WHERE password_reset_token_hash = $1
		   AND password_reset_expires_at IS NOT NULL
		   AND password_reset_expires_at > NOW()
		 RETURNING ${USER_SELECT_FIELDS}`,
		[resetTokenHash, hashedPassword]
	);

	if (result.rowCount === 0) {
		const error = new Error("Invalid or expired password reset token");
		error.code = "INVALID_PASSWORD_RESET_TOKEN";
		throw error;
	}

	await resetLoginAttempts(result.rows[0]?.user_id);

	return result.rows[0];
}

export async function getUserById(userId, queryExecutor = pool) {
	await ensureAvatarColumn();

	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	const result = await queryExecutor.query(
		`SELECT ${USER_SELECT_FIELDS}
		 FROM neon_auth.users
		 WHERE CAST(user_id AS TEXT) = $1
		 LIMIT 1`,
		[normalizedUserId]
	);

	if (result.rowCount === 0) {
		const error = new Error("User not found");
		error.code = "USER_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}

export async function updateUserById(userId, updates, queryExecutor = pool) {
	await ensureAvatarColumn();

	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	const payload = updates && typeof updates === "object" ? updates : {};
	const allowedFields = ["username", "role", "ban_reason", "banned", "rating", "online_status", "avatar"];
	const providedFields = Object.keys(payload);
	const invalidFields = providedFields.filter((field) => !allowedFields.includes(field));

	if (invalidFields.length > 0) {
		const error = new Error(`Invalid update fields: ${invalidFields.join(", ")}`);
		error.code = "INVALID_UPDATE_FIELDS";
		throw error;
	}

	const updateColumns = [];
	const updateValues = [];
	let normalizedUsername;

	if (Object.prototype.hasOwnProperty.call(payload, "username")) {
		if (typeof payload.username !== "string" || payload.username.trim() === "") {
			const error = new Error("username must be a non-empty string");
			error.code = "INVALID_UPDATE_FIELDS";
			throw error;
		}

		normalizedUsername = payload.username.trim();
		updateColumns.push(`username = $${updateValues.length + 1}`);
		updateValues.push(normalizedUsername);
	}

	if (Object.prototype.hasOwnProperty.call(payload, "role")) {
		if (payload.role !== null && typeof payload.role !== "string") {
			const error = new Error("role must be a string or null");
			error.code = "INVALID_UPDATE_FIELDS";
			throw error;
		}

		const normalizedRole = payload.role === null ? null : normalizeOptionalText(payload.role);
		updateColumns.push(`role = $${updateValues.length + 1}`);
		updateValues.push(normalizedRole);
	}

	if (Object.prototype.hasOwnProperty.call(payload, "ban_reason")) {
		if (payload.ban_reason !== null && typeof payload.ban_reason !== "string") {
			const error = new Error("ban_reason must be a string or null");
			error.code = "INVALID_UPDATE_FIELDS";
			throw error;
		}

		const normalizedBanReason = payload.ban_reason === null ? null : normalizeOptionalText(payload.ban_reason);
		updateColumns.push(`ban_reason = $${updateValues.length + 1}`);
		updateValues.push(normalizedBanReason);
	}

	if (Object.prototype.hasOwnProperty.call(payload, "banned")) {
		if (typeof payload.banned !== "boolean") {
			const error = new Error("banned must be a boolean");
			error.code = "INVALID_UPDATE_FIELDS";
			throw error;
		}

		updateColumns.push(`banned = $${updateValues.length + 1}`);
		updateValues.push(payload.banned);
	}

	if (Object.prototype.hasOwnProperty.call(payload, "rating")) {
		const normalizedRating = Number(payload.rating);

		if (!Number.isFinite(normalizedRating)) {
			const error = new Error("rating must be a valid number");
			error.code = "INVALID_UPDATE_FIELDS";
			throw error;
		}

		updateColumns.push(`rating = $${updateValues.length + 1}`);
		updateValues.push(normalizedRating);
	}

	if (Object.prototype.hasOwnProperty.call(payload, "online_status")) {
		if (typeof payload.online_status !== "boolean") {
			const error = new Error("online_status must be a boolean");
			error.code = "INVALID_UPDATE_FIELDS";
			throw error;
		}

		updateColumns.push(`online_status = $${updateValues.length + 1}`);
		updateValues.push(payload.online_status);
	}

	if (Object.prototype.hasOwnProperty.call(payload, "avatar")) {
		if (typeof payload.avatar !== "string") {
			const error = new Error("avatar must be a string");
			error.code = "INVALID_UPDATE_FIELDS";
			throw error;
		}

		const normalizedAvatar = payload.avatar.trim();

		if (!AVATAR_FILENAMES.includes(normalizedAvatar)) {
			const error = new Error("avatar must be one of the supported avatar filenames");
			error.code = "INVALID_UPDATE_FIELDS";
			throw error;
		}

		updateColumns.push(`avatar = $${updateValues.length + 1}`);
		updateValues.push(normalizedAvatar);
	}

	if (updateColumns.length === 0) {
		const error = new Error("At least one update field is required");
		error.code = "NO_UPDATE_FIELDS";
		throw error;
	}

	if (normalizedUsername) {
		await ensureUsernameIsAvailableForUpdate(normalizedUsername, normalizedUserId, queryExecutor);
	}

	const userIdPlaceholder = `$${updateValues.length + 1}`;
	const updateQuery = `UPDATE neon_auth.users SET ${updateColumns.join(", ")}, updated_at = NOW() WHERE CAST(user_id AS TEXT) = ${userIdPlaceholder} RETURNING ${USER_SELECT_FIELDS}`;
	const result = await queryExecutor.query(updateQuery, [...updateValues, normalizedUserId]);

	if (result.rowCount === 0) {
		const error = new Error("User not found");
		error.code = "USER_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}

export async function deleteUserById(userId, queryExecutor = pool) {
	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	const result = await queryExecutor.query(
		`DELETE FROM neon_auth.users
		 WHERE CAST(user_id AS TEXT) = $1
		 RETURNING ${USER_SELECT_FIELDS}`,
		[normalizedUserId]
	);

	if (result.rowCount === 0) {
		const error = new Error("User not found");
		error.code = "USER_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}

export async function getAllUsers() {
	await ensureAvatarColumn();

	const result = await pool.query(`SELECT ${USER_SELECT_FIELDS} FROM neon_auth.users ORDER BY created_at DESC`);
	return result.rows;
}

export async function changeUserPasswordById({ userId, currentPassword, newPassword }, queryExecutor = pool) {
	await ensureLoginSecurityColumns();
	await ensureRefreshTokenColumns();
	await ensurePasswordResetColumns();

	const normalizedUserId = normalizeUserId(userId);
	const normalizedCurrentPassword = typeof currentPassword === "string" ? currentPassword.trim() : "";
	const normalizedNewPassword = typeof newPassword === "string" ? newPassword.trim() : "";

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	if (!normalizedCurrentPassword || !normalizedNewPassword) {
		const error = new Error("Current password and new password are required");
		error.code = "PASSWORD_REQUIRED";
		throw error;
	}

	const existingUserResult = await queryExecutor.query(
		`SELECT user_id, password_hash
		 FROM neon_auth.users
		 WHERE CAST(user_id AS TEXT) = $1
		 LIMIT 1`,
		[normalizedUserId]
	);

	if (existingUserResult.rowCount === 0) {
		const error = new Error("User not found");
		error.code = "USER_NOT_FOUND";
		throw error;
	}

	const existingUser = existingUserResult.rows[0];

	if (!existingUser.password_hash) {
		const error = new Error("Password login is not available for this account");
		error.code = "PASSWORD_NOT_SET";
		throw error;
	}

	const isCurrentPasswordCorrect = await verifyPassword(normalizedCurrentPassword, existingUser.password_hash);

	if (!isCurrentPasswordCorrect) {
		const error = new Error("Current password is incorrect");
		error.code = "CURRENT_PASSWORD_INCORRECT";
		throw error;
	}

	const nextPasswordHash = await hashPassword(normalizedNewPassword);

	const updatedUserResult = await queryExecutor.query(
		`UPDATE neon_auth.users
		 SET password_hash = $2,
			 password_reset_token_hash = NULL,
			 password_reset_expires_at = NULL,
			 refresh_token_hash = NULL,
			 refresh_token_expires_at = NULL,
			 updated_at = NOW()
		 WHERE CAST(user_id AS TEXT) = $1
		 RETURNING ${USER_SELECT_FIELDS}`,
		[normalizedUserId, nextPasswordHash]
	);

	if (updatedUserResult.rowCount === 0) {
		const error = new Error("User not found");
		error.code = "USER_NOT_FOUND";
		throw error;
	}

	await resetLoginAttempts(normalizedUserId);

	return updatedUserResult.rows[0];
}

export async function getUserProfileStatistics(userId, queryExecutor = pool) {
	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	const user = await getUserById(normalizedUserId, queryExecutor);

	const gameStatsResult = await queryExecutor.query(
		`WITH user_game_ids AS (
			SELECT DISTINCT g.game_id
			FROM gameplay.games g
			LEFT JOIN gameplay.teams t ON t.game_id = g.game_id
			LEFT JOIN gameplay.team_members tm ON tm.team_id = t.team_id
			WHERE CAST(g.user_id AS TEXT) = $1
			   OR CAST(tm.user_id AS TEXT) = $1
		),
		game_data AS (
			SELECT
				g.game_id,
				g.status,
				g.rated_game,
				COUNT(tm.team_member_id) FILTER (WHERE tm.is_bot) AS bot_count
			FROM gameplay.games g
			JOIN user_game_ids ug ON ug.game_id = g.game_id
			LEFT JOIN gameplay.teams t ON t.game_id = g.game_id
			LEFT JOIN gameplay.team_members tm ON tm.team_id = t.team_id
			GROUP BY g.game_id, g.status, g.rated_game
		)
		SELECT
			COUNT(*)::int AS total_games,
			COUNT(*) FILTER (WHERE status = 'finished')::int AS finished_games,
			COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'finished')::int AS active_games,
			COUNT(*) FILTER (WHERE status = 'finished' AND rated_game AND bot_count = 0)::int AS rated_games_played,
			COUNT(*) FILTER (WHERE status = 'finished' AND (NOT rated_game OR bot_count > 0))::int AS unrated_games_played
		FROM game_data`,
		[normalizedUserId]
	);

	const createdGamesResult = await queryExecutor.query(
		`SELECT COUNT(*)::int AS created_games
		 FROM gameplay.games
		 WHERE CAST(user_id AS TEXT) = $1`,
		[normalizedUserId]
	);

	const gameStats = gameStatsResult.rows[0] ?? {};

	return {
		user_id: user.user_id,
		username: user.username,
		rating: Number(user.rating ?? 0),
		created_at: user.created_at,
		total_games: Number(gameStats.total_games ?? 0),
		finished_games: Number(gameStats.finished_games ?? 0),
		active_games: Number(gameStats.active_games ?? 0),
		created_games: Number(createdGamesResult.rows[0]?.created_games ?? 0),
		rated_games_played: Number(gameStats.rated_games_played ?? 0),
		unrated_games_played: Number(gameStats.unrated_games_played ?? 0),
	};
}

export async function getUserNavbarNotifications(userId, queryExecutor = pool) {
	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	await getUserById(normalizedUserId, queryExecutor);

	const invitationsResult = await queryExecutor.query(
		`SELECT COUNT(DISTINCT g.game_id)::int AS invitation_count
		 FROM gameplay.games g
		 JOIN gameplay.teams t ON t.game_id = g.game_id
		 JOIN gameplay.team_members tm ON tm.team_id = t.team_id
		 WHERE CAST(tm.user_id AS TEXT) = $1
		   AND CAST(g.user_id AS TEXT) <> $1
		   AND g.status IS DISTINCT FROM 'finished'`,
		[normalizedUserId]
	);

	const messagesResult = await queryExecutor.query(
		`WITH accessible_games AS (
			SELECT g.game_id
			FROM gameplay.games g
			WHERE CAST(g.user_id AS TEXT) = $1

			UNION

			SELECT t.game_id
			FROM gameplay.team_members tm
			JOIN gameplay.teams t ON t.team_id = tm.team_id
			WHERE CAST(tm.user_id AS TEXT) = $1
		)
		SELECT COUNT(*)::int AS message_count
		FROM gameplay.game_chats gc
		JOIN gameplay.team_members tm_sender ON tm_sender.team_member_id = gc.team_member_id
		JOIN gameplay.teams t_sender ON t_sender.team_id = tm_sender.team_id
		JOIN gameplay.games g ON g.game_id = t_sender.game_id
		WHERE g.game_id IN (SELECT game_id FROM accessible_games)
		  AND g.status IS DISTINCT FROM 'finished'
		  AND (tm_sender.user_id IS NULL OR CAST(tm_sender.user_id AS TEXT) <> $1)`,
		[normalizedUserId]
	);

	const invitationCount = Number(invitationsResult.rows[0]?.invitation_count ?? 0);
	const messageCount = Number(messagesResult.rows[0]?.message_count ?? 0);

	return {
		invitation_count: invitationCount,
		message_count: messageCount,
		total_count: invitationCount + messageCount,
	};
}

export async function getLeaderboardUsers(limit = 50) {
	await ensureAvatarColumn();

	const parsedLimit = Number(limit);
	const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0
		? Math.min(parsedLimit, 200)
		: 50;

	const result = await pool.query(
		`SELECT user_id, username, rating, avatar, created_at
		 FROM neon_auth.users
		 WHERE banned IS NOT TRUE
		   AND UPPER(RIGHT(username, 4)) <> '_BOT'
		 ORDER BY rating DESC NULLS LAST, created_at ASC
		 LIMIT $1`,
		[safeLimit]
	);

	return result.rows;
}

export async function getAdminLeaderboardUsers(limit = 50) {
	await ensureAvatarColumn();
	await ensureReportTable();

	const parsedLimit = Number(limit);
	const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0
		? Math.min(parsedLimit, 200)
		: 50;

	const result = await pool.query(
		`SELECT
			u.user_id,
			u.username,
			u.rating,
			u.avatar,
			u.role,
			u.created_at,
			COUNT(r.report_id)::int AS report_count
		 FROM neon_auth.users u
		 LEFT JOIN neon_auth.user_reports r ON r.reported_user_id = u.user_id
		 WHERE u.banned IS NOT TRUE
		   AND UPPER(RIGHT(u.username, 4)) <> '_BOT'
		 GROUP BY u.user_id, u.username, u.rating, u.avatar, u.role, u.created_at
		 ORDER BY u.rating DESC NULLS LAST, u.created_at ASC
		 LIMIT $1`,
		[safeLimit]
	);

	return result.rows;
}

export async function updateUserRole({ userId, role }, queryExecutor = pool) {
	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	const allowedRoles = ["player", "admin"];
	const normalizedRole = typeof role === "string" ? role.trim().toLowerCase() : "";

	if (!allowedRoles.includes(normalizedRole)) {
		const error = new Error(`role must be one of: ${allowedRoles.join(", ")}`);
		error.code = "INVALID_ROLE";
		throw error;
	}

	const result = await queryExecutor.query(
		`UPDATE neon_auth.users
		 SET role = $2, updated_at = NOW()
		 WHERE CAST(user_id AS TEXT) = $1
		 RETURNING ${USER_SELECT_FIELDS}`,
		[normalizedUserId, normalizedRole]
	);

	if (result.rowCount === 0) {
		const error = new Error("User not found");
		error.code = "USER_NOT_FOUND";
		throw error;
	}

	return result.rows[0];
}

export async function getAdminUserDetails(userId, queryExecutor = pool) {
	const normalizedUserId = normalizeUserId(userId);

	if (!normalizedUserId) {
		const error = new Error("userId is required");
		error.code = "USER_ID_REQUIRED";
		throw error;
	}

	const user = await getUserById(normalizedUserId, queryExecutor);

	const gameStatsResult = await queryExecutor.query(
		`WITH user_games AS (
			SELECT DISTINCT g.game_id, g.status
			FROM gameplay.games g
			LEFT JOIN gameplay.teams t ON t.game_id = g.game_id
			LEFT JOIN gameplay.team_members tm ON tm.team_id = t.team_id
			WHERE CAST(g.user_id AS TEXT) = $1
			   OR CAST(tm.user_id AS TEXT) = $1
		)
		SELECT
			COUNT(*)::int AS total_games,
			COUNT(*) FILTER (WHERE status = 'finished')::int AS finished_games
		FROM user_games`,
		[normalizedUserId]
	);

	const reports = await getReportsByUserId(normalizedUserId, queryExecutor);

	const messagesResult = await queryExecutor.query(
		`SELECT
			gc.chat_id,
			gc.message,
			gc.chat_type,
			gc.created_at,
			t.game_id
		 FROM gameplay.game_chats gc
		 JOIN gameplay.team_members tm ON tm.team_member_id = gc.team_member_id
		 JOIN gameplay.teams t ON t.team_id = tm.team_id
		 WHERE CAST(tm.user_id AS TEXT) = $1
		 ORDER BY gc.created_at DESC
		 LIMIT 100`,
		[normalizedUserId]
	);

	const gameStats = gameStatsResult.rows[0] ?? {};

	return {
		user,
		stats: {
			total_games: Number(gameStats.total_games ?? 0),
			finished_games: Number(gameStats.finished_games ?? 0),
		},
		reports,
		messages: messagesResult.rows,
	};
}
