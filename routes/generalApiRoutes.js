const express = require('express');
const router = express.Router();
const supabase = require('../database');
const authMiddleware = require('../middleware/authMiddleware');
const fs = require('fs');
const path = require('path');

// IMPORTANT: Import functions from negotiationController.js
const {
  uploadNegotiationFiles,
  uploadTempNegotiationFile,
  tempUploadNegotiationFile,
  getAvailableTranscribers,
  createNegotiation,
  getClientNegotiations,
  deleteNegotiation,
  acceptNegotiation,
  counterNegotiation,
  rejectNegotiation,
  clientAcceptCounter,
  clientRejectCounter,
  clientCounterBack,
  markJobCompleteByClient,
  // NEW: Assuming this function exists or will be added to negotiationController.js
  // For now, the logic is embedded directly in the route for clarity.
  // In a real application, you would move this into negotiationController.js
  markNegotiationJobCompleteByTranscriber
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
    deleteUser,
    getAdminSettings,
    updateAdminSettings,
    getAllJobsForAdmin,
    getJobByIdForAdmin,
    getAllDisputesForAdmin,
    getAdminUserId
} = require('../controllers/adminController');

// Import chat controller functions
const {
    getAdminDirectMessages,
    sendAdminDirectMessage,
    getUserDirectMessages,
    sendUserDirectMessage,
    getUnreadMessageCount,
    getAdminChatList,
    getJobMessages,
    sendJobMessage,
    uploadChatAttachment,
    handleChatAttachmentUpload
} = require('../controllers/chatController');

// NEW: Import payment controller functions
const {
    initializePayment,
    verifyPayment,
    getTranscriberPaymentHistory,
    getClientPaymentHistory,
    getAllPaymentHistoryForAdmin,
    initializeTrainingPayment,
    getTranscriberUpcomingPayoutsForAdmin,
    markPaymentAsPaidOut
} = require('../controllers/paymentController');

// NEW: Import rating controller functions
const {
    rateUserByAdmin,
    getTranscriberRatings,
    getClientRating
} = require('../controllers/ratingController');

// NEW: Import updateTranscriberProfile and syncAvailabilityStatus from transcriberController
const { updateTranscriberProfile, syncAvailabilityStatus } = require('../controllers/transcriberController');
// NEW: Import updateClientProfile from authController
const { updateClientProfile } = require('../controllers/authController');

// NEW: Import functions from directUploadController.js
const {
    createDirectUploadJob,
    getDirectUploadJobsForClient,
    getAvailableDirectUploadJobsForTranscriber,
    takeDirectUploadJob,
    completeDirectUploadJob,
    clientCompleteDirectUploadJob,
    getAllDirectUploadJobsForAdmin,
    handleQuoteCalculationRequest
} = require('../controllers/directUploadController');

// NEW: Import training controller functions
const {
    getTraineeTrainingStatus,
    getTrainingMaterials,
    createTrainingMaterial,
    updateTrainingMaterial,
    deleteTrainingMaterial,
    getTraineeTrainingRoomMessages,
    sendTraineeTrainingRoomMessage,
    uploadTrainingRoomAttachment,
    handleTrainingRoomAttachmentUpload,
    completeTraining
} = require('../controllers/trainingController');

// Import multer for direct use in this file for error handling
const multer = require('multer');

// --- Multer Error Handling Middleware ---
const multerErrorHandler = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('Multer Error Caught in Route Handler:', err.message, 'Code:', err.code);
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
    console.error('General File Upload Error Caught in Route Handler:', err.message);
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
  next(err);
};

// NEW: Multer configuration for Training Room attachments (allowing audio/video)
const trainingRoomFileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads/training_room_attachments';
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

const trainingRoomFileFilter = (req, file, cb) => {
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
        cb(new Error('Only audio, video, PDF, DOC, DOCX, TXT, and image files are allowed for training room attachments!'), false);
    }
};

const uploadTrainingRoomAttachmentMiddleware = multer({
    storage: trainingRoomFileStorage,
    fileFilter: trainingRoomFileFilter,
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB limit for training materials
    }
}).single('trainingRoomAttachment');


module.exports = (io) => {
  // --- CLIENT-SIDE NEGOTIATIONS ---
  router.get('/negotiations/client', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can view client negotiations.' });
    }
    getClientNegotiations(req, res, next);
  });

  // NEW: Transcriber endpoint to get all negotiations assigned to them
  router.get('/transcriber/negotiations', authMiddleware, async (req, res) => {
    const transcriberId = req.user.userId;
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can view their negotiations.' });
    }
    try {
      console.log(`[GET /transcriber/negotiations] Fetching negotiations for transcriberId: ${transcriberId}`);
      const { data: negotiations, error } = await supabase
        .from('negotiations')
        .select(`
          id,
          client_id,
          transcriber_id,
          requirements,
          negotiation_files,
          agreed_price_usd,
          deadline_hours,
          due_date,
          status,
          created_at,
          transcriber_response,
          client_response,
          completed_at,
          client_feedback_comment,
          client_feedback_rating,
          client_info:users!client_id(full_name, email, client_average_rating, client_completed_jobs)
        `)
        .eq('transcriber_id', transcriberId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error(`[GET /transcriber/negotiations] Supabase error:`, error);
        throw error;
      }
      console.log(`[GET /transcriber/negotiations] Found ${negotiations.length} negotiations for transcriberId ${transcriberId}.`);

      res.status(200).json({
        message: 'Transcriber negotiations retrieved successfully.',
        negotiations: negotiations
      });

    } catch (fetchError) {
      console.error('[GET /transcriber/negotiations] Error fetching transcriber negotiations:', fetchError);
      res.status(500).json({ error: 'Server error fetching transcriber negotiations.' });
    }
  });

  // NEW: Route to download negotiation files
  router.get('/negotiations/:negotiationId/download/:fileName', authMiddleware, async (req, res) => {
    const { negotiationId, fileName } = req.params;
    const userId = req.user.userId;
    const userType = req.user.userType;

    try {
      // 1. Verify user authorization for this file
      const { data: negotiation, error } = await supabase
        .from('negotiations')
        .select('client_id, transcriber_id, negotiation_files')
        .eq('id', negotiationId)
        .single();

      if (error || !negotiation) {
        console.error(`Download error: Negotiation ${negotiationId} not found or database error.`, error);
        return res.status(404).json({ error: 'Negotiation not found or file not associated.' });
      }

      // Check if the user is the client, the transcriber, or an admin
      const isAuthorized = (
        negotiation.client_id === userId ||
        negotiation.transcriber_id === userId ||
        userType === 'admin'
      );

      if (!isAuthorized) {
        return res.status(403).json({ error: 'Access denied. You are not authorized to download this file.' });
      }

      // 2. Construct the file path on the server
      const filePath = path.join(__dirname, '..', 'uploads', 'negotiation_files', fileName);

      // 3. Verify file exists on disk
      if (!fs.existsSync(filePath)) {
        console.error(`Download error: File not found on disk: ${filePath}`);
        return res.status(404).json({ error: 'File not found on server.' });
      }

      // 4. Send the file for download
      res.download(filePath, fileName, (err) => {
        if (err) {
          console.error(`Error sending file ${fileName} for download:`, err);
          res.status(500).json({ error: 'Failed to download file.' });
        }
      });

    } catch (downloadError) {
      console.error('Unexpected error during file download:', downloadError);
      res.status(500).json({ error: 'Server error during file download.' });
    }
  });


  // CORRECTED: Allow admins to delete negotiations as well
  router.delete('/negotiations/:negotiationId', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client' && req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only clients or admins can cancel/delete negotiations.' });
    }
    deleteNegotiation(req, res, io);
  });

  // NEW: Client marks a job as complete (for negotiation jobs)
  router.put('/negotiations/:negotiationId/complete', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can mark jobs as complete.' });
    }
    markJobCompleteByClient(req, res, io);
  });
  
  // NEW: Transcriber marks a negotiation job as complete (this is the endpoint TranscriberJobs.js calls)
  router.put('/transcriber/negotiations/:negotiationId/complete', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can mark their negotiation jobs as complete.' });
    }
    // Assuming a function in negotiationController.js or transcriberController.js handles this
    // For now, let's assume it's in negotiationController.js
    // You might need to adjust this if your actual backend structure is different.
    markNegotiationJobCompleteByTranscriber(req, res, io); 
  });


  // --- MESSAGING ROUTES (General) ---
  // RENAMED: Route for fetching job messages
  router.get('/messages/:jobId', authMiddleware, (req, res, next) => {
    getJobMessages(req, res, io);
  });

  // RENAMED: Route for sending job messages
  router.post('/messages/job/send', authMiddleware, (req, res, next) => {
    sendJobMessage(req, res, io);
  });

  // NEW: Chat Attachment Upload Route
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

  router.put(
    '/negotiations/:negotiationId/client/counter-back',
    authMiddleware,
    (req, res, next) => { // Custom middleware to check user type
      if (req.user.userType !== 'client') {
        // If not authorized, clean up any potential files uploaded by Multer before this point
        if (req.file) { // For single file upload
          fs.unlink(req.file.path, (err) => { if (err) console.error("Error deleting unauthorized temp file:", err); });
        }
        if (req.files && typeof req.files === 'object') { // For multiple files
          for (const key in req.files) {
            req.files[key].forEach(file => {
              fs.unlink(file.path, (err) => { if (err) console.error("Error deleting unauthorized temp file:", err); });
            });
          }
        }
        return res.status(403).json({ error: 'Access denied. Only clients can counter back.' });
      }
      next();
    },
    uploadNegotiationFiles, // Multer middleware
    (req, res, next) => { // Final handler
      clientCounterBack(req, res, io);
    },
    multerErrorHandler // Multer error handler
  );


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

  router.delete('/admin/users/:userId', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can delete users.' });
      }
      deleteUser(req, res, next);
  });

  router.get('/users/:userId', authMiddleware, (req, res, next) => {
      getAnyUserById(req, res, next);
  });

  // NEW: Route to get the ADMIN_USER_ID for frontend
  router.get('/admin/trainer-id', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only admins can access trainer ID.' });
    }
    next();
  }, getAdminUserId);


  // --- Admin Direct Chat Routes ---
  router.get('/admin/chat/messages/:userId', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can view chat history. ' });
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
    if (req.user.userType !== 'client' && req.user.userType !== 'trainee') {
      return res.status(403).json({ error: 'Access denied. Only clients or trainees can initiate payments.' });
    }
    initializePayment(req, res, io);
  });

  // NEW: Route for initializing training payment (this is now active)
  router.post('/payment/initialize-training', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'trainee') {
          return res.status(403).json({ error: 'Access denied. Only trainees can initiate training payments.' });
      }
      initializeTrainingPayment(req, res, io);
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
  
  // NEW: Admin route to get a specific transcriber's upcoming payouts
  router.get('/admin/transcriber/:transcriberId/upcoming-payouts', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only admins can view transcriber upcoming payouts.' });
    }
    getTranscriberUpcomingPayoutsForAdmin(req, res, io);
  });

  // NEW: Admin route to mark a payment as 'paid out'
  router.put('/admin/payments/:paymentId/mark-paid', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only admins can mark payments as paid out.' });
    }
    markPaymentAsPaidOut(req, res, io);
  });


  // --- NEW: Rating Routes ---
  router.post('/admin/ratings', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only admins can rate users.' });
    }
    rateUserByAdmin(req, res, next);
  });

  router.get('/ratings/transcriber/:transcriberId', authMiddleware, (req, res, next) => {
    getTranscriberRatings(req, res, next);
  });

  router.get('/ratings/client/:clientId', authMiddleware, (req, res, next) => {
    getClientRating(req, res, next);
  });

  // --- NEW: Direct Upload Job Routes ---
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
      fileSize: 500 * 1024 * 1024
    }
  }).fields([
      { name: 'audioVideoFile', maxCount: 1 },
      { name: 'instructionFiles', maxCount: 5 }
  ]);

  router.post('/direct-upload/job/quote', authMiddleware, uploadDirectFilesMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
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
    handleQuoteCalculationRequest(req, res, io);
  }, multerErrorHandler);

  router.post('/direct-upload/job', authMiddleware, uploadDirectFilesMiddleware, async (req, res, next) => {
    if (req.user.userType !== 'client') {
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
  }, multerErrorHandler);

  // NEW: Transcriber endpoint to get all direct upload jobs assigned to them (status 'taken')
  // This is used by TranscriberJobs.js to display active direct upload jobs
  router.get('/transcriber/direct-jobs', authMiddleware, async (req, res) => {
    const transcriberId = req.user.userId;
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can view their assigned direct upload jobs.' });
    }
    try {
      console.log(`[GET /transcriber/direct-jobs] Fetching active direct upload jobs for transcriberId: ${transcriberId}`);
      const { data: jobs, error } = await supabase
        .from('direct_upload_jobs')
        .select(`
          id,
          file_name,
          file_url,
          file_size_mb,
          audio_length_minutes,
          client_instructions,
          instruction_files,
          quote_amount,
          price_per_minute_usd,
          currency,
          agreed_deadline_hours,
          status,
          audio_quality_param,
          deadline_type_param,
          special_requirements,
          created_at,
          taken_at,
          transcriber_id,
          client_id,
          client:users!client_id(full_name, email, client_average_rating, client_completed_jobs)
        `)
        .eq('transcriber_id', transcriberId)
        .eq('status', 'taken')
        .order('created_at', { ascending: false });

      if (error) {
        console.error(`[GET /transcriber/direct-jobs] Supabase error:`, error);
        throw error;
      }
      console.log(`[GET /transcriber/direct-jobs] Found ${jobs.length} jobs for transcriberId ${transcriberId}. Jobs:`, jobs.map(j => ({ id: j.id, status: j.status, transcriber_id: j.transcriber_id, taken_at: j.taken_at })));

      res.status(200).json({
        message: 'Assigned direct upload jobs retrieved successfully.',
        jobs: jobs
      });

    } catch (fetchError) {
      console.error('[GET /transcriber/direct-jobs] Error fetching assigned direct upload jobs for transcriber:', fetchError);
      res.status(500).json({ error: 'Server error fetching assigned direct upload jobs.' });
    }
  });

  // NEW: Transcriber endpoint to get ALL direct upload jobs assigned to them (for Completed Jobs view)
  router.get('/transcriber/direct-jobs/all', authMiddleware, async (req, res) => {
    const transcriberId = req.user.userId;
    if (req.user.userType !== 'transcriber') {
        return res.status(403).json({ error: 'Access denied. Only transcribers can view their direct upload jobs.' });
    }
    try {
        console.log(`[GET /transcriber/direct-jobs/all] Fetching all direct upload jobs for transcriberId: ${transcriberId}`);
        const { data: jobs, error } = await supabase
            .from('direct_upload_jobs')
            .select(`
                id,
                file_name,
                file_url,
                file_size_mb,
                audio_length_minutes,
                client_instructions,
                instruction_files,
                quote_amount,
                price_per_minute_usd,
                currency,
                agreed_deadline_hours,
                status,
                audio_quality_param,
                deadline_type_param,
                special_requirements,
                created_at,
                taken_at,
                transcriber_id,
                client_id,
                client:users!client_id(id, full_name, email, client_average_rating, client_completed_jobs),
                transcriber:users!transcriber_id(id, full_name, email, transcriber_average_rating, transcriber_completed_jobs)
            `)
            .eq('transcriber_id', transcriberId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error(`[GET /transcriber/direct-jobs/all] Supabase error:`, error);
            throw error;
        }
        console.log(`[GET /transcriber/direct-jobs/all] Found ${jobs.length} jobs for transcriberId ${transcriberId}.`);

        res.status(200).json({
            message: 'All assigned direct upload jobs retrieved successfully.',
            jobs: jobs
        });

    } catch (fetchError) {
        console.error('[GET /transcriber/direct-jobs/all] Error fetching all assigned direct upload jobs for transcriber:', fetchError);
        res.status(500).json({ error: 'Server error fetching all assigned direct upload jobs.' });
    }
  });


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

  // NEW: Route to download direct upload files
  router.get('/direct-jobs/:jobId/download/:fileName', authMiddleware, async (req, res) => {
    const { jobId, fileName } = req.params;
    const userId = req.user.userId;
    const userType = req.user.userType;

    try {
      // 1. Verify user authorization for this file
      const { data: job, error } = await supabase
        .from('direct_upload_jobs')
        .select('client_id, transcriber_id, file_name, instruction_files')
        .eq('id', jobId)
        .single();

      if (error || !job) {
        console.error(`Download error: Direct upload job ${jobId} not found or database error.`, error);
        return res.status(404).json({ error: 'Direct upload job not found or file not associated.' });
      }

      // Check if the user is the client, the transcriber, or an admin
      const isAuthorized = (
        job.client_id === userId ||
        job.transcriber_id === userId ||
        userType === 'admin'
      );

      if (!isAuthorized) {
        return res.status(403).json({ error: 'Access denied. You are not authorized to download this file.' });
      }

      // 2. Determine if the file is the main audio/video file or an instruction file
      let filePath;
      if (job.file_name === fileName) {
        filePath = path.join(__dirname, '..', 'uploads', 'direct_upload_files', fileName);
      } else if (job.instruction_files && job.instruction_files.includes(fileName)) {
        filePath = path.join(__dirname, '..', 'uploads', 'direct_upload_files', fileName);
      } else {
        console.error(`Download error: File ${fileName} not found for job ${jobId}.`);
        return res.status(404).json({ error: 'File not found for this job.' });
      }

      // 3. Verify file exists on disk
      if (!fs.existsSync(filePath)) {
        console.error(`Download error: File not found on disk: ${filePath}`);
        return res.status(404).json({ error: 'File not found on server.' });
      }

      // 4. Send the file for download
      res.download(filePath, fileName, (err) => {
        if (err) {
          console.error(`Error sending file ${fileName} for download:`, err);
          res.status(500).json({ error: 'Failed to download file.' });
        }
      });

    } catch (downloadError) {
      console.error('Unexpected error during direct upload file download:', downloadError);
      res.status(500).json({ error: 'Server error during direct upload file download.' });
    }
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

  // NEW: Client marks a direct upload job as complete
  router.put('/client/direct-jobs/:jobId/complete', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'client') {
      return res.status(403).json({ error: 'Access denied. Only clients can mark direct upload jobs as complete.' });
    }
    clientCompleteDirectUploadJob(req, res, io);
  });

  router.get('/admin/direct-upload-jobs', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only admins can view all direct upload jobs.' });
    }
    getAllDirectUploadJobsForAdmin(req, res, io);
  });

  // --- NEW: Trainee Training Dashboard Routes ---
  router.get('/trainee/status', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'trainee' && req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only trainees or admins can view trainee status.' });
      }
      getTraineeTrainingStatus(req, res, next);
  });

  router.get('/trainee/materials', authMiddleware, (req, res, next) => {
      // UPDATED: Allow trainees, transcribers, and admins to view materials
      if (req.user.userType !== 'trainee' && req.user.userType !== 'admin' && req.user.userType !== 'transcriber') {
          return res.status(403).json({ error: 'Access denied. Only trainees, transcribers, or admins can view training materials.' });
      }
      getTrainingMaterials(req, res, next);
  });

  // NEW: Admin routes for managing training materials (Knowledge Base)
  router.post('/admin/training-materials', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can create training materials.' });
      }
      createTrainingMaterial(req, res, next);
  });

  router.put('/admin/training-materials/:materialId', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can update training materials.' });
      }
      updateTrainingMaterial(req, res, next);
  });

  router.delete('/admin/training-materials/:materialId', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can delete training materials.' });
      }
      deleteTrainingMaterial(req, res, next);
  });

  router.get('/trainee/training-room/messages/:chatId', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'trainee' && req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only trainees or admins can view training room messages.' });
      }
      getTraineeTrainingRoomMessages(req, res, io);
  });

  router.post('/trainee/training-room/send-message', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'trainee' && req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only trainees or admins can send training room messages.' });
      }
      sendTraineeTrainingRoomMessage(req, res, io);
  });

  // NEW: Training Room Attachment Upload Route
  router.post('/trainee/training-room/upload-attachment', authMiddleware, uploadTrainingRoomAttachmentMiddleware, handleTrainingRoomAttachmentUpload, multerErrorHandler);

  // NEW: Admin route to complete trainee training
  router.put('/admin/trainee/:traineeId/complete-training', authMiddleware, (req, res, next) => {
      if (req.user.userType !== 'admin') {
          return res.status(403).json({ error: 'Access denied. Only admins can complete trainee training.' });
      }
      completeTraining(req, res, next);
  });

  return router;
};
