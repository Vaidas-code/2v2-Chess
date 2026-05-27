import { Router } from "express";
import authenticateAccessToken from "../config/middleware/authenticateAccessToken.js";
import { getTeamMemberReservesHandler } from "../controllers/playerReserveController.js";

const router = Router();

router.get("/team-members/:teamMemberId/reserves", authenticateAccessToken, getTeamMemberReservesHandler);

export default router;
