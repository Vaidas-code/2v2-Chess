import { Router } from "express";
import authenticateAccessToken from "../config/middleware/authenticateAccessToken.js";
import { getAdminReports, markReportReadHandler, postReport } from "../controllers/reportController.js";

const router = Router();

router.post("/reports", authenticateAccessToken, postReport);
router.get("/admin/reports", authenticateAccessToken, getAdminReports);
router.patch("/admin/reports/:reportId/read", authenticateAccessToken, markReportReadHandler);

export default router;
