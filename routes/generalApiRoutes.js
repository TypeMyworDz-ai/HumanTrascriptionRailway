// backend/routes/generalApiRoutes.js - COMPLETE AND FULLY CORRECTED FILE

const express = require('express');
const router = express.Router();
const supabase = require('..//database');
const authMiddleware = require('..//middleware/authMiddleware'); 
const fs = require('fs');

// IMPORTANT: Import functions from negotiationController.js
const {
  uploadNegotiationFiles,
  getAvailableTranscribers,
  createNegotiation,
  getClientNegotiations,
  deleteNegotiation,
  syncAvailabilityStatus 
} = require('..//controllers/negotiationController'); 

// Import admin controller functions
const {
    getPendingTranscriberTestsCount,
    getActiveJobsCount,
    getOpenDisputesCount,
    getTotalUsersCount,
    getAllTranscriberTestSubmissions,
    getTranscriberTestSubmissionById,
    getAllUsersForAdmin,
    getUserByIdForAdmin,
    getAnyUserById,
    approveTranscriberTest,
    rejectTranscriberTest,
} = require('..//controllers/adminController'); 

// Import chat controller functions (including the new ones)
const {
    getAdminDirectMessages,
    sendAdminDirectMessage,
    getUserDirectMessages,
    sendUserDirectMessage,
    getUnreadMessageCount, 
    getAdminChatList,
    getNegotiationMessages, // NEW: Import the negotiation message getter
    sendNegotiationMessage // NEW: Import the negotiation message sender
} = require('..//controllers/chatController'); 


module.exports = (io) => {
    // Socket.IO Connection Handling
    io.on('connection', (socket) => {
        console.log('A user connected via WebSocket:', socket.id);

        // Listen for 'joinUserRoom' (camelCase) as standardized in ChatService.js
        socket.on('joinUserRoom', (userId) => {
            if (userId) {
                socket.join(userId);
                console.log(`Socket ${socket.id} joined room for user ${userId}`);
            } else {
                console.warn(`Attempted to join user room without a userId from socket ${socket.id}`);
            }
        });

        // The 'sendMessage' event is now handled by HTTP routes that call chatController functions.
        // This ensures authentication middleware and consistent logic.
        
        socket.on('disconnect', () => {
            console.log('User disconnected from WebSocket:', socket.id);
        });
    });


  // --- CLIENT-SIDE NEGOTIATIONS ---
  router.get('/negotiations/client', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can view client negotiations.' });
    }
    getClientNegotiations(req, res, next);
  });

  router.delete('/negotiations/:negotiationId', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can cancel negotiations.' });
    }
    deleteNegotiation(req, res, next, io);
  });

  // --- MESSAGING ROUTES (General) ---
  // FIXED: This route now uses the new getNegotiationMessages from chatController
  router.get('/messages/:negotiationId', authMiddleware, (req, res, next) => {
    // This endpoint now specifically fetches messages for a negotiation.
    // The chatController function handles validation and fetching.
    getNegotiationMessages(req, res, io); // Pass 'io' if controller needs to emit
  });

  // NEW: Route for sending messages within a negotiation
  router.post('/messages/negotiation/send', authMiddleware, (req, res, next) => {
    // This endpoint handles sending messages for a specific negotiation.
    // The chatController function handles validation, saving, and emitting.
    sendNegotiationMessage(req, res, io);
  });


  // --- TRANSCRIBER POOL ---
  router.get('/transcribers/available', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can browse transcribers.' });
    }
    getAvailableTranscribers(req, res, next);
  });

  router.post('/negotiations/create', authMiddleware, uploadNegotiationFiles, async (req, res, next) => {
    if (req.user.userType !== 'client') {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Access denied. Only clients can create negotiations.' });
    }
    createNegotiation(req, res, next, io);
  });

  // FIXED: Update transcriber's online status - Now updates users table
  router.put('/users/:userId/online-status', authMiddleware, async (req, res) => {
    if (req.user.userType !== 'transcriber' && req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only transcribers or admins can update online status.' });
    }
    const { userId } = req.params;
    const { is_online } = req.body;
    const currentUserId = req.user.userId;

    if (userId !== currentUserId && req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized to update this user\'s status.' });
    }

    try {
      // FIXED: Update users table instead of transcribers table
      const { data, error } = await supabase
        .from('users')
        .update({ is_online, updated_at: new Date().toISOString() })
        .eq('id', userId)
        .select('id, is_online, is_available')
        .single();

      if (error) {
        console.error("Supabase error updating online status:", error);
        return res.status(500).json({ error: error.message });
      }
      if (!data) {
        return res.status(404).json({ error: 'User not found.' });
      }
      res.json({ message: 'Online status updated successfully', user: data });
    } catch (err) {
      console.error("Server error updating online status:", err);
      res.status(500).json({ error: 'Server error updating online status' });
    }
  });

  // FIXED: Update transcriber's availability status - Now updates users table
  router.put('/users/:userId/availability-status', authMiddleware, async (req, res) => {
    if (req.user.userType !== 'transcriber' && req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only transcribers or admins can update availability status.' });
    }
    const { userId } = req.params;
    const { is_available } = req.body;
    const currentUserId = req.user.userId;

    if (userId !== currentUserId && req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized to update this user\'s status.' });
    }

    try {
      // FIXED: Update users table instead of transcribers table
      const { data, error } = await supabase
        .from('users')
        .update({ is_available, updated_at: new Date().toISOString() })
        .eq('id', userId)
        .select('id, is_online, is_available')
        .single();

      if (error) {
        console.error("Supabase error updating availability status:", error);
        return res.status(500).json({ error: error.message });
      }
      if (!data) {
        return res.status(404).json({ error: 'User not found.' });
      }
      res.json({ message: 'Availability status updated successfully', user: data });
    } catch (err) {
      console.error("Server error updating availability status:", err);
      res.status(500).json({ error: 'Server error updating availability status' });
    }
  });

  // --- Admin Statistics Routes (Existing) ---
  router.get('/admin/stats/pending-tests', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view this statistic.' });
      }
      getPendingTranscriberTestsCount(req, res, next);
  });

  router.get('/admin/stats/active-jobs', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view this statistic.' });
      }
      getActiveJobsCount(req, res, next);
  });

  router.get('/admin/stats/disputes', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view this statistic.' });
      }
      getOpenDisputesCount(req, res, next);
  });

  router.get('/admin/stats/total-users', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view this statistic.' });
      }
      getTotalUsersCount(req, res, next);
  });

  // Admin Transcriber Test Management Routes
  router.get('/admin/transcriber-tests', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view transcriber tests.' });
      }
      getAllTranscriberTestSubmissions(req, res, next);
  });

  // Route to get a single transcriber test submission by ID
  router.get('/admin/transcriber-tests/:submissionId', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view transcriber test details.' });
      }
      getTranscriberTestSubmissionById(req, res, next);
  });

  router.put('/admin/transcriber-tests/:submissionId/approve', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can approve transcriber tests.' });
      }
      approveTranscriberTest(req, res, next);
  });

  router.put('/admin/transcriber-tests/:submissionId/reject', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can reject transcriber tests.' });
      }
      rejectTranscriberTest(req, res, next);
  });

  // Admin User Management Routes
  router.get('/admin/users', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can manage users.' });
      }
      getAllUsersForAdmin(req, res, next);
  });

  // Route to get a single user by ID for admin chat
  router.get('/admin/users/:userId', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view user details.' });
      }
      getUserByIdForAdmin(req, res, next);
  });

  // Generic User Details Route (accessible to any authenticated user)
  router.get('/users/:userId', authMiddleware, (req, res, next) => {
      // This route is for any authenticated user to fetch basic details of another user for display purposes (e.g., chat partner name).
      // The `authMiddleware` ensures the user is logged in.
      getAnyUserById(req, res, next);
  });

  // Admin Direct Chat Routes
  router.get('/admin/chat/messages/:userId', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view chat history.' });
      }
      getAdminDirectMessages(req, res, io); // Pass 'io' here
  });

  router.post('/admin/chat/send-message', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can send messages.' });
      }
      sendAdminDirectMessage(req, res, io);
  });

  // User Direct Chat Routes (for clients and transcribers to chat with admin)
  router.get('/user/chat/messages/:chatId', authMiddleware, (req, res, next) => {
      // This route is for any authenticated user (client or transcriber) to view their direct chat history with 'chatId'.
      // The `chatController` logic will ensure only relevant messages are returned.
      // The authMiddleware ensures the user is authenticated.
      getUserDirectMessages(req, res, io); // Pass 'io' to getUserDirectMessages
  });

  router.post('/user/chat/send-message', authMiddleware, (req, res, next) => {
      if (req.user.userType === 'admin') { 
          return res.status(403).json({ error: 'Admins should use their dedicated message sending route.' });
      }
      sendUserDirectMessage(req, res, io);
  });

  // Route to get unread message count for a user
  router.get('/user/chat/unread-count', authMiddleware, (req, res, next) => {
      // Allow any authenticated user to get their own unread message count
      getUnreadMessageCount(req, res, next);
  });

  // NEW: Admin Chat List Route
  router.get('/admin/chat/list', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view the chat list.' });
      }
      getAdminChatList(req, res, next);
  });

  return router;
};
