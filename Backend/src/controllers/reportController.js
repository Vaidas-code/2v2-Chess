import { createReport, getAllReports, markReportRead } from "../models/reportModel.js";

export async function postReport(req, res) {
	const actingUserId = req.auth?.id;
	const reportedUserId = typeof req.body?.reported_user_id === "string"
		? req.body.reported_user_id.trim().toLowerCase()
		: (typeof req.body?.reported_id === "string" ? req.body.reported_id.trim().toLowerCase() : "");
	const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

	if (!actingUserId) {
		return res.status(401).json({ ok: false, error: "Authentication required" });
	}

	if (!reportedUserId) {
		return res.status(400).json({ ok: false, error: "reported_user_id is required" });
	}

	if (!reason) {
		return res.status(400).json({ ok: false, error: "reason is required" });
	}

	try {
		const report = await createReport({
			user_id: actingUserId,
			reported_user_id: reportedUserId,
			reason,
		});
		return res.status(201).json({ ok: true, report });
	} catch (error) {
		console.error("Error creating report:", error);

		if (error?.code === "SELF_REPORT") {
			return res.status(400).json({ ok: false, error: error.message });
		}

		if (error?.code === "REASON_TOO_LONG") {
			return res.status(400).json({ ok: false, error: error.message });
		}

		return res.status(500).json({ ok: false, error: "Internal server error" });
	}
}

export async function getAdminReports(req, res) {
	const isAdmin = Array.isArray(req.auth?.roles) && req.auth.roles.includes("admin");
	if (!isAdmin) {
		return res.status(403).json({ ok: false, error: "Admin access required" });
	}

	try {
		const reports = await getAllReports();
		return res.status(200).json({ ok: true, reports });
	} catch (error) {
		console.error("Error fetching admin reports:", error);
		return res.status(500).json({ ok: false, error: "Internal server error" });
	}
}

export async function markReportReadHandler(req, res) {
	const isAdmin = Array.isArray(req.auth?.roles) && req.auth.roles.includes("admin");
	if (!isAdmin) {
		return res.status(403).json({ ok: false, error: "Admin access required" });
	}

	const reportId = req.params?.reportId;

	try {
		const result = await markReportRead(reportId);
		return res.status(200).json({ ok: true, report: result });
	} catch (error) {
		console.error("Error marking report read:", error);
		return res.status(500).json({ ok: false, error: "Internal server error" });
	}
}
