const express = require('express');
const { upload, uploadAudio } = require('../controllers/audioController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// POST /api/audio/upload
router.post('/upload', authMiddleware, upload, uploadAudio);

module.exports = router;
