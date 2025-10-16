// backend/routes/authRoutes.js - COMPLETE AND CORRECTED FILE (Debugging for handler error)

const express = require('express');
const router = express.Router();
const authMiddleware = require('..//middleware/authMiddleware'); 

// Import auth controller functions
const {
  registerUser,
  loginUser,
  getUserById,
  requestPasswordReset, 
  resetPassword,        
} = require('..//controllers/authController');

console.log('[authRoutes.js] Module loaded.'); // DEBUG
console.log('[authRoutes.js] Type of registerUser after import:', typeof registerUser); // DEBUG
console.log('[authRoutes.js] Type of loginUser after import:', typeof loginUser); // DEBUG
console.log('[authRoutes.js] Type of getUserById after import:', typeof getUserById); // DEBUG
console.log('[authRoutes.js] Type of requestPasswordReset after import:', typeof requestPasswordReset); // DEBUG - CRITICAL CHECK
console.log('[authRoutes.js] Type of resetPassword after import:', typeof resetPassword); // DEBUG - CRITICAL CHECK


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
