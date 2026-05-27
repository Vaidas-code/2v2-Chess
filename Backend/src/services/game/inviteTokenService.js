import { randomBytes } from "crypto";

export function generateInviteToken() {
	return randomBytes(12).toString("hex");
}
