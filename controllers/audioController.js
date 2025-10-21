const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffprobe = require('node-ffprobe'); // For getting audio/video metadata
const supabase = require('..//database');
const emailService = require('..//emailService'); // For sending notifications
const util = require('util');

// Promisify fs.unlink for async file deletion
const unlinkAsync = util.promisify(fs.unlink);

// --- Multer Configuration for Audio Upload Files ---
const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Determine upload directory based on field name
    const uploadDir = file.fieldname === 'audio' ? 'uploads/audio' : 'uploads/instructions';
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Create a unique filename to prevent conflicts
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter to validate allowed file types based on fieldname
const fileFilter = (req, file, cb) => {
  if (file.fieldname === 'audio') {
    // Accept specific audio file types
    const allowedTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/mp4', 'audio/m4a', 'audio/ogg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed for the audio field!'), false);
    }
  } else if (file.fieldname === 'instructionFile') {
    // Accept document and image file types for instructions
    const allowedTypes = [
      'application/pdf',
      'application/msword', // .doc
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
      'text/plain',
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, DOCX, TXT, and image files are allowed for instructions!'), false);
    }
  } else {
    cb(new Error('Unknown file field!'), false); // Reject if fieldname is not recognized
  }
};

// Multer configuration for handling multiple file fields ('audio' and 'instructionFile')
const upload = multer({
  storage: audioStorage, // Use audioStorage for audio uploads
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit for audio files
  }
}).fields([
  { name: 'audio', maxCount: 1 }, // Main audio file
  { name: 'instructionFile', maxCount: 1 } // Additional instruction file
]);

// --- Helper Functions ---

// Calculate deadline based on audio duration and rush status
const calculateDeadline = (durationMinutes, isRush = false) => {
  const now = new Date();
  let hoursToComplete;
  
  if (isRush) {
    // Rush: 8 hours per audio hour, minimum 1 hour
    hoursToComplete = Math.ceil((durationMinutes / 60) * 8);
    hoursToComplete = Math.max(1, hoursToComplete);
  } else {
    // Normal: 24 hours per audio hour, minimum 2 hours
    hoursToComplete = Math.ceil((durationMinutes / 60) * 24);
    hoursToComplete = Math.max(2, hoursToComplete);
  }
  
  const completionDate = new Date(now.getTime() + (hoursToComplete * 60 * 60 * 1000));
  
  return {
    hoursToComplete,
    completionDate: completionDate.toISOString(),
    formattedDate: completionDate.toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  };
};

// Calculate price based on TypeMyworDz pricing structure
const calculatePrice = (durationMinutes, audioQuality, requirements, isRush = false) => {
  // Quality-based rates (per minute in USD)
  const qualityRates = {
    'poor': 0.60,
    'standard': 0.50,
    'good': 0.40,
    'excellent': 0.35
  };
  
  // Special rates
  const rushRate = 0.70;
  const specialRequirementsRate = 0.60; // Example rate for special requirements
  
  let ratePerMinute;
  let rateType;
  
  // Priority: Rush > Special Requirements > Quality-based
  if (isRush) {
    ratePerMinute = rushRate;
    rateType = 'Rush Job';
  } else if (requirements && requirements.trim() && !isOnlySpeakerTags(requirements)) {
    ratePerMinute = specialRequirementsRate;
    rateType = 'Special Requirements';
  } else {
    ratePerMinute = qualityRates[audioQuality] || qualityRates['standard'];
    rateType = `${audioQuality.charAt(0).toUpperCase() + audioQuality.slice(1)} Quality`;
  }
  
  const totalPrice = durationMinutes * ratePerMinute;
  
  return {
    ratePerMinute,
    rateType,
    totalPrice: Math.round(totalPrice * 100) / 100 // Round to 2 decimal places
  };
};

// Check if requirements only contain speaker tags (not special requirements)
const isOnlySpeakerTags = (requirements) => {
  const lowerReq = requirements.toLowerCase();
  const speakerKeywords = ['speaker tag', 'speaker tags', 'speaker identification', 'speaker id'];
  const specialKeywords = ['timestamp', 'verbatim', 'time stamp', 'word-for-word', 'exact', 'literal'];
  
  const hasSpeakerTags = speakerKeywords.some(keyword => lowerReq.includes(keyword));
  const hasSpecialReq = specialKeywords.some(keyword => lowerReq.includes(keyword));
  
  return hasSpeakerTags && !hasSpecialReq;
};

// Get actual audio duration using ffprobe, with a fallback to file size estimation
const getAudioDuration = async (filePath) => {
  try {
    const probeData = await ffprobe(filePath);
    const duration = parseFloat(probeData.format.duration);
    const durationMinutes = Math.ceil(duration / 60);
    return durationMinutes;
  } catch (error) {
    console.error('ffprobe failed:', error);
    // Fallback to file size estimation (very rough approximation)
    const stats = fs.statSync(filePath);
    return Math.max(1, Math.round(stats.size / (1024 * 1024 * 0.5))); // Assume 0.5MB/min
  }
};

// --- Controller Functions ---

// Upload audio and create job
const uploadAudio = async (req, res) => {
  const uploadedFilePaths = []; // To keep track of files for cleanup

  try {
    const { audioQuality, requirements, isRush } = req.body;
    const userId = req.user.userId;
    
    // Check if audio file was uploaded
    if (!req.files || !req.files.audio || !req.files.audio[0]) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }
    
    const audioFile = req.files.audio[0];
    const instructionFile = req.files.instructionFile ? req.files.instructionFile[0] : null;

    uploadedFilePaths.push(audioFile.path);
    if (instructionFile) uploadedFilePaths.push(instructionFile.path);

    // Check instruction file size (50MB limit)
    if (instructionFile && instructionFile.size > 50 * 1024 * 1024) {
      await Promise.all(uploadedFilePaths.map(p => unlinkAsync(p).catch(e => console.error("Error during cleanup:",e))));
      return res.status(400).json({ error: 'Instruction file must be smaller than 50MB' });
    }
    
    // Get audio duration
    const durationMinutes = await getAudioDuration(audioFile.path);
    
    // Calculate price
    const pricing = calculatePrice(durationMinutes, audioQuality, requirements, isRush === 'true');
    
    // Calculate deadline
    const deadline = calculateDeadline(durationMinutes, isRush === 'true');
    
    // Save job to database
    const jobData = {
      client_id: userId,
      filename: audioFile.filename,
      file_size: audioFile.size,
      duration_minutes: durationMinutes,
      audio_quality: audioQuality,
      requirements: requirements,
      calculated_price: pricing.totalPrice,
      status: 'uploaded', // Initial status
      deadline: deadline.completionDate,
      instruction_file: instructionFile ? instructionFile.filename : null // Store instruction file name if exists
    };
    
    const { data, error } = await supabase
      .from('audio_jobs')
      .insert([jobData])
      .select();
    
    if (error) {
      await Promise.all(uploadedFilePaths.map(p => unlinkAsync(p).catch(e => console.error("Error during cleanup:",e)))); // Clean up files on DB error
      throw error;
    }
    
    res.status(201).json({
      message: 'Audio uploaded successfully',
      job: data[0],
      pricing: {
        duration_minutes: durationMinutes,
        rate_per_minute: pricing.ratePerMinute,
        rate_type: pricing.rateType,
        audio_quality: audioQuality,
        total_price: pricing.totalPrice,
        currency: 'USD'
      },
      deadline: {
        estimated_completion: deadline.formattedDate,
        expected_delivery: `Within ${deadline.hoursToComplete} hours`,
        completion_date: deadline.completionDate
      },
      instruction_file: instructionFile ? {
        filename: instructionFile.filename,
        size: instructionFile.size
      } : null
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    // Ensure all uploaded files are cleaned up if any error occurs
    await Promise.all(uploadedFilePaths.map(p => unlinkAsync(p).catch(e => console.error("Error during final cleanup:",e))));
    res.status(500).json({ error: error.message || 'Failed to upload audio due to server error.' });
  }
};

module.exports = {
  upload, // Export the Multer instance
  uploadAudio // Export the controller function
};
