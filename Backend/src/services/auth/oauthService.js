import { OAuth2Client } from "google-auth-library";
import { createOAuthStateToken, verifyOAuthStateToken } from "../../security/tokenService.js";

const DEFAULT_FRONTEND_URL = "http://localhost:5173";
const DEFAULT_BACKEND_URL = "http://localhost:3001";
let googleOauthClient;

function normalizeUrl(value, fallback) {
	const normalizedValue = typeof value === "string" ? value.trim() : "";
	const resolvedValue = normalizedValue || fallback;
	return resolvedValue.endsWith("/") ? resolvedValue.slice(0, -1) : resolvedValue;
}

function getRequiredEnv(envName) {
	const value = typeof process.env[envName] === "string" ? process.env[envName].trim() : "";

	if (!value) {
		const error = new Error(`${envName} is missing`);
		error.code = "OAUTH_PROVIDER_NOT_CONFIGURED";
		throw error;
	}

	return value;
}

function getBackendBaseUrl() {
	return normalizeUrl(process.env.BACKEND_URL, DEFAULT_BACKEND_URL);
}

function getFrontendBaseUrl() {
	return normalizeUrl(process.env.FRONTEND_URL, DEFAULT_FRONTEND_URL);
}

function normalizeProvider(provider) {
	return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

function getGoogleOauthClient() {
	const clientId = getRequiredEnv("GOOGLE_CLIENT_ID");

	if (!googleOauthClient) {
		googleOauthClient = new OAuth2Client(clientId);
	}

	return googleOauthClient;
}

function getProviderConfig(provider) {
	const normalizedProvider = normalizeProvider(provider);

	if (normalizedProvider === "google") {
		const callbackUrl = normalizeUrl(
			process.env.GOOGLE_OAUTH_CALLBACK_URL,
			`${getBackendBaseUrl()}/auth/google/callback`
		);

		return {
			provider: "google",
			displayName: "Google",
			clientId: getRequiredEnv("GOOGLE_CLIENT_ID"),
			clientSecret: getRequiredEnv("GOOGLE_CLIENT_SECRET"),
			callbackUrl,
			authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
			scope: "openid email profile",
		};
	}

	if (normalizedProvider === "facebook") {
		const callbackUrl = normalizeUrl(
			process.env.FACEBOOK_OAUTH_CALLBACK_URL,
			`${getBackendBaseUrl()}/auth/facebook/callback`
		);

		return {
			provider: "facebook",
			displayName: "Facebook",
			clientId: getRequiredEnv("FACEBOOK_APP_ID"),
			clientSecret: getRequiredEnv("FACEBOOK_APP_SECRET"),
			callbackUrl,
			authorizationUrl: "https://www.facebook.com/v22.0/dialog/oauth",
			tokenUrl: "https://graph.facebook.com/v22.0/oauth/access_token",
			profileUrl: "https://graph.facebook.com/v22.0/me",
			scope: "email,public_profile",
		};
	}

	const error = new Error("Unsupported OAuth provider");
	error.code = "UNSUPPORTED_OAUTH_PROVIDER";
	throw error;
}

async function parseJsonResponse(response, fallbackMessage, errorCode) {
	const responseText = await response.text();
	let responseBody = null;

	try {
		responseBody = responseText ? JSON.parse(responseText) : null;
	} catch {
		responseBody = null;
	}

	if (!response.ok) {
		const error = new Error(
			responseBody?.error_description ||
			responseBody?.error?.message ||
			responseBody?.message ||
			fallbackMessage
		);
		error.code = errorCode;
		error.details = responseBody || responseText;
		throw error;
	}

	return responseBody || {};
}

async function exchangeGoogleCodeForToken(code, config) {
	const body = new URLSearchParams({
		code,
		client_id: config.clientId,
		client_secret: config.clientSecret,
		redirect_uri: config.callbackUrl,
		grant_type: "authorization_code",
	});

	const response = await fetch(config.tokenUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body,
	});

	const payload = await parseJsonResponse(
		response,
		"Could not exchange Google authorization code",
		"OAUTH_ACCESS_TOKEN_EXCHANGE_FAILED"
	);
	const accessToken = typeof payload?.access_token === "string" ? payload.access_token.trim() : "";

	if (!accessToken) {
		const error = new Error("Google access token is missing");
		error.code = "OAUTH_ACCESS_TOKEN_EXCHANGE_FAILED";
		throw error;
	}

	return accessToken;
}

async function exchangeFacebookCodeForToken(code, config) {
	const tokenUrl = new URL(config.tokenUrl);
	tokenUrl.searchParams.set("client_id", config.clientId);
	tokenUrl.searchParams.set("client_secret", config.clientSecret);
	tokenUrl.searchParams.set("redirect_uri", config.callbackUrl);
	tokenUrl.searchParams.set("code", code);

	const response = await fetch(tokenUrl, {
		method: "GET",
		headers: {
			Accept: "application/json",
		},
	});

	const payload = await parseJsonResponse(
		response,
		"Could not exchange Facebook authorization code",
		"OAUTH_ACCESS_TOKEN_EXCHANGE_FAILED"
	);
	const accessToken = typeof payload?.access_token === "string" ? payload.access_token.trim() : "";

	if (!accessToken) {
		const error = new Error("Facebook access token is missing");
		error.code = "OAUTH_ACCESS_TOKEN_EXCHANGE_FAILED";
		throw error;
	}

	return accessToken;
}

async function fetchGoogleProfile(accessToken, config) {
	const response = await fetch(config.profileUrl, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});

	const payload = await parseJsonResponse(response, "Could not load Google profile", "OAUTH_PROFILE_FETCH_FAILED");
	const providerUserId = typeof payload?.sub === "string" ? payload.sub.trim() : "";
	const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
	const emailVerified = payload?.email_verified === true;
	const displayName = typeof payload?.name === "string"
		? payload.name.trim()
		: typeof payload?.given_name === "string"
			? payload.given_name.trim()
			: "";

	if (!providerUserId || !email) {
		const error = new Error("Google account must provide both id and email");
		error.code = "OAUTH_PROFILE_INCOMPLETE";
		throw error;
	}

	if (!emailVerified) {
		const error = new Error("Google account email must be verified");
		error.code = "OAUTH_EMAIL_NOT_VERIFIED";
		throw error;
	}

	return {
		provider: "google",
		providerUserId,
		email,
		emailVerified,
		displayName,
	};
}

export function getGoogleClientId() {
	return getRequiredEnv("GOOGLE_CLIENT_ID");
}

export async function verifyGoogleIdToken(idToken) {
	const normalizedIdToken = typeof idToken === "string" ? idToken.trim() : "";

	if (!normalizedIdToken) {
		const error = new Error("Google ID token is required");
		error.code = "MISSING_GOOGLE_ID_TOKEN";
		throw error;
	}

	const clientId = getGoogleClientId();
	let ticket;

	try {
		ticket = await getGoogleOauthClient().verifyIdToken({
			idToken: normalizedIdToken,
			audience: clientId,
		});
	} catch (error) {
		const invalidTokenError = new Error("Invalid Google ID token");
		invalidTokenError.code = "INVALID_GOOGLE_ID_TOKEN";
		invalidTokenError.cause = error;
		throw invalidTokenError;
	}

	const payload = ticket.getPayload();
	const providerUserId = typeof payload?.sub === "string" ? payload.sub.trim() : "";
	const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
	const emailVerified = payload?.email_verified === true;
	const displayName = typeof payload?.name === "string"
		? payload.name.trim()
		: typeof payload?.given_name === "string"
			? payload.given_name.trim()
			: "";

	if (!providerUserId || !email) {
		const error = new Error("Google account must provide both id and email");
		error.code = "OAUTH_PROFILE_INCOMPLETE";
		throw error;
	}

	if (!emailVerified) {
		const error = new Error("Google account email must be verified");
		error.code = "OAUTH_EMAIL_NOT_VERIFIED";
		throw error;
	}

	return {
		provider: "google",
		providerUserId,
		email,
		emailVerified,
		displayName,
	};
}

async function fetchFacebookProfile(accessToken, config) {
	const profileUrl = new URL(config.profileUrl);
	profileUrl.searchParams.set("fields", "id,name,email");
	profileUrl.searchParams.set("access_token", accessToken);

	const response = await fetch(profileUrl, {
		method: "GET",
		headers: {
			Accept: "application/json",
		},
	});

	const payload = await parseJsonResponse(response, "Could not load Facebook profile", "OAUTH_PROFILE_FETCH_FAILED");
	const providerUserId = typeof payload?.id === "string" ? payload.id.trim() : "";
	const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
	const displayName = typeof payload?.name === "string" ? payload.name.trim() : "";

	if (!providerUserId || !email) {
		const error = new Error("Facebook account must provide both id and email");
		error.code = "OAUTH_PROFILE_INCOMPLETE";
		throw error;
	}

	return {
		provider: "facebook",
		providerUserId,
		email,
		emailVerified: true,
		displayName,
	};
}

export function buildOAuthAuthorizationUrl(provider, options = {}) {
	const config = getProviderConfig(provider);
	const state = createOAuthStateToken({
		provider: config.provider,
		redirectPath: options?.redirectPath,
	});
	const authorizationUrl = new URL(config.authorizationUrl);

	if (config.provider === "google") {
		authorizationUrl.searchParams.set("client_id", config.clientId);
		authorizationUrl.searchParams.set("redirect_uri", config.callbackUrl);
		authorizationUrl.searchParams.set("response_type", "code");
		authorizationUrl.searchParams.set("scope", config.scope);
		authorizationUrl.searchParams.set("state", state);
		authorizationUrl.searchParams.set("access_type", "offline");
		authorizationUrl.searchParams.set("include_granted_scopes", "true");
		return authorizationUrl.toString();
	}

	authorizationUrl.searchParams.set("client_id", config.clientId);
	authorizationUrl.searchParams.set("redirect_uri", config.callbackUrl);
	authorizationUrl.searchParams.set("response_type", "code");
	authorizationUrl.searchParams.set("scope", config.scope);
	authorizationUrl.searchParams.set("state", state);
	return authorizationUrl.toString();
}

export async function getOAuthProfileFromCallback({ provider, code, state }) {
	const config = getProviderConfig(provider);
	const statePayload = verifyOAuthStateToken(state, config.provider);

	if (typeof code !== "string" || code.trim() === "") {
		const error = new Error("Authorization code is missing");
		error.code = "MISSING_OAUTH_CODE";
		throw error;
	}

	const normalizedCode = code.trim();

	if (config.provider === "google") {
		const accessToken = await exchangeGoogleCodeForToken(normalizedCode, config);
		const profile = await fetchGoogleProfile(accessToken, config);
		return {
			...profile,
			redirectPath: statePayload?.redirectPath || "",
		};
	}

	const accessToken = await exchangeFacebookCodeForToken(normalizedCode, config);
	const profile = await fetchFacebookProfile(accessToken, config);
	return {
		...profile,
		redirectPath: statePayload?.redirectPath || "",
	};
}

export function buildOAuthCallbackRedirect({ provider, accessToken, refreshToken, user, error, redirectPath }) {
	const callbackUrl = `${getFrontendBaseUrl()}/oauth/callback`;
	const fragmentParams = new URLSearchParams();

	if (error) {
		fragmentParams.set("status", "error");
		fragmentParams.set("provider", normalizeProvider(provider) || "social");
		fragmentParams.set("error", error);
		return `${callbackUrl}#${fragmentParams.toString()}`;
	}

	fragmentParams.set("status", "success");
	fragmentParams.set("provider", normalizeProvider(provider) || "social");
	fragmentParams.set("accessToken", accessToken);
	fragmentParams.set("refreshToken", refreshToken);

	if (user?.user_id) {
		fragmentParams.set("userId", String(user.user_id));
	}

	if (user?.email) {
		fragmentParams.set("email", String(user.email));
	}

	if (user?.username) {
		fragmentParams.set("username", String(user.username));
	}

	if (user?.avatar) {
		fragmentParams.set("avatar", String(user.avatar));
	}

	const normalizedRedirectPath = typeof redirectPath === "string" ? redirectPath.trim() : "";
	if (normalizedRedirectPath.startsWith("/") && !normalizedRedirectPath.startsWith("//")) {
		fragmentParams.set("redirect", normalizedRedirectPath);
	}

	return `${callbackUrl}#${fragmentParams.toString()}`;
}
