import rateLimit from "express-rate-limit";

const loginRateLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 20,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	skipSuccessfulRequests: true,
	message: {
		ok: false,
		error: "Too many login attempts. Please try again in 15 minutes.",
	},
});

export default loginRateLimiter;
