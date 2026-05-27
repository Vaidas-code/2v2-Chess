import { Router } from "express";
import authenticateAccessToken from "../config/middleware/authenticateAccessToken.js";
import { getAllBotNamesHandler, joinBotTeamMemberHandler, joinTeamMemberHandler, leaveTeamMemberHandler, removeBotTeamMemberHandler } from "../controllers/teamMemberController.js";

const router = Router();

router.patch("/team-members/:teamMemberId/join", authenticateAccessToken, joinTeamMemberHandler);
router.patch("/team-members/:teamMemberId/leave", authenticateAccessToken, leaveTeamMemberHandler);
router.patch("/team-members/:teamMemberId/bot", authenticateAccessToken, joinBotTeamMemberHandler);
router.patch("/team-members/:teamMemberId/remove-bot", authenticateAccessToken, removeBotTeamMemberHandler);
router.get("/bots/names", authenticateAccessToken, getAllBotNamesHandler);

export default router;
