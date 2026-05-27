import { verifyAccessToken } from "../../security/tokenService.js";

function extractBearerToken(authorizationHeader) {
	if (typeof authorizationHeader !== "string") return "";
	const trimmed = authorizationHeader.trim();
	if (!trimmed.toLowerCase().startsWith("bearer ")) return "";
	return trimmed.slice(7).trim();
}

export async function optionalAuthenticateAccessToken(req, _res, next) {
	const accessToken = extractBearerToken(req.headers?.authorization);

	if (!accessToken) {
		return next();
	}

	try {
		const claims = verifyAccessToken(accessToken);
		req.auth = {
			id: claims.id,
			email: claims.email,
			roles: claims.roles,
			expiresAt: claims.expiresAt,
		};
	} catch {
		// Invalid token — proceed as unauthenticated
	}

	return next();
}

export default optionalAuthenticateAccessToken;
