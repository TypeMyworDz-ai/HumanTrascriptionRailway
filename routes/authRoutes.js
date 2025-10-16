// backend/routes/authRoutes.js - COMPLETE AND UPDATED (Final Fix for handler error)

const express = require('express');
const router = express.Router();
const authMiddleware = require('..//middleware/authMiddleware'); // Assuming this path is correct

// Import auth controller functions - FIXED: Ensure correct destructuring for new functions
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
router.post('/forgot-password', requestPasswordReset); // FIXED: Ensure requestPasswordReset is a function

// NEW: Reset Password route
router.post('/reset-password', resetPassword); // FIXED: Ensure resetPassword is a function

module.exports = router;
