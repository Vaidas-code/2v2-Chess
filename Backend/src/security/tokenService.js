import jwt from "jsonwebtoken";

const ACCESS_TOKEN_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || "8h";
const REFRESH_TOKEN_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || "30d";
const OAUTH_STATE_EXPIRES_IN = process.env.OAUTH_STATE_EXPIRES_IN || "10m";

function normalizeTokenInput(token) {
	if (typeof token !== "string") {
		return "";
	}

	return token.trim();
}

function getSecret(envName) {
	const secret = typeof process.env[envName] === "string" ? process.env[envName].trim() : "";

	if (!secret) {
		const error = new Error(`${envName} is missing`);
		error.code = "AUTH_CONFIGURATION_ERROR";
		throw error;
	}

	return secret;
}

function getOptionalSecret(envName) {
	const secret = typeof process.env[envName] === "string" ? process.env[envName].trim() : "";
	return secret || "";
}

function getOauthStateSecret() {
	return getOptionalSecret("OAUTH_STATE_SECRET") || getSecret("JWT_ACCESS_SECRET");
}

function normalizeClaims({ id, email, roles }) {
	const normalizedId = id == null ? "" : String(id).trim();
	const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
	const normalizedRoles = Array.isArray(roles)
		? roles.filter((role) => typeof role === "string" && role.trim().length > 0).map((role) => role.trim())
		: [];

	if (!normalizedId || !normalizedEmail) {
		const error = new Error("Token claims id and email are required");
		error.code = "AUTH_CONFIGURATION_ERROR";
		throw error;
	}

	return {
		id: normalizedId,
		email: normalizedEmail,
		roles: normalizedRoles,
	};
}

function getTokenExpiryDate(token) {
	const decoded = jwt.decode(token);

	if (!decoded || typeof decoded !== "object" || typeof decoded.exp !== "number") {
		return null;
	}

	const expiryDate = new Date(decoded.exp * 1000);
	return Number.isNaN(expiryDate.getTime()) ? null : expiryDate;
}

export function createAuthTokens(claims) {
	const normalizedClaims = normalizeClaims(claims);
	const accessSecret = getSecret("JWT_ACCESS_SECRET");
	const refreshSecret = getSecret("JWT_REFRESH_SECRET");

	const accessToken = jwt.sign(
		{
			id: normalizedClaims.id,
			email: normalizedClaims.email,
			roles: normalizedClaims.roles,
			type: "access",
		},
		accessSecret,
		{
			expiresIn: ACCESS_TOKEN_EXPIRES_IN,
			subject: normalizedClaims.id,
		}
	);

	const refreshToken = jwt.sign(
		{
			id: normalizedClaims.id,
			email: normalizedClaims.email,
			roles: normalizedClaims.roles,
			type: "refresh",
		},
		refreshSecret,
		{
			expiresIn: REFRESH_TOKEN_EXPIRES_IN,
			subject: normalizedClaims.id,
		}
	);

	return {
		accessToken,
		accessTokenExpiresAt: getTokenExpiryDate(accessToken),
		refreshToken,
		refreshTokenExpiresAt: getTokenExpiryDate(refreshToken),
	};
}

export function verifyAccessToken(accessToken) {
	const normalizedAccessToken = normalizeTokenInput(accessToken);

	if (!normalizedAccessToken) {
		const error = new Error("Access token is required");
		error.code = "MISSING_ACCESS_TOKEN";
		throw error;
	}

	const accessSecret = getSecret("JWT_ACCESS_SECRET");

	try {
		const payload = jwt.verify(normalizedAccessToken, accessSecret);

		if (!payload || typeof payload !== "object" || payload.type !== "access") {
			const error = new Error("Invalid or expired access token");
			error.code = "INVALID_ACCESS_TOKEN";
			throw error;
		}

		const id = payload.id ?? payload.sub;
		const email = payload.email;

		if (id == null || typeof email !== "string") {
			const error = new Error("Invalid or expired access token");
			error.code = "INVALID_ACCESS_TOKEN";
			throw error;
		}

		const roles = Array.isArray(payload.roles)
			? payload.roles.filter((role) => typeof role === "string" && role.trim().length > 0).map((role) => role.trim())
			: [];

		const expiresAt = typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;

		return {
			id: String(id).trim(),
			email: email.trim().toLowerCase(),
			roles,
			expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
		};
	} catch (error) {
		if (error?.code === "INVALID_ACCESS_TOKEN") {
			throw error;
		}

		const invalidTokenError = new Error("Invalid or expired access token");
		invalidTokenError.code = "INVALID_ACCESS_TOKEN";
		throw invalidTokenError;
	}
}

export function verifyAccessTokenAllowExpired(accessToken) {
	const normalizedAccessToken = normalizeTokenInput(accessToken);

	if (!normalizedAccessToken) {
		const error = new Error("Access token is required");
		error.code = "MISSING_ACCESS_TOKEN";
		throw error;
	}

	const accessSecret = getSecret("JWT_ACCESS_SECRET");

	try {
		const payload = jwt.verify(normalizedAccessToken, accessSecret, { ignoreExpiration: true });

		if (!payload || typeof payload !== "object" || payload.type !== "access") {
			const error = new Error("Invalid access token");
			error.code = "INVALID_ACCESS_TOKEN";
			throw error;
		}

		const id = payload.id ?? payload.sub;
		const email = payload.email;

		if (id == null || typeof email !== "string") {
			const error = new Error("Invalid access token");
			error.code = "INVALID_ACCESS_TOKEN";
			throw error;
		}

		const roles = Array.isArray(payload.roles)
			? payload.roles.filter((role) => typeof role === "string" && role.trim().length > 0).map((role) => role.trim())
			: [];

		const expiresAt = typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;

		return {
			id: String(id).trim(),
			email: email.trim().toLowerCase(),
			roles,
			expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
		};
	} catch (error) {
		if (error?.code === "INVALID_ACCESS_TOKEN") {
			throw error;
		}

		const invalidTokenError = new Error("Invalid access token");
		invalidTokenError.code = "INVALID_ACCESS_TOKEN";
		throw invalidTokenError;
	}
}

export function verifyRefreshToken(refreshToken) {
	const normalizedRefreshToken = normalizeTokenInput(refreshToken);

	if (!normalizedRefreshToken) {
		const error = new Error("Refresh token is required");
		error.code = "MISSING_REFRESH_TOKEN";
		throw error;
	}

	const refreshSecret = getSecret("JWT_REFRESH_SECRET");

	try {
		const payload = jwt.verify(normalizedRefreshToken, refreshSecret);

		if (!payload || typeof payload !== "object" || payload.type !== "refresh") {
			const error = new Error("Invalid or expired refresh token");
			error.code = "INVALID_REFRESH_TOKEN";
			throw error;
		}

		const id = payload.id ?? payload.sub;
		const email = payload.email;

		if (id == null || typeof email !== "string") {
			const error = new Error("Invalid or expired refresh token");
			error.code = "INVALID_REFRESH_TOKEN";
			throw error;
		}

		const roles = Array.isArray(payload.roles)
			? payload.roles.filter((role) => typeof role === "string" && role.trim().length > 0).map((role) => role.trim())
			: [];

		const expiresAt = typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;

		return {
			id: String(id).trim(),
			email: email.trim().toLowerCase(),
			roles,
			expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
		};
	} catch (error) {
		if (error?.code === "INVALID_REFRESH_TOKEN") {
			throw error;
		}

		const invalidTokenError = new Error("Invalid or expired refresh token");
		invalidTokenError.code = "INVALID_REFRESH_TOKEN";
		throw invalidTokenError;
	}
}

function normalizeOauthRedirectPath(redirectPath) {
	const normalizedRedirectPath = typeof redirectPath === "string" ? redirectPath.trim() : "";

	if (!normalizedRedirectPath || !normalizedRedirectPath.startsWith("/")) {
		return "";
	}

	if (normalizedRedirectPath.startsWith("//")) {
		return "";
	}

	return normalizedRedirectPath;
}

export function createOAuthStateToken({ provider, redirectPath }) {
	const normalizedProvider = typeof provider === "string" ? provider.trim().toLowerCase() : "";
	const normalizedRedirectPath = normalizeOauthRedirectPath(redirectPath);

	if (!normalizedProvider) {
		const error = new Error("OAuth provider is required");
		error.code = "AUTH_CONFIGURATION_ERROR";
		throw error;
	}

	return jwt.sign(
		{
			provider: normalizedProvider,
			redirectPath: normalizedRedirectPath || undefined,
			type: "oauth-state",
		},
		getOauthStateSecret(),
		{
			expiresIn: OAUTH_STATE_EXPIRES_IN,
		}
	);
}

export function verifyOAuthStateToken(stateToken, expectedProvider) {
	const normalizedStateToken = normalizeTokenInput(stateToken);

	if (!normalizedStateToken) {
		const error = new Error("OAuth state is required");
		error.code = "MISSING_OAUTH_STATE";
		throw error;
	}

	const normalizedExpectedProvider = typeof expectedProvider === "string"
		? expectedProvider.trim().toLowerCase()
		: "";

	try {
		const payload = jwt.verify(normalizedStateToken, getOauthStateSecret());

		if (!payload || typeof payload !== "object" || payload.type !== "oauth-state") {
			const error = new Error("OAuth state is invalid or expired");
			error.code = "INVALID_OAUTH_STATE";
			throw error;
		}

		const provider = typeof payload.provider === "string" ? payload.provider.trim().toLowerCase() : "";

		if (!provider || (normalizedExpectedProvider && provider !== normalizedExpectedProvider)) {
			const error = new Error("OAuth state does not match provider");
			error.code = "INVALID_OAUTH_STATE";
			throw error;
		}

		return {
			provider,
			redirectPath: normalizeOauthRedirectPath(payload.redirectPath),
		};
	} catch (error) {
		if (error?.code === "INVALID_OAUTH_STATE") {
			throw error;
		}

		const invalidStateError = new Error("OAuth state is invalid or expired");
		invalidStateError.code = "INVALID_OAUTH_STATE";
		throw invalidStateError;
	}
}
