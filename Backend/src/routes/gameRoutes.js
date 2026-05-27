import { Router, text as parseText } from "express";
import authenticateAccessToken from "../config/middleware/authenticateAccessToken.js";
import { offerDrawHandler, offerForfeitHandler } from "../controllers/gameOfferController.js";
import {
	cancelLobbyGameOnLeaveBeacon,
	cancelLobbyGame,
	getGameById,
	getGameInviteLink,
	getInvitedGame,
	getPublicGames,
	getGameStatsHandler,
	getSpectatorGamesHandler,
	heartbeatLobbyPresenceForGame,
	leaveLobbyPresenceForGame,
	getMyActiveGame,
	populateRematch,
	setGameFinished,
	setGameStarted,
	startGame,
	updateLobbyGameName,
	updateLobbyGameSettings,
	updateLobbyTeamName,
} from "../controllers/gameController.js";

const router = Router();

router.get("/stats", getGameStatsHandler);
router.get("/games/spectate", getSpectatorGamesHandler);
router.post("/games", authenticateAccessToken, startGame);
router.get("/games/public", authenticateAccessToken, getPublicGames);
router.get("/games/active/me", authenticateAccessToken, getMyActiveGame);
router.get("/games/:gameId", authenticateAccessToken, getGameById);
router.post("/games/:gameId/lobby/beacon", parseText({ type: "*/*", limit: "10kb" }), cancelLobbyGameOnLeaveBeacon);
router.post("/games/:gameId/lobby/presence", authenticateAccessToken, heartbeatLobbyPresenceForGame);
router.delete("/games/:gameId/lobby/presence", authenticateAccessToken, leaveLobbyPresenceForGame);
router.delete("/games/:gameId/lobby", authenticateAccessToken, cancelLobbyGame);
router.patch("/games/:gameId/name", authenticateAccessToken, updateLobbyGameName);
router.patch("/games/:gameId/settings", authenticateAccessToken, updateLobbyGameSettings);
router.patch("/games/:gameId/teams/:teamId/name", authenticateAccessToken, updateLobbyTeamName);
router.get("/invite/:inviteToken", authenticateAccessToken, getInvitedGame);
router.get("/games/:gameId/invite-link", authenticateAccessToken, getGameInviteLink);
router.patch("/games/offers/draw", authenticateAccessToken, offerDrawHandler);
router.patch("/games/offers/forfeit", authenticateAccessToken, offerForfeitHandler);
router.patch("/games/:gameId/start", authenticateAccessToken, setGameStarted);
router.patch("/games/:gameId/finish", authenticateAccessToken, setGameFinished);
router.post("/games/:gameId/populate-rematch", authenticateAccessToken, populateRematch);

export default router;
