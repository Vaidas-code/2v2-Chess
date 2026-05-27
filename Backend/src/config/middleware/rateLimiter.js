import rateLimit from "express-rate-limit";

const rateLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 100,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { ok: false, error: "Too many requests, please try again later." },
});

export default rateLimiter;
