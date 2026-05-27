import { Router } from "express";
import {banUserHandler, changeSpecificUserPassword, completeFacebookLogin, completeGoogleLogin, confirmPasswordReset, deleteSpecificUser, getAdminUserDetailsHandler, getGoogleLoginConfig, getLeaderboard, getNavbarNotifications, getSpecificUser, getSpecificUserStatistics, loginUser, loginWithGoogleIdToken, logoutSession, patchUserRole, refreshSession, registerUser, requestPasswordReset, startFacebookLogin, startGoogleLogin, updateSpecificUser, verifyEmail} from "../controllers/authController.js";
import loginRateLimiter from "../config/middleware/loginRateLimiter.js";
import registerRateLimiter from "../config/middleware/registerRateLimiter.js";
import authenticateAccessToken from "../config/middleware/authenticateAccessToken.js";
import optionalAuthenticateAccessToken from "../config/middleware/optionalAuthenticateAccessToken.js";

const router = Router();

router.get("/auth/google/config", getGoogleLoginConfig);
router.get("/auth/google", startGoogleLogin);
router.post("/auth/google/id-token", loginRateLimiter, loginWithGoogleIdToken);
router.get("/auth/google/callback", completeGoogleLogin);
router.get("/auth/facebook", startFacebookLogin);
router.get("/auth/facebook/callback", completeFacebookLogin);
router.post("/users", registerRateLimiter, registerUser);
router.get("/users/:userId", getSpecificUser);
router.get("/users/:userId/stats", authenticateAccessToken, getSpecificUserStatistics);
router.get("/users/:userId/navbar-notifications", authenticateAccessToken, getNavbarNotifications);
router.get("/users/:userId/admin-details", authenticateAccessToken, getAdminUserDetailsHandler);
router.get("/leaderboards", optionalAuthenticateAccessToken, getLeaderboard);
router.patch("/users/:userId", updateSpecificUser);
router.patch("/users/:userId/role", authenticateAccessToken, patchUserRole);
router.patch("/users/:userId/ban", authenticateAccessToken, banUserHandler);
router.patch("/users/:userId/password", authenticateAccessToken, loginRateLimiter, changeSpecificUserPassword);
router.delete("/users/:userId", deleteSpecificUser);
router.post("/sessions", loginRateLimiter, loginUser);
router.post("/password-resets/request", loginRateLimiter, requestPasswordReset);
router.post("/password-resets/confirm", loginRateLimiter, confirmPasswordReset);
router.post("/sessions/refresh", refreshSession);
router.delete("/sessions", logoutSession);
router.get("/email-verifications/:token", verifyEmail);

export default router;
