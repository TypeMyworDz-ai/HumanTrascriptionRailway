const supabase = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { syncAvailabilityStatus } = require('./transcriberController'); // Import syncAvailabilityStatus
const emailService = require('../emailService'); // For sending notifications
const util = require('util');
const { getAudioDurationInSeconds } = require('get-audio-duration'); // For calculating audio length

// Promisify fs.unlink for async file deletion
const unlinkAsync = util.promisify(fs.unlink);

// --- Multer Configuration for Direct Upload Files ---
const directUploadFileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/direct_upload_files'; // Directory for direct upload files
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

// File filter to allow only specific types of files
const directUploadFileFilter = (req, file, cb) => {
  const allowedTypes = [
    // Audio types
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/mp4', 'audio/m4a', 'audio/ogg',
    // Video types
    'video/mp4', 'video/webm', 'video/ogg',
    // Document types
    'application/pdf',
    'application/msword', // .doc
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'text/plain',
    // Image types
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif'
  ];
  // Check if the file's MIME type is in the allowed list
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true); // Accept the file
  } else {
    cb(new Error('Only audio, video, PDF, DOC, DOCX, TXT, and image files are allowed for direct uploads!'), false);
  }
};

// Multer configuration for handling multiple file fields
const uploadDirectFiles = multer({
  storage: directUploadFileStorage,
  fileFilter: directUploadFileFilter,
  limits: {
    fileSize: 200 * 1024 * 1024 // Limit file size to 200MB
  }
}).fields([
    { name: 'audioVideoFile', maxCount: 1 }, // Main audio/video file
    { name: 'instructionFiles', maxCount: 5 } // Additional instruction files (up to 5)
]);


// --- Quote Calculation Helper ---
const calculateQuote = async (audioLengthMinutes, qualityParam, deadlineParam, specialRequirements) => {
    // Fetch default pricing and deadline settings from admin_settings table
    const { data: adminSettings, error: settingsError } = await supabase
        .from('admin_settings')
        .select('default_price_per_minute, default_deadline_hours')
        .single();

    if (settingsError || !adminSettings) {
        console.error("Error fetching admin settings for quote calculation:", settingsError);
        throw new Error("Pricing settings not found.");
    }

    let pricePerMinute = adminSettings.default_price_per_minute;
    let deadlineMultiplier = 1;
    let qualityMultiplier = 1;
    let specialReqMultiplier = 1;

    // Adjust price based on quality parameter
    if (qualityParam === 'premium') {
        qualityMultiplier = 1.5;
    } else if (qualityParam === 'basic') {
        qualityMultiplier = 0.8;
    }

    // Adjust price based on deadline parameter
    if (deadlineParam === 'rush') {
        deadlineMultiplier = 1.5;
    } else if (deadlineParam === 'extended') {
        deadlineMultiplier = 0.8;
    }

    // Adjust price based on the number of special requirements
    if (specialRequirements && specialRequirements.length > 0) {
        specialReqMultiplier = 1 + (specialRequirements.length * 0.1); // Add 10% per requirement
    }

    // Calculate the final price per minute and the total quote
    const finalPricePerMinute = pricePerMinute * qualityMultiplier * deadlineMultiplier * specialReqMultiplier;
    const quote = parseFloat((audioLengthMinutes * finalPricePerMinute).toFixed(2));

    // Determine suggested deadline hours based on parameters
    let suggestedDeadlineHours = adminSettings.default_deadline_hours;
    if (deadlineParam === 'rush') {
        // Rush deadline: shorter, minimum 2 hours
        suggestedDeadlineHours = Math.max(2, Math.round(audioLengthMinutes / 30));
    } else if (deadlineParam === 'normal') {
        // Normal deadline: based on audio length, minimum 6 hours
        suggestedDeadlineHours = Math.max(6, Math.round(audioLengthMinutes / 15));
    } else if (deadlineParam === 'extended') {
        // Extended deadline: longer, maximum 168 hours (7 days)
        suggestedDeadlineHours = Math.min(168, Math.max(24, Math.round(audioLengthMinutes / 5)));
    }
    // Ensure deadline doesn't exceed a reasonable maximum (e.g., 1 week)
    suggestedDeadlineHours = Math.min(suggestedDeadlineHours, 168);

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
        specialRequirements // Expecting this as a JSON string
    } = req.body;

    let audioVideoFile = req.files?.audioVideoFile?.[0]; // Main file
    let instructionFiles = req.files?.instructionFiles || []; // Additional files

    // Store paths of all uploaded files for cleanup in case of errors
    const uploadedFilePaths = [];
    if (audioVideoFile) uploadedFilePaths.push(audioVideoFile.path);
    instructionFiles.forEach(file => uploadedFilePaths.push(file.path));

    // Helper function to clean up uploaded files
    const cleanupFiles = async () => {
        await Promise.all(uploadedFilePaths.map(async (filePath) => {
            if (fs.existsSync(filePath)) {
                try {
                    await unlinkAsync(filePath); // Use promisified unlink
                    console.log(`Cleaned up uploaded file: ${filePath}`);
                } catch (unlinkError) {
                    console.error(`Error deleting uploaded file during cleanup: ${unlinkError}`);
                }
            }
        }));
    };

    // Validate that the main audio/video file was uploaded
    if (!audioVideoFile) {
        // If main file is missing, clean up any instruction files that might have been uploaded
        if (instructionFiles.length > 0) {
            await cleanupFiles();
        }
        return res.status(400).json({ error: 'Main audio/video file is required.' });
    }

    try {
        // Verify the main audio/video file exists on the server after upload
        const audioVideoFilePath = audioVideoFile.path;
        if (!fs.existsSync(audioVideoFilePath)) {
            console.error(`!!! CRITICAL WARNING !!! Audio/Video file NOT found at expected path: ${audioVideoFilePath}`);
            await cleanupFiles(); // Clean up all files if the main file is missing
            return res.status(500).json({ error: 'Uploaded audio/video file not found on server after processing.' });
        } else {
            console.log(`Confirmed Audio/Video file exists at: ${audioVideoFilePath}`);
        }

        // 1. Get audio/video file duration
        const audioLengthSeconds = await getAudioDurationInSeconds(audioVideoFilePath);
        const audioLengthMinutes = audioLengthSeconds / 60;

        // 2. Calculate quote and suggested deadline based on parameters
        const { quote, agreed_deadline_hours } = await calculateQuote(
            audioLengthMinutes,
            qualityParam,
            deadlineParam,
            specialRequirements ? JSON.parse(specialRequirements) : [] // Parse JSON string if provided
        );

        // 3. Prepare instruction file names (if any)
        const instructionFileNames = instructionFiles.map(file => file.filename).join(',');

        // 4. Create the direct upload job record in the 'direct_upload_jobs' table
        const { data: job, error: jobError } = await supabase
            .from('direct_upload_jobs')
            .insert([
                {
                    client_id: clientId,
                    file_name: audioVideoFile.filename, // Store original filename
                    file_url: `/uploads/direct_upload_files/${audioVideoFile.filename}`, // URL path for accessing the file
                    file_size_mb: audioVideoFile.size / (1024 * 1024), // File size in MB
                    audio_length_minutes: audioLengthMinutes,
                    client_instructions: clientInstructions,
                    instruction_files: instructionFileNames || null, // Store comma-separated names or null
                    quote_amount: quote,
                    agreed_deadline_hours: agreed_deadline_hours,
                    status: 'pending_review', // Initial status
                    quality_param: qualityParam,
                    deadline_param: deadlineParam,
                    special_requirements: specialRequirements ? JSON.parse(specialRequirements) : []
                }
            ])
            .select() // Return the created job object
            .single();

        if (jobError) {
            console.error('createDirectUploadJob: Supabase error inserting new direct upload job:', jobError);
            await cleanupFiles(); // Clean up files if DB insertion fails
            throw jobError;
        }

        // If job created successfully, files are now linked and should not be cleaned up.
        const newJob = job;

        // 5. Notify qualified transcribers (4-star and 5-star) via Socket.IO
        const { data: transcribers, error: transcriberFetchError } = await supabase
            .from('users')
            .select('id, full_name, email, transcribers(average_rating)') // Fetch user details and transcriber profile
            .eq('user_type', 'transcriber')
            .eq('is_online', true) // Only notify online transcribers
            .eq('is_available', true) // Only notify available transcribers
            .gte('transcribers.average_rating', 4); // Filter for rating >= 4

        if (transcriberFetchError) console.error("Error fetching transcribers for direct job notification:", transcriberFetchError);

        if (io && transcribers && transcribers.length > 0) {
            // Filter again to be absolutely sure about the rating, although the DB query should handle it
            const qualifiedTranscribers = transcribers.filter(t => t.transcribers?.[0]?.average_rating >= 4);
            qualifiedTranscribers.forEach(transcriber => {
                // Emit event to each qualified transcriber's socket room
                io.to(transcriber.id).emit('new_direct_job_available', {
                    jobId: newJob.id,
                    clientName: req.user.full_name,
                    quote: newJob.quote_amount,
                    message: `A new direct upload job from ${req.user.full_name} is available for KES ${newJob.quote_amount}!`,
                    newStatus: 'pending_review'
                });
            });
            console.log(`Emitted 'new_direct_job_available' to ${qualifiedTranscribers.length} transcribers.`);
        }

        // Respond with success message and the created job details
        res.status(201).json({
            message: 'Direct upload job created successfully. Awaiting transcriber.',
            job: newJob
        });

    } catch (error) {
        console.error('createDirectUploadJob: UNCAUGHT EXCEPTION:', error);
        await cleanupFiles(); // Ensure files are cleaned up even for unexpected errors
        res.status(500).json({ error: error.message || 'Failed to create direct upload job due to server error.' });
    }
};

// Get all direct upload jobs for a specific client
const getDirectUploadJobsForClient = async (req, res) => {
    const clientId = req.user.userId;

    try {
        // Fetch jobs associated with the client, including client and transcriber details
        const { data: jobs, error } = await supabase
            .from('direct_upload_jobs')
            .select(`
                *,
                client:users!client_id(full_name, email),
                transcriber:users!transcriber_id(full_name, email)
            `)
            .eq('client_id', clientId) // Filter by the client making the request
            .order('created_at', { ascending: false }); // Order by creation date

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

// Get available direct upload jobs for qualified transcribers (4-star and 5-star)
const getAvailableDirectUploadJobsForTranscriber = async (req, res) => {
    const transcriberId = req.user.userId;

    try {
        // 1. Verify the transcriber's eligibility (online, available, and rating >= 4)
        const { data: transcriberUser, error: userError } = await supabase
            .from('users')
            .select('is_online, is_available, current_job_id, transcribers(average_rating)') // Fetch necessary user and transcriber profile fields
            .eq('id', transcriberId)
            .eq('user_type', 'transcriber')
            .single();

        if (userError || !transcriberUser) {
            return res.status(404).json({ error: 'Transcriber profile not found.' });
        }
        // Check eligibility criteria
        if (!transcriberUser.is_online || !transcriberUser.is_available || transcriberUser.current_job_id) {
            return res.status(409).json({ error: 'You are not online, available, or already have an active job. Please update your status.' });
        }
        if (transcriberUser.transcribers?.[0]?.average_rating < 4) {
            return res.status(403).json({ error: 'Only 4-star and 5-star transcribers can view these jobs.' });
        }

        // 2. Fetch jobs that are 'pending_review' and have not been assigned to any transcriber yet
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
                client:users!client_id(full_name, email) -- Join to get client details
            `)
            .eq('status', 'pending_review') // Filter for jobs awaiting assignment
            .is('transcriber_id', null) // Ensure the job hasn't been taken yet
            .order('created_at', { ascending: true }); // Order by creation date, oldest first

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

// Transcriber takes ownership of a direct upload job
const takeDirectUploadJob = async (req, res, io) => {
    const { jobId } = req.params;
    const transcriberId = req.user.userId;

    try {
        // 1. Verify transcriber's eligibility (online, available, correct rating)
        const { data: transcriberUser, error: userError } = await supabase
            .from('users')
            .select('is_online, is_available, current_job_id, transcribers(average_rating)') // Check user and transcriber profile status
            .eq('id', transcriberId)
            .eq('user_type', 'transcriber')
            .single();

        if (userError || !transcriberUser) {
            return res.status(404).json({ error: 'Transcriber profile not found.' });
        }
        // Check eligibility criteria
        if (!transcriberUser.is_online || !transcriberUser.is_available || transcriberUser.current_job_id) {
            return res.status(409).json({ error: 'You are not online, available, or already have an active job. Please update your status.' });
        }
        if (transcriberUser.transcribers?.[0]?.average_rating < 4) {
            return res.status(403).json({ error: 'Only 4-star and 5-star transcribers can take these jobs.' });
        }

        // 2. Atomically update the job: assign transcriber ID and change status
        const { data: updatedJob, error: jobUpdateError, count } = await supabase
            .from('direct_upload_jobs')
            .update({
                transcriber_id: transcriberId,
                status: 'in_progress', // Set status to indicate it's being worked on
                taken_at: new Date().toISOString(), // Record when it was taken
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId)
            .eq('status', 'pending_review') // Ensure it's still pending
            .is('transcriber_id', null) // Ensure it hasn't been taken by someone else
            .select()
            .single();

        if (jobUpdateError) throw jobUpdateError;
        // Check if the update affected exactly one row
        if (!updatedJob || count === 0) {
            return res.status(409).json({ error: 'Job not found, already taken, or no longer pending review.' });
        }

        // 3. Update the transcriber's availability status (set to busy with this job)
        await syncAvailabilityStatus(transcriberId, false, jobId); // Set is_available to false and assign job ID

        // 4. Notify the client and potentially other transcribers about the job status change
        if (io) {
            io.to(updatedJob.client_id).emit('direct_job_taken', {
                jobId: updatedJob.id,
                transcriberName: req.user.full_name,
                message: `Your direct upload job has been taken by ${req.user.full_name}!`,
                newStatus: 'in_progress'
            });
            // Emit a general update for other transcribers to see the job is no longer available
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
        // 1. Verify job ownership and status: Ensure it belongs to the transcriber and is 'in_progress'
        const { data: job, error: jobError } = await supabase
            .from('direct_upload_jobs')
            .select('client_id, transcriber_id, status')
            .eq('id', jobId)
            .eq('transcriber_id', transcriberId) // Must be assigned to this transcriber
            .single();

        if (jobError || !job) {
            return res.status(404).json({ error: 'Job not found or not assigned to you.' });
        }
        // Ensure the job is in the 'in_progress' state
        if (job.status !== 'in_progress') {
            return res.status(400).json({ error: 'Job is not in progress.' });
        }

        // 2. Update the job status to 'completed'
        const { data: updatedJob, error: updateError } = await supabase
            .from('direct_upload_jobs')
            .update({
                status: 'completed',
                completed_at: new Date().toISOString(), // Record completion time
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId)
            .select()
            .single();

        if (updateError) throw updateError;

        // 3. Update the transcriber's availability status (set back to available)
        await syncAvailabilityStatus(transcriberId, true, null); // Set is_available to true, clear current_job_id

        // 4. Notify the client in real-time that the job is completed
        if (io) {
            io.to(job.client_id).emit('direct_job_completed', {
                jobId: job.id,
                transcriberName: req.user.full_name,
                message: `Your direct upload job has been completed by ${req.user.full_name}!`,
                newStatus: 'completed'
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
        // Fetch all direct upload jobs, joining with client and transcriber user details
        const { data: jobs, error } = await supabase
            .from('direct_upload_jobs')
            .select(`
                *,
                client:users!client_id(full_name, email),
                transcriber:users!transcriber_id(full_name, email)
            `)
            .order('created_at', { ascending: false }); // Order by creation date

        if (error) {
            console.error('Error fetching all direct upload jobs for admin:', error);
            return res.status(500).json({ error: error.message });
        }

        // Format results to handle potential null client/transcriber IDs gracefully
        const formattedJobs = jobs.map(j => ({
            ...j,
            client: j.client || { full_name: 'Unknown Client', email: 'N/A' }, // Default if client is null
            transcriber: j.transcriber || { full_name: 'Unassigned', email: 'N/A' } // Default if transcriber is null
        }));


        res.status(200).json({
            message: 'All direct upload jobs retrieved successfully for admin.',
            jobs: formattedJobs
        });

    } catch (error) {
        console.error('Server error fetching all direct upload jobs for admin:', error);
        res.status(500).json({ error: 'Server error fetching all direct upload jobs for admin.' });
    }
};


module.exports = {
    uploadDirectFiles,
    calculateQuote,
    createDirectUploadJob,
    getDirectUploadJobsForClient,
    getAvailableDirectUploadJobsForTranscriber,
    takeDirectUploadJob,
    completeDirectUploadJob,
    getAllDirectUploadJobsForAdmin
};
