import { Router } from "express";
import authenticateAccessToken from "../config/middleware/authenticateAccessToken.js";
import {
	acceptInboxInviteItem,
	getInboxItems,
	getInboxSummary,
	removeInboxItem,
	sendGameInviteToInbox,
} from "../controllers/inboxController.js";

const router = Router();

router.post("/inbox/invites", authenticateAccessToken, sendGameInviteToInbox);
router.get("/inbox/items", authenticateAccessToken, getInboxItems);
router.get("/inbox/summary", authenticateAccessToken, getInboxSummary);
router.post("/inbox/items/:inboxItemId/accept", authenticateAccessToken, acceptInboxInviteItem);
router.delete("/inbox/items/:inboxItemId", authenticateAccessToken, removeInboxItem);

export default router;
