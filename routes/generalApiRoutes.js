const express = require('express');
const router = express.Router();
const supabase = require('../database');
const authMiddleware = require('../middleware/authMiddleware');
const fs = require('fs');
const path = require('path');

// IMPORTANT: Import functions from negotiationController.js
const {
  uploadNegotiationFiles,
  getAvailableTranscribers,
  createNegotiation,
  getClientNegotiations,
  deleteNegotiation,
  syncAvailabilityStatus,
  acceptNegotiation,
  counterNegotiation,
  rejectNegotiation,
  clientAcceptCounter,
  clientRejectCounter,
  clientCounterBack
} = require('../controllers/negotiationController');

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
    getAdminSettings,
    updateAdminSettings,
    getAllJobsForAdmin,
    getAllDisputesForAdmin,
} = require('../controllers/adminController');

// Import chat controller functions
const {
    getAdminDirectMessages,
    sendAdminDirectMessage,
    getUserDirectMessages,
    sendUserDirectMessage,
    getUnreadMessageCount,
    getAdminChatList,
    getNegotiationMessages,
    sendNegotiationMessage,
    uploadChatAttachment, // Import the Multer middleware
    handleChatAttachmentUpload // Import the controller function
} = require('../controllers/chatController');

// NEW: Import payment controller functions
const {
    initializePayment,
    verifyPayment,
    getTranscriberPaymentHistory,
    getClientPaymentHistory,
    getAllPaymentHistoryForAdmin
} = require('../controllers/paymentController');

// NEW: Import rating controller functions
const {
    rateTranscriber,
    rateClientByAdmin,
    getTranscriberRatings,
    getClientRating
} = require('../controllers/ratingController');

// NEW: Import updateTranscriberProfile from transcriberController
const { updateTranscriberProfile } = require('../controllers/transcriberController');
// NEW: Import updateClientProfile from authController
const { updateClientProfile } = require('../controllers/authController');

// NEW: Import functions from directUploadController.js
const {
    uploadDirectFiles,
    createDirectUploadJob,
    getDirectUploadJobsForClient,
    getAvailableDirectUploadJobsForTranscriber,
    takeDirectUploadJob,
    completeDirectUploadJob,
    getAllDirectUploadJobsForAdmin
} = require('../controllers/directUploadController');

// Import multer for direct use in this file for error handling
const multer = require('multer');

module.exports = (io) => {
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
    deleteNegotiation(req, res, io);
  });

  // --- MESSAGING ROUTES (General) ---
  router.get('/messages/:negotiationId', authMiddleware, (req, res, next) => {
    getNegotiationMessages(req, res, io);
  });

  router.post('/messages/negotiation/send', authMiddleware, (req, res, next) => {
    sendNegotiationMessage(req, res, io);
  });

  // NEW: Chat Attachment Upload Route
  // Use uploadChatAttachment middleware from chatController, then handleChatAttachmentUpload
  router.post('/chat/upload-attachment', authMiddleware, uploadChatAttachment, handleChatAttachmentUpload);

  // CRITICAL FIX: Multer error handling middleware for file uploads
  router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      // Multer-specific errors
      console.error('Multer Error:', err.message);
      return res.status(400).json({ error: err.message });
    } else if (err) {
      // General file upload errors (e.g., from fileFilter)
      console.error('File Upload Error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    next(err); // Pass other errors to the next error handler
  });


  // --- TRANSCRIBER POOL ---
  router.get('/transcribers/available', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can browse transcribers.' });
    }
    getAvailableTranscribers(req, res, next);
  });

  // Configure multer for negotiation file uploads
  const uploadNegotiation = multer({
    storage: multer.diskStorage({
      destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '../uploads/negotiation_files'));
      },
      filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
      }
    }),
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
  });

  router.post('/negotiations/create', authMiddleware, uploadNegotiation.single('audioVideoFile'), async (req, res, next) => {
    if (req.user.userType !== 'client') {
      // Clean up uploaded file if an error occurs or access is denied
      if (req.file) {
        fs.unlink(req.file.path, (err) => {
          if (err) console.error("Error deleting temp file:", err);
        });
      }
      return res.status(403).json({ error: 'Access denied. Only clients can create negotiations.' });
    }
    createNegotiation(req, res, next, io);
  });

  // NEW: Transcriber Negotiation Actions
  router.put('/negotiations/:negotiationId/accept', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can accept negotiations.' });
    }
    acceptNegotiation(req, res, io);
  });

  router.put('/negotiations/:negotiationId/counter', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can counter negotiations.' });
    }
    counterNegotiation(req, res, io);
  });

  router.put('/negotiations/:negotiationId/reject', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can reject negotiations.' });
    }
    rejectNegotiation(req, res, io);
  });

  // NEW: Client Negotiation Counter-Offer Responses
  router.put('/negotiations/:negotiationId/client/accept-counter', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
        return res.status(403).json({ error: 'Access denied. Only clients can accept a counter-offer.' });
    }
    clientAcceptCounter(req, res, io);
  });

  router.put('/negotiations/:negotiationId/client/reject-counter', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
        return res.status(403).json({ error: 'Access denied. Only clients can reject a counter-offer.' });
    }
    clientRejectCounter(req, res, io);
  });

  router.put('/negotiations/:negotiationId/client/counter-back', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
        return res.status(403).json({ error: 'Access denied. Only clients can counter back.' });
    }
    clientCounterBack(req, res, io);
  });


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
        await syncAvailabilityStatus(userId, is_available, null);

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

  router.put('/transcriber-profile/:userId', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber' && req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only transcribers or admins can update transcriber profiles.' });
    }
    updateTranscriberProfile(req, res, next);
  });

  router.put('/client-profile/:userId', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client' && req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only clients or admins can update client profiles.' });
    }
    updateClientProfile(req, res, next);
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
      getAdminChatList(req, res, io);
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
    initializePayment(req, res, io);
  });

  router.get('/payment/verify/:reference', authMiddleware, (req, res, next) => {
    verifyPayment(req, res, io);
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
    getClientPaymentHistory(req, res, io);
  });

  // NEW: Admin Payment History Route
  router.get('/admin/payments', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only admins can view all payment history.' });
    }
    getAllPaymentHistoryForAdmin(req, res, io);
  });

  // --- NEW: Rating Routes ---
  router.post('/ratings/transcriber', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can rate transcribers.' });
    }
    rateTranscriber(req, res, next);
  });

  router.post('/ratings/client', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only admins can rate clients.' });
    }
    rateClientByAdmin(req, res, next);
  });

  router.get('/ratings/transcriber/:transcriberId', authMiddleware, (req, res, next) => {
    getTranscriberRatings(req, res, next);
  });

  router.get('/ratings/client/:clientId', authMiddleware, (req, res, next) => {
    getClientRating(req, res, next);
  });

  // --- NEW: Direct Upload Job Routes ---
  const uploadDirect = multer({
    storage: multer.diskStorage({
      destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '../uploads/direct_uploads'));
      },
      filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
      }
    }),
    // Add file filter or limits if needed
  });

  router.post('/direct-upload/job', authMiddleware, uploadDirect.fields([
    { name: 'audioVideoFile', maxCount: 1 },
    { name: 'instructionFiles', maxCount: 5 } // Assuming max 5 instruction files
  ]), async (req, res, next) => {
    if (req.user.userType !== 'client') {
      // Clean up uploaded files if access is denied
      if (req.files?.audioVideoFile?.[0]) {
        fs.unlink(req.files.audioVideoFile[0].path, (err) => { if (err) console.error("Error deleting temp audioVideoFile:", err); });
      }
      if (req.files?.instructionFiles?.length > 0) {
        req.files.instructionFiles.forEach(file => {
          fs.unlink(file.path, (err) => { if (err) console.error("Error deleting temp instructionFile:", err); });
        });
      }
      return res.status(403).json({ error: 'Access denied. Only clients can create direct upload jobs.' });
    }
    createDirectUploadJob(req, res, io);
  });

  router.get('/client/direct-jobs', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can view their direct upload jobs.' });
    }
    getDirectUploadJobsForClient(req, res, io);
  });

  router.put('/transcriber/direct-jobs/:jobId/take', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can take direct upload jobs.' });
    }
    takeDirectUploadJob(req, res, io);
  });

  router.put('/transcriber/direct-jobs/:jobId/complete', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can complete direct upload jobs.' });
    }
    completeDirectUploadJob(req, res, io);
  });

  // NEW: Admin Direct Upload Jobs History Route
  router.get('/admin/direct-upload-jobs', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only admins can view all direct upload jobs.' });
    }
    getAllDirectUploadJobsForAdmin(req, res, io);
  });


  return router;
};
