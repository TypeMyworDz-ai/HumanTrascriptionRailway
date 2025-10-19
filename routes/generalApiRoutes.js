const express = require('express');
const router = express.Router();
const supabase = require('..//database');
const authMiddleware = require('..//middleware/authMiddleware');
const fs = require('fs');
const path = require('path');

// IMPORTANT: Import functions from negotiationController.js
const {
  uploadNegotiationFiles, // This is the Multer middleware for negotiation files (still used for clientCounterBack)
  uploadTempNegotiationFile, // NEW: Multer middleware for temporary negotiation file upload
  tempUploadNegotiationFile, // NEW: Controller for temporary negotiation file upload
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
    getAdminSettings,
    updateAdminSettings,
    getAllJobsForAdmin,
    getJobByIdForAdmin, // NEW: Import the new function
    getAllDisputesForAdmin,
} = require('..//controllers/adminController');

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
    uploadChatAttachment, // This is the Multer middleware for chat attachments
    handleChatAttachmentUpload // This is the controller function for chat attachments
} = require('..//controllers/chatController');

// NEW: Import payment controller functions
const {
    initializePayment,
    verifyPayment,
    getTranscriberPaymentHistory,
    getClientPaymentHistory,
    getAllPaymentHistoryForAdmin
} = require('..//controllers/paymentController');

// NEW: Import rating controller functions
const {
    rateTranscriber,
    rateClientByAdmin,
    getTranscriberRatings,
    getClientRating
} = require('..//controllers/ratingController');

// NEW: Import updateTranscriberProfile from transcriberController
const { updateTranscriberProfile } = require('..//controllers/transcriberController');
// NEW: Import updateClientProfile from authController
const { updateClientProfile } = require('..//controllers/authController');

// NEW: Import functions from directUploadController.js
const {
    uploadDirectFiles, // Multer middleware for direct uploads
    createDirectUploadJob,
    getDirectUploadJobsForClient,
    getAvailableDirectUploadJobsForTranscriber,
    takeDirectUploadJob,
    completeDirectUploadJob,
    getAllDirectUploadJobsForAdmin,
    handleQuoteCalculationRequest // NEW: Import the new controller for quote calculation
} = require('..//controllers/directUploadController');

// Import multer for direct use in this file for error handling
const multer = require('multer');

// --- Multer Error Handling Middleware ---
// This middleware will catch errors specifically thrown by Multer
const multerErrorHandler = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // Multer-specific errors (e.g., file size limit, unexpected field)
    console.error('Multer Error Caught in Route Handler:', err.message, 'Code:', err.code);
    // Clean up any partially uploaded files
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlink(req.file.path, (unlinkErr) => {
        if (unlinkErr) console.error("Error deleting Multer error temp file (req.file):", unlinkErr);
      });
    }
    if (req.files && typeof req.files === 'object') {
      for (const key in req.files) {
        req.files[key].forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlink(file.path, (unlinkErr) => {
              if (unlinkErr) console.error("Error deleting Multer error temp file (req.files):", unlinkErr);
            });
          }
        });
      }
    }
    return res.status(400).json({ error: err.message });
  } else if (err) {
    // General file upload errors (e.g., from a custom fileFilter that throws a non-MulterError)
    console.error('General File Upload Error Caught in Route Handler:', err.message);
    // Clean up any partially uploaded files
    if (req.file && fs.existsSync(req.file.path)) {
        fs.unlink(req.file.path, (unlinkErr) => {
          if (unlinkErr) console.error("Error deleting general file error temp file (req.file):", unlinkErr);
        });
      }
      if (req.files && typeof req.files === 'object') {
        for (const key in req.files) {
          req.files[key].forEach(file => {
            if (fs.existsSync(file.path)) {
              fs.unlink(file.path, (unlinkErr) => {
                if (unlinkErr) console.error("Error deleting general file error temp file (req.files):", unlinkErr);
              });
            }
          });
        }
      }
    return res.status(400).json({ error: err.message });
  }
  next(err); // Pass other errors (not related to Multer/file upload) to the next error handler
};

module.exports = (io) => {
  // --- CLIENT-SIDE NEGOTIATIONS ---
  router.get('/negotiations/client', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can view client negotiations.' });
    }
    getClientNegotiations(req, res, next);
  });

  // CORRECTED: Allow admins to delete negotiations as well
  router.delete('/negotiations/:negotiationId', authMiddleware, (req, res, next) => {
    // Allow both client and admin to delete negotiations
    if (req.user.userType !== 'client' && req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only clients or admins can cancel/delete negotiations.' });
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
  // Apply Multer middleware and then the controller function
  router.post('/chat/upload-attachment', authMiddleware, uploadChatAttachment, handleChatAttachmentUpload, multerErrorHandler);


  // --- TRANSCRIBER POOL ---
  router.get('/transcribers/available', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can browse transcribers.' });
    }
    getAvailableTranscribers(req, res, next);
  });

  // NEW: Temporary file upload route for negotiations
  router.post('/negotiations/temp-upload', authMiddleware, uploadTempNegotiationFile, tempUploadNegotiationFile, multerErrorHandler);

  // CRITICAL CHANGE: Negotiation creation no longer uses Multer middleware here, as file is pre-uploaded
  router.post('/negotiations/create', authMiddleware, (req, res, next) => {
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
    // CRITICAL CHANGE: Add Multer middleware for file upload here
    // Use uploadNegotiationFiles (from negotiationController) for file handling
    uploadNegotiationFiles(req, res, (multerErr) => {
      if (multerErr) {
        // If Multer error occurs, pass it to the multerErrorHandler
        return multerErrorHandler(multerErr, req, res, next);
      }
      // If no Multer error, proceed to the controller function
      clientCounterBack(req, res, io);
    });
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

  // --- NEW: Admin Jobs Routes ---
  // CORRECTED: Admin should be able to view all jobs
  router.get('/admin/jobs', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view all jobs.' });
      }
      getAllJobsForAdmin(req, res, io);
  });

  // NEW: Admin route to get details of a single job
  router.get('/admin/jobs/:jobId', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view job details.' });
      }
      getJobByIdForAdmin(req, res, next);
  });

  router.get('/admin/disputes/all', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view all disputes.' });
      }
      getAllDisputesForAdmin(req, res, io);
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
  // Multer setup for direct upload files (moved from directUploadController for direct use here)
  const directUploadFileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = 'uploads/direct_upload_files';
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
  });

  const directUploadFileFilter = (req, file, cb) => {
    const allowedTypes = [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/mp4', 'audio/m4a', 'audio/ogg',
      'video/mp4', 'video/webm', 'video/ogg',
      'application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio, video, PDF, DOC, DOCX, TXT, and image files are allowed for direct uploads!'), false);
    }
  };

  const uploadDirectFilesMiddleware = multer({
    storage: directUploadFileStorage,
    fileFilter: directUploadFileFilter,
    limits: {
      fileSize: 500 * 1024 * 1024 // 500MB limit
    }
  }).fields([
      { name: 'audioVideoFile', maxCount: 1 },
      { name: 'instructionFiles', maxCount: 5 }
  ]);

  // Route to get an instant quote for a direct upload job
  router.post('/direct-upload/job/quote', authMiddleware, uploadDirectFilesMiddleware, (req, res, next) => {
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
      return res.status(403).json({ error: 'Access denied. Only clients can get quotes for direct upload jobs.' });
    }
    handleQuoteCalculationRequest(req, res, io); // NEW: Call the dedicated controller function
  }, multerErrorHandler); // Apply Multer error handler

  router.post('/direct-upload/job', authMiddleware, uploadDirectFilesMiddleware, async (req, res, next) => {
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
  }, multerErrorHandler); // Apply Multer error handler here too


  router.get('/client/direct-jobs', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can view their direct upload jobs.' });
    }
    getDirectUploadJobsForClient(req, res, io);
  });

  router.get('/transcriber/direct-jobs/available', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can view available direct upload jobs.' });
    }
    getAvailableDirectUploadJobsForTranscriber(req, res, io);
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
