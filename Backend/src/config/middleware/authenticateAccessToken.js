import { verifyAccessToken } from "../../security/tokenService.js";

function extractBearerToken(authorizationHeader) {
	if (typeof authorizationHeader !== "string") {
		return "";
	}

	const trimmedHeader = authorizationHeader.trim();
	if (!trimmedHeader.toLowerCase().startsWith("bearer ")) {
		return "";
	}

	return trimmedHeader.slice(7).trim();
}

export async function authenticateAccessToken(req, res, next) {
	const accessToken = extractBearerToken(req.headers?.authorization);

	if (!accessToken) {
		return res.status(401).json({
			ok: false,
			error: "Authorization header with Bearer token is required",
		});
	}

	try {
		const claims = verifyAccessToken(accessToken);
		req.auth = {
			id: claims.id,
			email: claims.email,
			roles: claims.roles,
			expiresAt: claims.expiresAt,
		};

		return next();
	} catch (error) {
		if (
			error?.code === "MISSING_ACCESS_TOKEN" ||
			error?.code === "INVALID_ACCESS_TOKEN"
		) {
			return res.status(401).json({ ok: false, error: "Invalid or expired access token" });
		}

		if (error?.code === "AUTH_CONFIGURATION_ERROR") {
			return res.status(500).json({ ok: false, error: "Authentication is not configured" });
		}

		return res.status(500).json({ ok: false, error: "Internal server error" });
	}
}

export default authenticateAccessToken;