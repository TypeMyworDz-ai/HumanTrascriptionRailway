const express = require('express');
const router = express.Router();
const supabase = require('../database');
const authMiddleware = require('../middleware/authMiddleware');
const fs = require('fs');

// IMPORTANT: Import functions from negotiationController.js
const {
  uploadNegotiationFiles,
  getAvailableTranscribers,
  createNegotiation,
  getClientNegotiations,
  deleteNegotiation,
  syncAvailabilityStatus,
} = require('../controllers/negotiationController');

// Import admin controller functions - NEW: Import settings, jobs, and disputes functions
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
    getAdminSettings,
    updateAdminSettings,
    getAllJobsForAdmin,
    getAllDisputesForAdmin,
} = require('../controllers/adminController');

// Import chat controller functions (including the new ones)
const {
    getAdminDirectMessages,
    sendAdminDirectMessage,
    getUserDirectMessages,
    sendUserDirectMessage,
    getUnreadMessageCount,
    getAdminChatList,
    getNegotiationMessages,
    sendNegotiationMessage
} = require('../controllers/chatController');

// NEW: Import payment controller functions
const {
    initializePayment,
    verifyPayment,
    getTranscriberPaymentHistory,
    getClientPaymentHistory // NEW: Import client payment history function
} = require('../controllers/paymentController');

module.exports = (io) => {
    // Socket.IO Connection Handling (This listener is primarily for room joining now)
    io.on('connection', (socket) => {
        socket.on('joinUserRoom', (userId) => {
            if (userId) {
                socket.join(userId);
                console.log(`Socket ${socket.id} joined room for user ${userId}`);
            } else {
                console.warn(`Attempted to join user room without a userId from socket ${socket.id}`);
            }
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
  router.get('/messages/:negotiationId', authMiddleware, (req, res, next) => {
    getNegotiationMessages(req, res, io);
  });

  router.post('/messages/negotiation/send', authMiddleware, (req, res, next) => {
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

  // Update user's availability status (still needed for manual toggle)
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
        // FIXED: Use syncAvailabilityStatus from negotiationController
        await syncAvailabilityStatus(userId, is_available, null); // current_job_id is null for simple availability toggle

        // Fetch updated status to return
        const { data, error } = await supabase
            .from('users')
            .select('id, is_online, is_available, current_job_id')
            .eq('id', userId)
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

  // --- Admin Statistics Routes ---
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

  // --- Admin Transcriber Test Management Routes ---
  router.get('/admin/transcriber-tests', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view transcriber tests.' });
      }
      getAllTranscriberTestSubmissions(req, res, next);
  });

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

  // --- Admin User Management Routes ---
  router.get('/admin/users', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can manage users.' });
      }
      getAllUsersForAdmin(req, res, next);
  });

  router.get('/admin/users/:userId', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view user details.' });
      }
      getUserByIdForAdmin(req, res, next);
  });

  router.get('/users/:userId', authMiddleware, (req, res, next) => {
      getAnyUserById(req, res, next);
  });

  // --- Admin Direct Chat Routes ---
  router.get('/admin/chat/messages/:userId', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view chat history.' });
      }
      getAdminDirectMessages(req, res, io);
  });

  router.post('/admin/chat/send-message', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can send messages.' });
      }
      sendAdminDirectMessage(req, res, io);
  });

  // --- User Direct Chat Routes ---
  router.get('/user/chat/messages/:chatId', authMiddleware, (req, res, next) => {
      getUserDirectMessages(req, res, io);
  });

  router.post('/user/chat/send-message', authMiddleware, (req, res, next) => {
      if (req.user.userType === 'admin') {
          return res.status(403).json({ error: 'Admins should use their dedicated message sending route.' });
      }
      sendUserDirectMessage(req, res, io);
  });

  router.get('/user/chat/unread-count', authMiddleware, (req, res, next) => {
      getUnreadMessageCount(req, res, next);
  });

  router.get('/admin/chat/list', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view the chat list.' });
      }
      getAdminChatList(req, res, next);
  });

  // --- NEW: Admin Global Settings Routes ---
  router.get('/admin/settings', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view settings.' });
      }
      getAdminSettings(req, res, next);
  });

  router.put('/admin/settings', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can update settings.' });
      }
      updateAdminSettings(req, res, next);
  });

  // --- NEW: Admin Jobs Route ---
  router.get('/admin/jobs', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view all jobs.' });
      }
      getAllJobsForAdmin(req, res, next);
  });

  // --- NEW: Admin Disputes Route ---
  router.get('/admin/disputes/all', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view all disputes.' });
      }
      getAllDisputesForAdmin(req, res, next);
  });

  // --- NEW: Paystack Payment Routes ---
  router.post('/payment/initialize', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can initiate payments.' });
    }
    initializePayment(req, res, io); // Pass io for real-time updates
  });

  router.get('/payment/verify/:reference', authMiddleware, (req, res, next) => {
    // Both client (after redirect) and potentially admin might need to verify
    // For simplicity, allow any authenticated user to hit this for now,
    // but the verification logic in controller ensures negotiation ownership/relevance.
    verifyPayment(req, res, io); // Pass io for real-time updates
  });

  // --- NEW: Transcriber Payment History Route ---
  router.get('/transcriber/payments', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can view their payment history.' });
    }
    getTranscriberPaymentHistory(req, res, next);
  });

  // NEW: Client Payment History Route
  router.get('/client/payments', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can view their payment history.' });
    }
    getClientPaymentHistory(req, res, next);
  });

  return router;
};
