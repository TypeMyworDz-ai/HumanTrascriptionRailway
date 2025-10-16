const express = require('express');
const { registerUser, loginUser, getUserById } = require('../controllers/authController');
const authMiddleware = require('..//middleware/authMiddleware'); // Import authMiddleware

const router = express.Router();

// POST /api/auth/register
router.post('/register', registerUser);

// POST /api/auth/login
router.post('/login', loginUser);

// GET /api/auth/user/:userId - Get user by ID (protected route)
router.get('/user/:userId', authMiddleware, async (req, res, next) => {
  // IMPORTANT: Ensure the user requesting info is either the target user or an admin
  if (req.user.userId !== req.params.userId) {
    // You might add an admin role check here later: || req.user.userType !== 'admin'
    return res.status(403).json({ error: 'Access denied. You can only view your own user data.' });
  }
  // CRITICAL: Call getUserById, which is now updated to fetch from profile tables
  getUserById(req, res, next);
});

module.exports = router;
