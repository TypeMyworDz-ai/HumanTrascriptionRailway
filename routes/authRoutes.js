// backend/routes/authRoutes.js - COMPLETE AND UPDATED with Forgot/Reset Password Routes

const express = require('express');
const router = express.Router();
const authMiddleware = require('..//middleware/authMiddleware'); // Assuming this path is correct

// Import auth controller functions - NEW: Import password reset functions
const {
  registerUser,
  loginUser,
  getUserById,
  requestPasswordReset, // NEW: Import requestPasswordReset
  resetPassword,        // NEW: Import resetPassword
} = require('..//controllers/authController');

// Register route
router.post('/register', registerUser);

// Login route
router.post('/login', loginUser);

// Get user by ID route (protected)
router.get('/user/:userId', authMiddleware, getUserById);

// NEW: Forgot Password Request route
router.post('/forgot-password', requestPasswordReset);

// NEW: Reset Password route
router.post('/reset-password', resetPassword);

module.exports = router;
