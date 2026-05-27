import { Router } from "express";
import authenticateAccessToken from "../config/middleware/authenticateAccessToken.js";
import { getGameMoves, postBotMove, postGameTimeout, postMove } from "../controllers/moveController.js";

const router = Router();

router.post("/bot/moves", authenticateAccessToken, postBotMove);
router.post("/moves", authenticateAccessToken, postMove);
router.get("/games/:gameId/moves", authenticateAccessToken, getGameMoves);
router.post("/games/:gameId/timeout", authenticateAccessToken, postGameTimeout);

export default router;
