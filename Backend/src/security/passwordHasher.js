import argon2 from "argon2";

function parsePositiveInt(value, fallback) {
	const parsedValue = Number(value);
	return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

const ARGON2_OPTIONS = {
	type: argon2.argon2id,
	memoryCost: parsePositiveInt(process.env.ARGON2_MEMORY_COST, 19456),
	timeCost: parsePositiveInt(process.env.ARGON2_TIME_COST, 2),
	parallelism: parsePositiveInt(process.env.ARGON2_PARALLELISM, 1),
	hashLength: parsePositiveInt(process.env.ARGON2_HASH_LENGTH, 32),
};

function normalizePasswordValue(password) {
	if (typeof password !== "string") {
		return "";
	}

	return password.trim();
}

export async function hashPassword(password) {
	const normalizedPassword = normalizePasswordValue(password);

	if (!normalizedPassword) {
		const error = new Error("Password is required");
		error.code = "PASSWORD_REQUIRED";
		throw error;
	}

	return argon2.hash(normalizedPassword, ARGON2_OPTIONS);
}

export async function verifyPassword(password, hashedPassword) {
	const normalizedPassword = normalizePasswordValue(password);
	const normalizedHashedPassword = typeof hashedPassword === "string" ? hashedPassword.trim() : "";

	if (!normalizedPassword || !normalizedHashedPassword) {
		return false;
	}

	try {
		return await argon2.verify(normalizedHashedPassword, normalizedPassword, {
			type: argon2.argon2id,
		});
	} catch {
		return false;
	}
}
