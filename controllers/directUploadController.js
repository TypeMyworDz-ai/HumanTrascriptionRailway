// backend/controllers/directUploadController.js - CONFIRMED AND UPDATED for 4-star and 5-star transcribers

const supabase = require('../supabaseClient'); // Changed from '../database' to '../supabaseClient' based on previous context
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { syncAvailabilityStatus } = require('./transcriberController'); // For marking transcriber busy/available
const emailService = require('../emailService'); // For sending job notifications
const util = require('util'); // For promisify fs.unlink
const { getAudioDurationInSeconds } = require('get-audio-duration'); // Need to install this package

// Promisify fs.unlink for async/await use
const unlinkAsync = util.promisify(fs.unlink);

// --- Multer Configuration for Direct Upload Files ---
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
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif'
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only audio, video, PDF, DOC, DOCX, TXT, and image files are allowed for direct uploads!'), false);
  }
};

const uploadDirectFiles = multer({
  storage: directUploadFileStorage,
  fileFilter: directUploadFileFilter,
  limits: {
    fileSize: 200 * 1024 * 1024 // 200MB limit for direct upload files
  }
}).fields([
    { name: 'audioVideoFile', maxCount: 1 },
    { name: 'instructionFiles', maxCount: 5 } // For additional instruction files
]);


// --- Quote Calculation Helper ---
const calculateQuote = async (audioLengthMinutes, qualityParam, deadlineParam, specialRequirements) => {
    // Fetch base pricing from admin settings
    const { data: adminSettings, error: settingsError } = await supabase
        .from('admin_settings')
        .select('default_price_per_minute, default_deadline_hours')
        .single();

    if (settingsError || !adminSettings) {
        console.error("Error fetching admin settings for quote calculation:", settingsError);
        throw new Error("Pricing settings not found.");
    }

    let pricePerMinute = adminSettings.default_price_per_minute;
    let deadlineMultiplier = 1; // Default
    let qualityMultiplier = 1; // Default
    let specialReqMultiplier = 1; // Default

    // Adjust based on quality
    if (qualityParam === 'premium') {
        qualityMultiplier = 1.5; // 50% more for premium
    } else if (qualityParam === 'basic') {
        qualityMultiplier = 0.8; // 20% less for basic
    }

    // Adjust based on deadline (e.g., rush delivery costs more)
    if (deadlineParam === 'rush') {
        deadlineMultiplier = 1.5; // 50% more for rush
    } else if (deadlineParam === 'extended') {
        deadlineMultiplier = 0.8; // 20% less for extended
    }

    // Adjust for special requirements (example: 10% per special req)
    if (specialRequirements && specialRequirements.length > 0) {
        specialReqMultiplier = 1 + (specialRequirements.length * 0.1);
    }

    const finalPricePerMinute = pricePerMinute * qualityMultiplier * deadlineMultiplier * specialReqMultiplier;
    const quote = parseFloat((audioLengthMinutes * finalPricePerMinute).toFixed(2));

    // Determine suggested deadline based on audio length and chosen deadline parameter
    let suggestedDeadlineHours = adminSettings.default_deadline_hours;
    if (deadlineParam === 'rush') {
        suggestedDeadlineHours = Math.max(2, Math.round(audioLengthMinutes / 30)); // e.g., 30 min audio = 1 hr, min 2 hrs
    } else if (deadlineParam === 'normal') {
        suggestedDeadlineHours = Math.max(6, Math.round(audioLengthMinutes / 15)); // e.g., 30 min audio = 2 hr, min 6 hrs
    } else if (deadlineParam === 'extended') {
        suggestedDeadlineHours = Math.min(168, Math.max(24, Math.round(audioLengthMinutes / 5))); // e.g., 30 min audio = 6 hr, min 24 hrs, max 1 week
    }
    // Cap suggested deadline to a reasonable max if needed
    suggestedDeadlineHours = Math.min(suggestedDeadlineHours, 168); // Max 1 week

    return { quote, agreed_deadline_hours: suggestedDeadlineHours };
};


// --- Controller Functions ---

// Client uploads files and creates a direct job request
const createDirectUploadJob = async (req, res, io) => {
    const clientId = req.user.userId;
    const {
        clientInstructions,
        qualityParam,
        deadlineParam,
        specialRequirements // This will be an array of strings
    } = req.body;

    let audioVideoFile = req.files?.audioVideoFile?.[0];
    let instructionFiles = req.files?.instructionFiles || [];

    if (!audioVideoFile) {
        // If main file is missing, delete any attached instruction files
        if (instructionFiles.length > 0) {
            await Promise.all(instructionFiles.map(file => unlinkAsync(file.path)));
        }
        return res.status(400).json({ error: 'Main audio/video file is required.' });
    }

    try {
        // 1. Get audio/video duration
        const audioVideoFilePath = path.join(__dirname, '..', '..', audioVideoFile.path);
        const audioLengthSeconds = await getAudioDurationInSeconds(audioVideoFilePath);
        const audioLengthMinutes = audioLengthSeconds / 60;

        // 2. Calculate quote and deadline
        const { quote, agreed_deadline_hours } = await calculateQuote(
            audioLengthMinutes,
            qualityParam,
            deadlineParam,
            specialRequirements ? JSON.parse(specialRequirements) : []
        );

        // 3. Prepare instruction file names (if any)
        const instructionFileNames = instructionFiles.map(file => file.filename).join(',');

        // 4. Create the direct upload job in Supabase
        const { data: job, error: jobError } = await supabase
            .from('direct_upload_jobs')
            .insert({
                client_id: clientId,
                file_name: audioVideoFile.filename,
                file_url: `/uploads/direct_upload_files/${audioVideoFile.filename}`, // Store local path for now, consider S3/CDN later
                file_size_mb: audioVideoFile.size / (1024 * 1024),
                audio_length_minutes: audioLengthMinutes,
                client_instructions: clientInstructions,
                instruction_files: instructionFileNames,
                quote_amount: quote,
                agreed_deadline_hours: agreed_deadline_hours,
                status: 'pending_review',
                quality_param: qualityParam,
                deadline_param: deadlineParam,
                special_requirements: specialRequirements ? JSON.parse(specialRequirements) : []
            })
            .select()
            .single();

        if (jobError) throw jobError;

        // 5. Notify 4-star and 5-star transcribers (via Socket.IO)
        // Fetch all 4-star and 5-star transcribers who are online and available
        const { data: transcribers, error: transcriberFetchError } = await supabase
            .from('users')
            .select('id, full_name, email, transcribers(average_rating)')
            .eq('user_type', 'transcriber')
            .eq('is_online', true)
            .eq('is_available', true)
            .gte('transcribers.average_rating', 4); // 4-star and 5-star transcribers

        if (transcriberFetchError) console.error("Error fetching transcribers for direct job notification:", transcriberFetchError);

        if (io && transcribers && transcribers.length > 0) {
            const qualifiedTranscribers = transcribers.filter(t => t.transcribers?.[0]?.average_rating >= 4);
            qualifiedTranscribers.forEach(transcriber => {
                io.to(transcriber.id).emit('new_direct_job_available', {
                    jobId: job.id,
                    clientName: req.user.full_name,
                    quote: job.quote_amount,
                    message: `A new direct upload job from ${req.user.full_name} is available for KES ${job.quote_amount}!`
                });
            });
            console.log(`Emitted 'new_direct_job_available' to ${qualifiedTranscribers.length} transcribers.`);
        }

        res.status(201).json({
            message: 'Direct upload job created successfully. Awaiting transcriber.',
            job: job
        });

    } catch (error) {
        console.error('Error creating direct upload job:', error);
        // Clean up uploaded files if an error occurred
        if (audioVideoFile) await unlinkAsync(audioVideoFile.path);
        if (instructionFiles.length > 0) {
            await Promise.all(instructionFiles.map(file => unlinkAsync(file.path)));
        }
        res.status(500).json({ error: 'Server error creating direct upload job.' });
    }
};

// Get all direct upload jobs for a specific client
const getDirectUploadJobsForClient = async (req, res) => {
    const clientId = req.user.userId;

    try {
        const { data: jobs, error } = await supabase
            .from('direct_upload_jobs')
            .select(`
                *,
                client:users!client_id(full_name, email),
                transcriber:users!transcriber_id(full_name, email)
            `)
            .eq('client_id', clientId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.status(200).json({
            message: 'Client direct upload jobs retrieved successfully.',
            jobs: jobs
        });

    } catch (error) {
        console.error('Error fetching client direct upload jobs:', error);
        res.status(500).json({ error: 'Server error fetching client direct upload jobs.' });
    }
};

// Get available direct upload jobs for 4-star and 5-star transcribers
const getAvailableDirectUploadJobsForTranscriber = async (req, res) => {
    const transcriberId = req.user.userId;

    try {
        // 1. Get the requesting transcriber's rating to ensure they qualify
        const { data: transcriberProfile, error: profileError } = await supabase
            .from('transcribers')
            .select('average_rating')
            .eq('id', transcriberId)
            .single();

        if (profileError || !transcriberProfile || transcriberProfile.average_rating < 4) { // 4-star and 5-star only
            return res.status(403).json({ error: 'Access denied. Only 4-star and 5-star transcribers can view these jobs.' });
        }

        // 2. Fetch jobs that are 'pending_review' and not yet taken
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
                currency,
                agreed_deadline_hours,
                status,
                quality_param,
                deadline_param,
                special_requirements,
                created_at,
                client:users!client_id(full_name, email)
            `)
            .eq('status', 'pending_review')
            .is('transcriber_id', null) // Ensure it's not taken by anyone
            .order('created_at', { ascending: true }); // Oldest jobs first

        if (error) throw error;

        res.status(200).json({
            message: 'Available direct upload jobs retrieved successfully.',
            jobs: jobs
        });

    } catch (error) {
        console.error('Error fetching available direct upload jobs for transcriber:', error);
        res.status(500).json({ error: 'Server error fetching available direct upload jobs.' });
    }
};

// Transcriber takes a direct upload job
const takeDirectUploadJob = async (req, res, io) => {
    const { jobId } = req.params;
    const transcriberId = req.user.userId;

    try {
        // 1. Verify transcriber's eligibility (online, available, 4-star and 5-star)
        const { data: transcriberUser, error: userError } = await supabase
            .from('users')
            .select('is_online, is_available, current_job_id, transcribers(average_rating)')
            .eq('id', transcriberId)
            .eq('user_type', 'transcriber')
            .single();

        if (userError || !transcriberUser) {
            return res.status(404).json({ error: 'Transcriber profile not found.' });
        }
        if (!transcriberUser.is_online || !transcriberUser.is_available || transcriscriberUser.current_job_id) {
            return res.status(409).json({ error: 'You are not online, available, or already have an active job.' });
        }
        if (transcriberUser.transcribers?.[0]?.average_rating < 4) {
            return res.status(403).json({ error: 'Only 4-star and 5-star transcribers can take these jobs.' });
        }

        // 2. Atomically update the job: set transcriber_id and status
        const { data: updatedJob, error: jobUpdateError, count } = await supabase
            .from('direct_upload_jobs')
            .update({
                transcriber_id: transcriberId,
                status: 'in_progress',
                taken_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId)
            .eq('status', 'pending_review') // Ensure it's still pending
            .is('transcriber_id', null) // Ensure it's not already taken
            .select()
            .single();

        if (jobUpdateError) throw jobUpdateError;
        if (!updatedJob || count === 0) {
            return res.status(409).json({ error: 'Job not found, already taken, or no longer pending review.' });
        }

        // 3. Update transcriber's availability (set to busy with this job)
        await syncAvailabilityStatus(transcriberId, false, jobId);

        // 4. Notify client and potentially other transcribers (real-time)
        if (io) {
            // Notify the client that their job has been taken
            io.to(updatedJob.client_id).emit('direct_job_taken', {
                jobId: updatedJob.id,
                transcriberName: req.user.full_name,
                message: `Your direct upload job has been taken by ${req.user.full_name}!`
            });
            // Optionally, notify other transcribers that the job is no longer available
            io.emit('direct_job_status_update', {
                jobId: updatedJob.id,
                newStatus: 'in_progress'
            });
            console.log(`Emitted 'direct_job_taken' to client ${updatedJob.client_id} and 'direct_job_status_update' to all.`);
        }

        res.status(200).json({
            message: 'Job successfully taken. It is now in progress.',
            job: updatedJob
        });

    } catch (error) {
        console.error('Error taking direct upload job:', error);
        res.status(500).json({ error: 'Server error taking direct upload job.' });
    }
};

// Transcriber completes a direct upload job
const completeDirectUploadJob = async (req, res, io) => {
    const { jobId } = req.params;
    const transcriberId = req.user.userId;

    try {
        // 1. Verify job ownership and status
        const { data: job, error: jobError } = await supabase
            .from('direct_upload_jobs')
            .select('client_id, transcriber_id, status')
            .eq('id', jobId)
            .eq('transcriber_id', transcriberId)
            .single();

        if (jobError || !job) {
            return res.status(404).json({ error: 'Job not found or not assigned to you.' });
        }
        if (job.status !== 'in_progress') {
            return res.status(400).json({ error: 'Job is not in progress.' });
        }

        // 2. Update job status to 'completed'
        const { data: updatedJob, error: updateError } = await supabase
            .from('direct_upload_jobs')
            .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId)
            .select()
            .single();

        if (updateError) throw updateError;

        // 3. Update transcriber's availability (set to available)
        await syncAvailabilityStatus(transcriberId, true, null);

        // 4. Notify client (real-time)
        if (io) {
            io.to(job.client_id).emit('direct_job_completed', {
                jobId: job.id,
                transcriberName: req.user.full_name,
                message: `Your direct upload job has been completed by ${req.user.full_name}!`
            });
            console.log(`Emitted 'direct_job_completed' to client ${job.client_id}`);
        }

        res.status(200).json({
            message: 'Job marked as completed successfully.',
            job: updatedJob
        });

    } catch (error) {
        console.error('Error completing direct upload job:', error);
        res.status(500).json({ error: 'Server error completing direct upload job.' });
    }
};

/**
 * @route GET /api/admin/direct-upload-jobs
 * @desc Admin can view all direct upload jobs
 * @access Private (Admin only)
 */
const getAllDirectUploadJobsForAdmin = async (req, res) => {
    try {
        const { data: jobs, error } = await supabase
            .from('direct_upload_jobs')
            .select(`
                *,
                client:users!client_id(full_name, email),
                transcriber:users!transcriber_id(full_name, email)
            `)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching all direct upload jobs for admin:', error);
            return res.status(500).json({ error: error.message });
        }

        res.status(200).json({
            message: 'All direct upload jobs retrieved successfully for admin.',
            jobs: jobs
        });

    } catch (error) {
        console.error('Server error fetching all direct upload jobs for admin:', error);
        res.status(500).json({ error: 'Server error fetching all direct upload jobs for admin.' });
    }
};


module.exports = {
    uploadDirectFiles, // Multer middleware
    calculateQuote,
    createDirectUploadJob,
    getDirectUploadJobsForClient,
    getAvailableDirectUploadJobsForTranscriber,
    takeDirectUploadJob,
    completeDirectUploadJob,
    getAllDirectUploadJobsForAdmin // Export the new function for admin
};
