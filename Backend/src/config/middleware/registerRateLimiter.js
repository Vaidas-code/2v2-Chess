import rateLimit from "express-rate-limit";

const registerRateLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 1,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: {
		ok: false,
		error: "Too many registration attempts. Please try again in 15 minutes.",
	},
});

export default registerRateLimiter;
