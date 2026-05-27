import { Router } from "express";
import authenticateAccessToken from "../config/middleware/authenticateAccessToken.js";
import { postChatMessage, getChatMessages, getTeamChatMessages } from "../controllers/chatController.js";

const router = Router();

router.post("/game-chats", authenticateAccessToken, postChatMessage);
router.get("/games/:gameId/chats", authenticateAccessToken, getChatMessages);
router.get("/teams/:teamId/chats", authenticateAccessToken, getTeamChatMessages);

export default router;
