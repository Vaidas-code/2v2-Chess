import nodemailer from "nodemailer";

const senderEmail = process.env.EMAIL_SENDER || "";
const smtpUser = (process.env.EMAIL_USER || "").trim();
const smtpPassword = (process.env.EMAIL_PASS || "").replace(/\s+/g, "");
const basePort = Number(process.env.PORT) || 3001;
const verificationBaseUrl = (process.env.API_BASE_URL || `http://localhost:${basePort}`).trim().replace(/\/$/, "");
const frontendBaseUrl = (process.env.FRONTEND_URL || "http://localhost:5173").trim().replace(/\/$/, "");
const passwordResetPageUrl = (process.env.PASSWORD_RESET_PAGE_URL || `${frontendBaseUrl}/reset-password`).trim();
const createTransport = nodemailer.createTransport.bind(nodemailer);

const isEmailConfigured =
	typeof smtpUser === "string" &&
	smtpUser.trim().length > 0 &&
	typeof smtpPassword === "string" &&
	smtpPassword.trim().length > 0 &&
	typeof createTransport === "function";

const transporterPromise = isEmailConfigured
	? Promise.resolve(
			createTransport({
				service: "gmail",
				auth: {
					user: smtpUser,
					pass: smtpPassword,
				},
			})
	  )
	: null;

function createEmailSendError(message, cause) {
	const error = new Error(message);
	error.code = "EMAIL_SEND_FAILED";

	if (cause) {
		error.cause = cause;
	}

	return error;
}

function getVerificationLink(token) {
	if (typeof token !== "string" || token.trim().length === 0) {
		return null;
	}

	const normalizedToken = encodeURIComponent(token.trim());
	return `${verificationBaseUrl}/email-verifications/${normalizedToken}`;
}

function getPasswordResetLink(token) {
	if (typeof token !== "string" || token.trim().length === 0) {
		return null;
	}

	if (!passwordResetPageUrl) {
		return null;
	}

	const normalizedToken = encodeURIComponent(token.trim());
	const separator = passwordResetPageUrl.includes("?") ? "&" : "?";
	return `${passwordResetPageUrl}${separator}token=${normalizedToken}`;
}

export async function sendRegistrationEmail({ email, username, verificationToken }) {
	if (!transporterPromise) {
		throw createEmailSendError("EMAIL_USER or EMAIL_PASS is missing");
	}

	const transporter = await transporterPromise;
	if (!transporter || typeof transporter.sendMail !== "function") {
		throw createEmailSendError("Email transporter is unavailable");
	}

	const recipientEmail = typeof email === "string" ? email.trim() : String(email || "");
	const verificationLink = getVerificationLink(verificationToken);

	if (!verificationLink) {
		throw createEmailSendError("Verification link could not be generated");
	}

	const safeUsername = typeof username === "string" ? username.trim() : "";
	const normalizedSender = senderEmail.trim();
	const fromAddress = normalizedSender.length > 0
		? normalizedSender.includes("<") && normalizedSender.includes(">")
			? normalizedSender
			: `2v2 chess app <${normalizedSender}>`
		: smtpUser;
	const emailText = `Hi ${safeUsername}, your account has been created successfully.\n\nVerify your email by opening this link:\n${verificationLink}`;
	const emailHtml = `<p>Hi <strong>${safeUsername}</strong>, your account has been created successfully.</p><p>Please verify your email by opening this link:</p><p><a href="${verificationLink}">${verificationLink}</a></p>`;

	try {
		await transporter.sendMail({
			from: fromAddress,
			to: recipientEmail,
			subject: "Verify your email for 2v2 Chess",
			text: emailText,
			html: emailHtml,
		});
	} catch (error) {
		throw createEmailSendError("Failed to send verification email", error);
	}
}

export async function sendPasswordResetEmail({ email, username, resetToken }) {
	if (!transporterPromise) {
		throw createEmailSendError("EMAIL_USER or EMAIL_PASS is missing");
	}

	const transporter = await transporterPromise;
	if (!transporter || typeof transporter.sendMail !== "function") {
		throw createEmailSendError("Email transporter is unavailable");
	}

	const recipientEmail = typeof email === "string" ? email.trim() : String(email || "");
	const resetLink = getPasswordResetLink(resetToken);

	if (!resetLink) {
		throw createEmailSendError("Password reset link could not be generated");
	}

	const safeUsername = typeof username === "string" ? username.trim() : "";
	const greetingName = safeUsername || "player";
	const normalizedSender = senderEmail.trim();
	const fromAddress = normalizedSender.length > 0
		? normalizedSender.includes("<") && normalizedSender.includes(">")
			? normalizedSender
			: `2v2 chess app <${normalizedSender}>`
		: smtpUser;
	const emailText = `Hi ${greetingName},\n\nA password reset was requested for your 2v2 Chess account.\nOpen this link to set a new password:\n${resetLink}\n\nIf you did not request this, you can safely ignore this email.`;
	const emailHtml = `<p>Hi <strong>${greetingName}</strong>,</p><p>A password reset was requested for your 2v2 Chess account.</p><p>Open this link to set a new password:</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you did not request this, you can safely ignore this email.</p>`;

	try {
		await transporter.sendMail({
			from: fromAddress,
			to: recipientEmail,
			subject: "Reset your 2v2 Chess password",
			text: emailText,
			html: emailHtml,
		});
	} catch (error) {
		throw createEmailSendError("Failed to send password reset email", error);
	}
}
