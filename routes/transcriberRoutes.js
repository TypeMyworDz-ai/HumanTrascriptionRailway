const express = require('express');
const authMiddleware = require('..//middleware/authMiddleware');
// IMPORTANT: Import all transcriber-specific controllers from transcriberController.js
const {
  submitTest,
  checkTestStatus,
  getTranscriberNegotiations,
  acceptNegotiation,
  counterNegotiation,
  rejectNegotiation
} = require('../controllers/transcriberController'); // NEW: Import all from transcriberController

module.exports = (io) => {
  const router = express.Router();

  // POST /api/transcriber/submit-test
  router.post('/submit-test', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can submit tests.' });
    }
    submitTest(req, res, next);
  });

  // GET /api/transcriber/status
  router.get('/status', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can check test status.' });
    }
    checkTestStatus(req, res, next);
  });

  // GET /api/transcriber/negotiations - Get transcriber's negotiations
  router.get('/negotiations', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can view their negotiations.' });
    }
    getTranscriberNegotiations(req, res, next); // io is not directly needed here as controller doesn't emit
  });

  // PUT /api/transcriber/negotiations/:negotiationId/accept
  router.put('/negotiations/:negotiationId/accept', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can accept negotiations.' });
    }
    acceptNegotiation(req, res, next, io);
  });

  // PUT /api/transcriber/negotiations/:negotiationId/counter
  router.put('/negotiations/:negotiationId/counter', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can counter negotiations.' });
    }
    counterNegotiation(req, res, next, io);
  });

  // PUT /api/transcriber/negotiations/:negotiationId/reject
  router.put('/negotiations/:negotiationId/reject', authMiddleware, (req, res, next) => {
    if (req.user.userType !== 'transcriber') {
      return res.status(403).json({ error: 'Access denied. Only transcribers can reject negotiations.' });
    }
    rejectNegotiation(req, res, next, io);
  });

  return router;
};
