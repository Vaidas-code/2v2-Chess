import {
	authenticateRefreshSession,
	authenticateUser,
	changeUserPasswordById,
	clearRefreshTokenForUser,
	createOAuthUser,
	createUser,
	deleteUserById,
	findUserByEmail,
	findUserByOAuthAccount,
	getAdminLeaderboardUsers,
	getAdminUserDetails,
	getLeaderboardUsers,
	getUserNavbarNotifications,
	getUserProfileStatistics,
	getUserById,
	linkOAuthAccountToUser,
	markUserEmailVerified,
	resetPasswordByToken,
	setPasswordResetTokenForEmail,
	storeRefreshTokenForUser,
	updateUserById,
	updateUserRole,
	verifyUserEmailByToken,
} from "../models/userModel.js";
import crypto from "crypto";
import pool from "../config/db.js";
import { sendPasswordResetEmail, sendRegistrationEmail } from "../services/emailService.js";
import { buildOAuthAuthorizationUrl, buildOAuthCallbackRedirect, getGoogleClientId, getOAuthProfileFromCallback, verifyGoogleIdToken } from "../services/auth/oauthService.js";
import { createAuthTokens, verifyRefreshToken } from "../security/tokenService.js";

const REQUIRED_REGISTER_FIELDS = ["username", "email", "password"];
const REQUIRED_LOGIN_FIELDS = ["email", "password"];
const REQUIRED_REFRESH_FIELDS = ["refreshToken"];
const REQUIRED_PASSWORD_RESET_REQUEST_FIELDS = ["email"];
const REQUIRED_PASSWORD_RESET_CONFIRM_FIELDS = ["token", "password", "repeatPassword"];
const REQUIRED_PASSWORD_CHANGE_FIELDS = ["currentPassword", "newPassword", "repeatNewPassword"];
const PASSWORD_RESET_TOKEN_TTL_MINUTES = 60;

function normalizePasswordFromBody(body) {
	const normalizedPassword = typeof body?.password === "string" ? body.password.trim() : "";
	if (normalizedPassword) {
		return normalizedPassword;
	}

	return typeof body?.password_hash === "string" ? body.password_hash.trim() : "";
}

function normalizeRegisterPayload(body) {
	const normalizedUsername = typeof body?.username === "string" ? body.username.trim() : "";
	const normalizedEmail = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
	const normalizedPassword = normalizePasswordFromBody(body);

	return {
		username: normalizedUsername,
		email: normalizedEmail,
		password: normalizedPassword,
		role: body?.role,
		ban_reason: body?.ban_reason,
	};
}

function normalizeLoginPayload(body) {
	const normalizedEmail = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
	const normalizedPassword = normalizePasswordFromBody(body);

	return {
		email: normalizedEmail,
		password: normalizedPassword,
	};
}

function normalizeRefreshPayload(body) {
	const normalizedRefreshToken = typeof body?.refreshToken === "string"
		? body.refreshToken.trim()
		: typeof body?.refresh_token === "string"
			? body.refresh_token.trim()
			: "";

	return {
		refreshToken: normalizedRefreshToken,
	};
}

function normalizePasswordResetRequestPayload(body) {
	const normalizedEmail = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

	return {
		email: normalizedEmail,
	};
}

function normalizePasswordResetConfirmPayload(body) {
	const normalizedToken = typeof body?.token === "string" ? body.token.trim() : "";
	const normalizedPassword = normalizePasswordFromBody(body);
	const normalizedRepeatPassword = typeof body?.repeatPassword === "string"
		? body.repeatPassword.trim()
		: typeof body?.confirmPassword === "string"
			? body.confirmPassword.trim()
			: "";

	return {
		token: normalizedToken,
		password: normalizedPassword,
		repeatPassword: normalizedRepeatPassword,
	};
}

function normalizePasswordChangePayload(body) {
	const normalizedCurrentPassword = typeof body?.currentPassword === "string"
		? body.currentPassword.trim()
		: typeof body?.current_password === "string"
			? body.current_password.trim()
			: "";

	const normalizedNewPassword = typeof body?.newPassword === "string"
		? body.newPassword.trim()
		: typeof body?.password === "string"
			? body.password.trim()
			: "";

	const normalizedRepeatNewPassword = typeof body?.repeatNewPassword === "string"
		? body.repeatNewPassword.trim()
		: typeof body?.confirmPassword === "string"
			? body.confirmPassword.trim()
			: "";

	return {
		currentPassword: normalizedCurrentPassword,
		newPassword: normalizedNewPassword,
		repeatNewPassword: normalizedRepeatNewPassword,
	};
}

function getMissingRequiredFields(payload) {
	return REQUIRED_REGISTER_FIELDS.filter((field) => !payload[field]);
}

function getMissingLoginFields(payload) {
	return REQUIRED_LOGIN_FIELDS.filter((field) => !payload[field]);
}

function getMissingRefreshFields(payload) {
	return REQUIRED_REFRESH_FIELDS.filter((field) => !payload[field]);
}

function getMissingPasswordResetRequestFields(payload) {
	return REQUIRED_PASSWORD_RESET_REQUEST_FIELDS.filter((field) => !payload[field]);
}

function getMissingPasswordResetConfirmFields(payload) {
	return REQUIRED_PASSWORD_RESET_CONFIRM_FIELDS.filter((field) => !payload[field]);
}

function getMissingPasswordChangeFields(payload) {
	return REQUIRED_PASSWORD_CHANGE_FIELDS.filter((field) => !payload[field]);
}

function getErrorResponse(error) {
	if (error?.code === "USERNAME_TAKEN") {
		return { status: 409, error: "Username already exists" };
	}

	if (error?.code === "INVALID_USERNAME") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "EMAIL_SEND_FAILED") {
		return { status: 503, error: "Could not send verification email. Please try again." };
	}

	if (error?.code === "PASSWORD_REQUIRED") {
		return { status: 400, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getLoginErrorResponse(error) {
	if (error?.code === "MISSING_LOGIN_FIELDS") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "INVALID_CREDENTIALS") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "EMAIL_NOT_VERIFIED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "ACCOUNT_LOCKED") {
		return { status: 423, error: error.message };
	}

	if (error?.code === "AUTH_CONFIGURATION_ERROR") {
		return { status: 500, error: "Authentication is not configured correctly" };
	}

	if (error?.code === "USER_NOT_FOUND") {
		return { status: 401, error: "Invalid credentials" };
	}

	return { status: 500, error: "Internal server error" };
}

function getSocialLoginErrorResponse(error) {
	if (error?.code === "MISSING_GOOGLE_ID_TOKEN") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "INVALID_GOOGLE_ID_TOKEN") {
		return { status: 401, error: "Invalid Google login" };
	}

	if (error?.code === "OAUTH_PROFILE_INCOMPLETE") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "OAUTH_EMAIL_NOT_VERIFIED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "OAUTH_ACCOUNT_CONFLICT") {
		return { status: 409, error: error.message };
	}

	if (error?.code === "OAUTH_PROVIDER_NOT_CONFIGURED" || error?.code === "AUTH_CONFIGURATION_ERROR") {
		return { status: 503, error: "Google login is not configured" };
	}

	return { status: 500, error: "Could not complete social login" };
}

function getRefreshSessionErrorResponse(error) {
	if (error?.code === "MISSING_REFRESH_TOKEN") {
		return { status: 400, error: "refreshToken is required" };
	}

	if (error?.code === "INVALID_REFRESH_TOKEN") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "EMAIL_NOT_VERIFIED") {
		return { status: 403, error: error.message };
	}

	if (error?.code === "AUTH_CONFIGURATION_ERROR") {
		return { status: 500, error: "Authentication is not configured correctly" };
	}

	if (error?.code === "USER_NOT_FOUND" || error?.code === "USER_ID_REQUIRED") {
		return { status: 401, error: "Invalid or expired refresh token" };
	}

	return { status: 500, error: "Internal server error" };
}

function getPasswordResetErrorResponse(error) {
	if (
		error?.code === "EMAIL_REQUIRED" ||
		error?.code === "INVALID_PASSWORD_RESET_REQUEST" ||
		error?.code === "RESET_TOKEN_REQUIRED" ||
		error?.code === "PASSWORD_REQUIRED"
	) {
		return { status: 400, error: error.message };
	}

	if (error?.code === "INVALID_PASSWORD_RESET_TOKEN") {
		return { status: 400, error: "Invalid or expired password reset token" };
	}

	if (error?.code === "AUTH_CONFIGURATION_ERROR") {
		return { status: 500, error: "Authentication is not configured correctly" };
	}

	return { status: 500, error: "Internal server error" };
}

function getPasswordChangeErrorResponse(error) {
	if (error?.code === "USER_ID_REQUIRED" || error?.code === "PASSWORD_REQUIRED") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "CURRENT_PASSWORD_INCORRECT") {
		return { status: 401, error: error.message };
	}

	if (error?.code === "PASSWORD_NOT_SET") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "USER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (error?.code === "AUTH_CONFIGURATION_ERROR") {
		return { status: 500, error: "Authentication is not configured correctly" };
	}

	return { status: 500, error: "Internal server error" };
}

function getVerifyErrorResponse(error) {
	if (error?.code === "TOKEN_REQUIRED" || error?.code === "TOKEN_INVALID") {
		return { status: 400, error: error.message };
	}

	return { status: 500, error: "Internal server error" };
}

function getUserErrorResponse(error) {
	if (error?.code === "USER_ID_REQUIRED" || error?.code === "NO_UPDATE_FIELDS" || error?.code === "INVALID_UPDATE_FIELDS" || error?.code === "INVALID_USERNAME") {
		return { status: 400, error: error.message };
	}

	if (error?.code === "USER_NOT_FOUND") {
		return { status: 404, error: error.message };
	}

	if (error?.code === "USERNAME_TAKEN") {
		return { status: 409, error: "Username already exists" };
	}

	return { status: 500, error: "Internal server error" };
}

function normalizeAuthUserId(req) {
	return typeof req?.auth?.id === "string" ? req.auth.id.trim().toLowerCase() : "";
}

function normalizeRouteUserId(req) {
	return typeof req.params?.userId === "string" ? req.params.userId.trim().toLowerCase() : "";
}

function stripVerificationToken(user) {
	if (!user || typeof user !== "object") {
		return user;
	}

	const { email_verification_token, ...publicUser } = user;
	return publicUser;
}

function toRolesArray(role) {
	if (typeof role !== "string") {
		return [];
	}

	const normalizedRole = role.trim();
	return normalizedRole ? [normalizedRole] : [];
}

function normalizeOauthCode(value) {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeOauthState(value) {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeOauthRedirectPath(value) {
	const normalizedValue = typeof value === "string" ? value.trim() : "";

	if (!normalizedValue || !normalizedValue.startsWith("/")) {
		return "";
	}

	if (normalizedValue.startsWith("//")) {
		return "";
	}

	return normalizedValue;
}

function normalizeGoogleIdToken(value) {
	return typeof value === "string" ? value.trim() : "";
}

function createPasswordResetToken() {
	return crypto.randomBytes(32).toString("hex");
}

function createPasswordResetExpiryDate() {
	return new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000);
}

function buildOauthUsernameBase(profile) {
	const baseValue = typeof profile?.displayName === "string" && profile.displayName.trim()
		? profile.displayName
		: typeof profile?.email === "string"
			? profile.email.split("@")[0]
			: "player";

	const normalizedValue = baseValue
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 20);

	return normalizedValue || `player_${crypto.randomBytes(3).toString("hex")}`;
}

function withUsernameSuffix(baseUsername, attempt) {
	if (attempt === 0) {
		return baseUsername;
	}

	const suffix = `_${attempt + 1}`;
	const trimmedBase = baseUsername.slice(0, Math.max(1, 24 - suffix.length));
	return `${trimmedBase}${suffix}`;
}

async function createOauthUserWithAvailableUsername(profile, queryExecutor) {
	const baseUsername = buildOauthUsernameBase(profile);

	for (let attempt = 0; attempt < 25; attempt += 1) {
		const username = withUsernameSuffix(baseUsername, attempt);

		try {
			return await createOAuthUser(
				{
					username,
					email: profile.email,
				},
				queryExecutor
			);
		} catch (error) {
			if (error?.code !== "USERNAME_TAKEN" && error?.code !== "INVALID_USERNAME") {
				throw error;
			}
		}
	}

	return createOAuthUser(
		{
			username: `player_${crypto.randomBytes(5).toString("hex")}`,
			email: profile.email,
		},
		queryExecutor
	);
}

function getOauthRedirectErrorMessage(error, provider) {
	if (error?.code === "OAUTH_PROVIDER_NOT_CONFIGURED") {
		const normalizedProvider = typeof provider === "string" && provider ? provider : "Social";
		return `${normalizedProvider.charAt(0).toUpperCase()}${normalizedProvider.slice(1)} login is not configured`;
	}

	if (error?.code === "MISSING_OAUTH_STATE" || error?.code === "INVALID_OAUTH_STATE") {
		return "Social login session expired. Please try again.";
	}

	if (error?.code === "MISSING_OAUTH_CODE") {
		return "Authorization code is missing.";
	}

	if (error?.code === "OAUTH_EMAIL_NOT_VERIFIED") {
		return "Your social account email must be verified.";
	}

	if (error?.code === "OAUTH_PROFILE_INCOMPLETE") {
		return "Your social account must provide an email address.";
	}

	if (error?.code === "OAUTH_ACCOUNT_CONFLICT") {
		return "This social account is already linked to another user.";
	}

	if (error?.code === "AUTH_CONFIGURATION_ERROR") {
		return "Authentication is not configured correctly.";
	}

	return "Could not complete social login.";
}

function redirectToOauthError(res, provider, error) {
	const message = getOauthRedirectErrorMessage(error, provider);
	return res.redirect(302, buildOAuthCallbackRedirect({ provider, error: message }));
}

async function createSocialSession(profile, queryExecutor) {
	let user = await findUserByOAuthAccount(
		{
			provider: profile.provider,
			providerUserId: profile.providerUserId,
		},
		queryExecutor
	);

	if (!user) {
		const existingUserByEmail = await findUserByEmail(profile.email, queryExecutor);

		if (existingUserByEmail) {
			await linkOAuthAccountToUser(
				{
					userId: existingUserByEmail.user_id,
					provider: profile.provider,
					providerUserId: profile.providerUserId,
					providerEmail: profile.email,
				},
				queryExecutor
			);

			user = existingUserByEmail.email_verified === true
				? existingUserByEmail
				: await markUserEmailVerified(existingUserByEmail.user_id, queryExecutor);
		} else {
			user = await createOauthUserWithAvailableUsername(profile, queryExecutor);
			await linkOAuthAccountToUser(
				{
					userId: user.user_id,
					provider: profile.provider,
					providerUserId: profile.providerUserId,
					providerEmail: profile.email,
				},
				queryExecutor
			);
		}
	} else {
		await linkOAuthAccountToUser(
			{
				userId: user.user_id,
				provider: profile.provider,
				providerUserId: profile.providerUserId,
				providerEmail: profile.email,
			},
			queryExecutor
		);

		if (user.email_verified !== true) {
			user = await markUserEmailVerified(user.user_id, queryExecutor);
		}
	}

	const claims = {
		id: user.user_id,
		email: user.email,
		roles: toRolesArray(user.role),
	};
	const { accessToken, refreshToken, refreshTokenExpiresAt } = createAuthTokens(claims);
	await storeRefreshTokenForUser(claims.id, refreshToken, refreshTokenExpiresAt, queryExecutor);

	return {
		accessToken,
		refreshToken,
		user,
	};
}

function startOauthLogin(provider) {
	return function startOauthLoginHandler(req, res) {
		try {
			const redirectPath = normalizeOauthRedirectPath(req.query?.redirect);
			const authorizationUrl = buildOAuthAuthorizationUrl(provider, { redirectPath });
			return res.redirect(302, authorizationUrl);
		} catch (error) {
			console.error(`Error starting ${provider} login:`, error);
			return redirectToOauthError(res, provider, error);
		}
	};
}

async function completeOauthLogin(provider, req, res) {
	const code = normalizeOauthCode(req.query?.code);
	const state = normalizeOauthState(req.query?.state);
	let client;

	try {
		const profile = await getOAuthProfileFromCallback({ provider, code, state });
		client = await pool.connect();
		await client.query("BEGIN");
		const { accessToken, refreshToken, user } = await createSocialSession(profile, client);

		await client.query("COMMIT");
		return res.redirect(
			302,
			buildOAuthCallbackRedirect({
				provider,
				accessToken,
				refreshToken,
				user,
				redirectPath: profile.redirectPath,
			})
		);
	} catch (error) {
		if (client) {
			try {
				await client.query("ROLLBACK");
			} catch (rollbackError) {
				console.error(`Error rolling back ${provider} OAuth transaction:`, rollbackError);
			}
		}

		console.error(`Error completing ${provider} login:`, error);
		return redirectToOauthError(res, provider, error);
	} finally {
		if (client) {
			client.release();
		}
	}
}

export async function getGoogleLoginConfig(_req, res) {
	try {
		return res.status(200).json({
			ok: true,
			clientId: getGoogleClientId(),
		});
	} catch (error) {
		console.error("Error loading Google login config:", error);
		const { status, error: message } = getSocialLoginErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function loginWithGoogleIdToken(req, res) {
	const idToken = normalizeGoogleIdToken(req.body?.idToken ?? req.body?.credential);
	let client;

	if (!idToken) {
		return res.status(400).json({
			ok: false,
			error: "Google ID token is required",
		});
	}

	try {
		const profile = await verifyGoogleIdToken(idToken);
		client = await pool.connect();
		await client.query("BEGIN");
		const { accessToken, refreshToken, user } = await createSocialSession(profile, client);
		await client.query("COMMIT");

		return res.status(200).json({
			ok: true,
			accessToken,
			refreshToken,
			user: {
				id: user.user_id,
				email: user.email,
				username: user.username,
				avatar: user.avatar ?? null,
				role: user.role ?? "player",
			},
		});
	} catch (error) {
		if (client) {
			try {
				await client.query("ROLLBACK");
			} catch (rollbackError) {
				console.error("Error rolling back Google ID token login transaction:", rollbackError);
			}
		}

		console.error("Error completing Google ID token login:", error);
		const { status, error: message } = getSocialLoginErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	} finally {
		if (client) {
			client.release();
		}
	}
}

export async function registerUser(req, res) {
	const payload = normalizeRegisterPayload(req.body);
	const missingFields = getMissingRequiredFields(payload);

	if (missingFields.length > 0) {
		return res.status(400).json({
			ok: false,
			error: `${missingFields.join(", ")} are required`,
		});
	}

	let client;

	try {
		client = await pool.connect();
		await client.query("BEGIN");

		const createdUser = await createUser(payload, client);

		await sendRegistrationEmail({
			email: createdUser.email,
			username: createdUser.username,
			verificationToken: createdUser.email_verification_token,
		});

		await client.query("COMMIT");

		const user = stripVerificationToken(createdUser);

		return res.status(201).json({ ok: true, user });
	} catch (error) {
		if (client) {
			try {
				await client.query("ROLLBACK");
			} catch (rollbackError) {
				console.error("Error rolling back registration transaction:", rollbackError);
			}
		}

		console.error("Error registering user:", error);
		const { status, error: message } = getErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	} finally {
		if (client) {
			client.release();
		}
	}
}

export async function verifyEmail(req, res) {
	const token = typeof req.params?.token === "string" ? req.params.token.trim() : "";

	try {
		const user = await verifyUserEmailByToken(token);

		return res.status(200).json({
			ok: true,
			message: "Email verified successfully",
			user,
		});
	} catch (error) {
		console.error("Error verifying email:", error);
		const { status, error: message } = getVerifyErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function loginUser(req, res) {
	const payload = normalizeLoginPayload(req.body);
	const missingFields = getMissingLoginFields(payload);

	if (missingFields.length > 0) {
		return res.status(400).json({
			ok: false,
			error: `${missingFields.join(", ")} are required`,
		});
	}

	try {
		const user = await authenticateUser(payload);
		const claims = {
			id: user.user_id,
			email: user.email,
			roles: toRolesArray(user.role),
		};
		const { accessToken, refreshToken, refreshTokenExpiresAt } = createAuthTokens(claims);
		await storeRefreshTokenForUser(claims.id, refreshToken, refreshTokenExpiresAt);

		console.info(
			`Login success user=${String(claims.id)} ip=${req.ip || "unknown"} at=${new Date().toISOString()}`
		);

		return res.status(200).json({
			ok: true,
			accessToken,
			refreshToken,
			user: {
				id: claims.id,
				email: claims.email,
				username: user.username ?? null,
				avatar: user.avatar ?? null,
				role: user.role ?? "player",
			},
		});
	} catch (error) {
		console.error("Error logging in user:", error);
		const { status, error: message } = getLoginErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function refreshSession(req, res) {
	const payload = normalizeRefreshPayload(req.body);
	const missingFields = getMissingRefreshFields(payload);

	if (missingFields.length > 0) {
		return res.status(400).json({
			ok: false,
			error: `${missingFields.join(", ")} is required`,
		});
	}

	try {
		const tokenClaims = verifyRefreshToken(payload.refreshToken);
		const user = await authenticateRefreshSession({
			userId: tokenClaims.id,
			email: tokenClaims.email,
			refreshToken: payload.refreshToken,
		});

		const claims = {
			id: user.user_id,
			email: user.email,
			roles: toRolesArray(user.role),
		};

		const { accessToken, refreshToken, refreshTokenExpiresAt } = createAuthTokens(claims);
		await storeRefreshTokenForUser(claims.id, refreshToken, refreshTokenExpiresAt);

		return res.status(200).json({
			ok: true,
			accessToken,
			refreshToken,
			user: {
				id: claims.id,
				email: claims.email,
				username: user.username ?? null,
				avatar: user.avatar ?? null,
				role: user.role ?? "player",
			},
		});
	} catch (error) {
		console.error("Error refreshing session:", error);
		const { status, error: message } = getRefreshSessionErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function logoutSession(req, res) {
	const payload = normalizeRefreshPayload(req.body);
	const missingFields = getMissingRefreshFields(payload);

	if (missingFields.length > 0) {
		return res.status(400).json({
			ok: false,
			error: `${missingFields.join(", ")} is required`,
		});
	}

	try {
		const tokenClaims = verifyRefreshToken(payload.refreshToken);
		await authenticateRefreshSession({
			userId: tokenClaims.id,
			email: tokenClaims.email,
			refreshToken: payload.refreshToken,
		});
		await clearRefreshTokenForUser(tokenClaims.id);

		return res.status(200).json({ ok: true, message: "Logged out successfully" });
	} catch (error) {
		console.error("Error logging out session:", error);
		const { status, error: message } = getRefreshSessionErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function requestPasswordReset(req, res) {
	const payload = normalizePasswordResetRequestPayload(req.body);
	const missingFields = getMissingPasswordResetRequestFields(payload);

	if (missingFields.length > 0) {
		return res.status(400).json({
			ok: false,
			error: `${missingFields.join(", ")} is required`,
		});
	}

	try {
		const user = await findUserByEmail(payload.email);

		if (user) {
			const resetToken = createPasswordResetToken();
			const expiresAt = createPasswordResetExpiryDate();

			await setPasswordResetTokenForEmail({
				email: payload.email,
				resetToken,
				expiresAt,
			});

			try {
				await sendPasswordResetEmail({
					email: user.email,
					username: user.username,
					resetToken,
				});
			} catch (emailError) {
				console.error("Error sending password reset email:", emailError);
			}
		}

		return res.status(200).json({
			ok: true,
			message: "If an account with that email exists, a reset link has been sent.",
		});
	} catch (error) {
		console.error("Error requesting password reset:", error);
		const { status, error: message } = getPasswordResetErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function confirmPasswordReset(req, res) {
	const payload = normalizePasswordResetConfirmPayload(req.body);
	const missingFields = getMissingPasswordResetConfirmFields(payload);

	if (missingFields.length > 0) {
		return res.status(400).json({
			ok: false,
			error: `${missingFields.join(", ")} are required`,
		});
	}

	if (payload.password !== payload.repeatPassword) {
		return res.status(400).json({
			ok: false,
			error: "Passwords do not match",
		});
	}

	if (payload.password.length < 8) {
		return res.status(400).json({
			ok: false,
			error: "Password must be at least 8 characters long",
		});
	}

	try {
		await resetPasswordByToken({
			resetToken: payload.token,
			newPassword: payload.password,
		});

		return res.status(200).json({
			ok: true,
			message: "Password has been reset successfully",
		});
	} catch (error) {
		console.error("Error confirming password reset:", error);
		const { status, error: message } = getPasswordResetErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function changeSpecificUserPassword(req, res) {
	const userId = typeof req.params?.userId === "string" ? req.params.userId.trim() : "";
	const payload = normalizePasswordChangePayload(req.body);
	const missingFields = getMissingPasswordChangeFields(payload);

	if (missingFields.length > 0) {
		return res.status(400).json({
			ok: false,
			error: `${missingFields.join(", ")} are required`,
		});
	}

	const authUserId = normalizeAuthUserId(req);
	const routeUserId = normalizeRouteUserId(req);

	if (!authUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	if (!routeUserId || routeUserId !== authUserId) {
		return res.status(403).json({ ok: false, error: "You can change only your own password" });
	}

	if (payload.newPassword !== payload.repeatNewPassword) {
		return res.status(400).json({
			ok: false,
			error: "Passwords do not match",
		});
	}

	if (payload.newPassword.length < 8) {
		return res.status(400).json({
			ok: false,
			error: "Password must be at least 8 characters long",
		});
	}

	if (payload.currentPassword === payload.newPassword) {
		return res.status(400).json({
			ok: false,
			error: "New password must be different from current password",
		});
	}

	try {
		const user = await changeUserPasswordById({
			userId,
			currentPassword: payload.currentPassword,
			newPassword: payload.newPassword,
		});

		const claims = {
			id: user.user_id,
			email: user.email,
			roles: toRolesArray(user.role),
		};

		const { accessToken, refreshToken, refreshTokenExpiresAt } = createAuthTokens(claims);
		await storeRefreshTokenForUser(claims.id, refreshToken, refreshTokenExpiresAt);

		return res.status(200).json({
			ok: true,
			message: "Password updated successfully",
			accessToken,
			refreshToken,
			user: {
				id: user.user_id,
				email: user.email,
				username: user.username,
				avatar: user.avatar ?? null,
			},
		});
	} catch (error) {
		console.error("Error changing user password:", error);
		const { status, error: message } = getPasswordChangeErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function getSpecificUserStatistics(req, res) {
	const userId = typeof req.params?.userId === "string" ? req.params.userId.trim() : "";
	const authUserId = normalizeAuthUserId(req);

	if (!authUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	try {
		const stats = await getUserProfileStatistics(userId);
		return res.status(200).json({ ok: true, stats });
	} catch (error) {
		console.error("Error fetching user statistics:", error);
		const { status, error: message } = getUserErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function getNavbarNotifications(req, res) {
	const userId = typeof req.params?.userId === "string" ? req.params.userId.trim() : "";
	const authUserId = normalizeAuthUserId(req);
	const routeUserId = normalizeRouteUserId(req);

	if (!authUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	if (!routeUserId || routeUserId !== authUserId) {
		return res.status(403).json({ ok: false, error: "You can view only your own notifications" });
	}

	try {
		const notifications = await getUserNavbarNotifications(userId);
		return res.status(200).json({ ok: true, notifications });
	} catch (error) {
		console.error("Error fetching navbar notifications:", error);
		const { status, error: message } = getUserErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function getSpecificUser(req, res) {
	const userId = typeof req.params?.userId === "string" ? req.params.userId.trim() : "";

	try {
		const user = await getUserById(userId);
		return res.status(200).json({ ok: true, user });
	} catch (error) {
		console.error("Error fetching user:", error);
		const { status, error: message } = getUserErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function updateSpecificUser(req, res) {
	const userId = typeof req.params?.userId === "string" ? req.params.userId.trim() : "";
	const payload = req.body && typeof req.body === "object" ? req.body : {};

	try {
		const user = await updateUserById(userId, payload);
		return res.status(200).json({ ok: true, user });
	} catch (error) {
		console.error("Error updating user:", error);
		const { status, error: message } = getUserErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function deleteSpecificUser(req, res) {
	const userId = typeof req.params?.userId === "string" ? req.params.userId.trim() : "";

	try {
		const user = await deleteUserById(userId);
		return res.status(200).json({ ok: true, message: "User deleted successfully", user });
	} catch (error) {
		console.error("Error deleting user:", error);
		const { status, error: message } = getUserErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function getLeaderboard(req, res) {
	try {
		const isAdmin = Array.isArray(req.auth?.roles) && req.auth.roles.includes("admin");
		const leaderboard = isAdmin ? await getAdminLeaderboardUsers() : await getLeaderboardUsers();
		return res.status(200).json({ ok: true, leaderboard });
	} catch (error) {
		console.error("Error fetching leaderboard:", error);
		return res.status(500).json({ ok: false, error: "Could not fetch leaderboard" });
	}
}

export async function patchUserRole(req, res) {
	const actingUserId = normalizeAuthUserId(req);
	const targetUserId = normalizeRouteUserId(req);
	const role = typeof req.body?.role === "string" ? req.body.role.trim().toLowerCase() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	const isAdmin = Array.isArray(req.auth?.roles) && req.auth.roles.includes("admin");
	if (!isAdmin) {
		return res.status(403).json({ ok: false, error: "Admin access required" });
	}

	if (!role) {
		return res.status(400).json({ ok: false, error: "role is required" });
	}

	try {
		const user = await updateUserRole({ userId: targetUserId, role });
		return res.status(200).json({ ok: true, user });
	} catch (error) {
		console.error("Error updating user role:", error);
		const { status, error: message } = getUserErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function banUserHandler(req, res) {
	const actingUserId = normalizeAuthUserId(req);
	const targetUserId = normalizeRouteUserId(req);

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	const isAdmin = Array.isArray(req.auth?.roles) && req.auth.roles.includes("admin");
	if (!isAdmin) {
		return res.status(403).json({ ok: false, error: "Admin access required" });
	}

	const banReason = typeof req.body?.ban_reason === "string" ? req.body.ban_reason.trim() : "";

	if (!banReason) {
		return res.status(400).json({ ok: false, error: "ban_reason is required" });
	}

	try {
		const user = await updateUserById(targetUserId, { banned: true, ban_reason: banReason });
		return res.status(200).json({ ok: true, user });
	} catch (error) {
		console.error("Error banning user:", error);
		const { status, error: message } = getUserErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export async function getAdminUserDetailsHandler(req, res) {
	const actingUserId = normalizeAuthUserId(req);
	const targetUserId = normalizeRouteUserId(req);

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	const isAdmin = Array.isArray(req.auth?.roles) && req.auth.roles.includes("admin");
	if (!isAdmin) {
		return res.status(403).json({ ok: false, error: "Admin access required" });
	}

	try {
		const details = await getAdminUserDetails(targetUserId);
		return res.status(200).json({ ok: true, ...details });
	} catch (error) {
		console.error("Error fetching admin user details:", error);
		const { status, error: message } = getUserErrorResponse(error);
		return res.status(status).json({ ok: false, error: message });
	}
}

export const startGoogleLogin = startOauthLogin("google");
export const startFacebookLogin = startOauthLogin("facebook");

export function completeGoogleLogin(req, res) {
	return completeOauthLogin("google", req, res);
}

export function completeFacebookLogin(req, res) {
	return completeOauthLogin("facebook", req, res);
}
