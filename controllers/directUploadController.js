const supabase = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { syncAvailabilityStatus } = require('./transcriberController'); // Import syncAvailabilityStatus
const emailService = require('../emailService'); // For sending notifications
const util = require('util');
const { getAudioDurationInSeconds } = require('get-audio-duration'); // For calculating audio length
const { calculatePricePerMinute } = require('../utils/pricingCalculator'); // Import the pricing calculator

// Promisify fs.unlink for async file deletion
const unlinkAsync = util.promisify(fs.unlink);

// --- Multer Configuration for Direct Upload Files (MOVED TO generalApiRoutes.js) ---
// Note: The actual Multer setup for `uploadDirectFiles` is now in generalApiRoutes.js
// We keep references to `uploadDirectFiles` for clarity if it were to be used directly here,
// but for the quote and job creation routes, the middleware is applied in generalApiRoutes.js.


// --- Quote Calculation Helper (UPDATED to use pricingCalculator) ---
const getQuoteAndDeadline = async (audioLengthMinutes, audioQualityParam, deadlineTypeParam, specialRequirements) => {
    // Construct job parameters for the pricing calculator
    const jobParams = {
        audio_quality: audioQualityParam, // UPDATED: Changed from 'quality' to 'audio_quality'
        deadline_type: deadlineTypeParam,
        duration_minutes: audioLengthMinutes,
        special_requirements: specialRequirements // Pass through if rules might use it directly
    };

    const pricePerMinuteUsd = await calculatePricePerMinute(jobParams);

    if (pricePerMinuteUsd === null) {
        throw new Error('No pricing rule matched for the provided job parameters. Please check admin settings.');
    }

    const totalQuoteUsd = parseFloat((audioLengthMinutes * pricePerMinuteUsd).toFixed(2));

    // Determine suggested deadline hours based on parameters
    // This logic can also be moved into pricingCalculator if it becomes complex and rule-based
    let suggestedDeadlineHours;
    switch (deadlineTypeParam) {
        case 'urgent':
            suggestedDeadlineHours = Math.max(2, Math.round(audioLengthMinutes * 0.5)); // Example: Faster processing
            break;
        case 'standard':
            suggestedDeadlineHours = Math.max(12, Math.round(audioLengthMinutes * 1)); // Example: 1 minute audio = 1 hour deadline
            break;
        case 'flexible':
            suggestedDeadlineHours = Math.max(24, Math.round(audioLengthMinutes * 2)); // Example: Slower processing
            break;
        default:
            suggestedDeadlineHours = 24; // Default to 24 hours
    }
    suggestedDeadlineHours = Math.min(suggestedDeadlineHours, 168); // Cap at 7 days (168 hours)
    suggestedDeadlineHours = Math.max(suggestedDeadlineHours, 2); // Minimum 2 hours

    return {
        quote_amount_usd: totalQuoteUsd,
        agreed_deadline_hours: suggestedDeadlineHours,
        price_per_minute_usd: pricePerMinuteUsd,
        audio_length_minutes: audioLengthMinutes, // Include for modal display
        audio_quality_param: audioQualityParam, // Include for modal display
        deadline_type_param: deadlineTypeParam, // Include for modal display
        special_requirements: specialRequirements // Include for modal display
    };
};


// --- Controller Functions ---

// NEW: Handles the quote calculation request from the client (POST /api/direct-upload/job/quote)
const handleQuoteCalculationRequest = async (req, res, io) => {
    const clientId = req.user.userId;
    const {
        audioQualityParam, // UPDATED: Changed from 'qualityParam' to 'audioQualityParam'
        deadlineTypeParam,
        specialRequirements // Expecting this as a JSON string or array
    } = req.body;

    let audioVideoFile = req.files?.audioVideoFile?.[0]; // Main file uploaded for duration calculation

    // Store paths of all uploaded files for cleanup in case of errors
    const uploadedFilePaths = [];
    if (audioVideoFile) uploadedFilePaths.push(audioVideoFile.path);
    // Note: instructionFiles are not needed for quote calculation, so no need to process them here.

    // Helper function to clean up uploaded files
    const cleanupFiles = async () => {
        await Promise.all(uploadedFilePaths.map(async (filePath) => {
            if (fs.existsSync(filePath)) {
                try {
                    await unlinkAsync(filePath); // Use promisified unlink
                    console.log(`Cleaned up temporary uploaded file: ${filePath}`);
                } catch (unlinkError) {
                    console.error(`Error deleting uploaded file during cleanup: ${unlinkError}`);
                }
            }
        }));
    };

    // Validate that the main audio/video file was uploaded
    if (!audioVideoFile) {
        await cleanupFiles();
        return res.status(400).json({ error: 'Main audio/video file is required for quote calculation.' });
    }

    try {
        const audioVideoFilePath = audioVideoFile.path;
        if (!fs.existsSync(audioVideoFilePath)) {
            console.error(`!!! CRITICAL WARNING !!! Audio/Video file NOT found at expected path after upload: ${audioVideoFilePath}`);
            await cleanupFiles();
            return res.status(500).json({ error: 'Uploaded audio/video file not found on server after processing.' });
        }

        const audioLengthSeconds = await getAudioDurationInSeconds(audioVideoFilePath);
        const audioLengthMinutes = audioLengthSeconds / 60;

        const quoteDetails = await getQuoteAndDeadline(
            audioLengthMinutes,
            audioQualityParam, // Use the new param name
            deadlineTypeParam,
            specialRequirements ? JSON.parse(specialRequirements) : []
        );

        res.status(200).json({
            message: 'Quote calculated successfully.',
            quoteDetails: quoteDetails
        });

    } catch (error) {
        console.error('handleQuoteCalculationRequest: UNCAUGHT EXCEPTION:', error);
        await cleanupFiles(); // Ensure temporary files are cleaned up
        res.status(500).json({ error: error.message || 'Failed to calculate quote due to server error.' });
    } finally {
        // Always clean up the temporary audio/video file after quote calculation
        if (audioVideoFile && fs.existsSync(audioVideoFile.path)) {
            await unlinkAsync(audioVideoFile.path).catch(err => console.error("Error cleaning up audioVideoFile after quote:", err));
        }
    }
};


// Client uploads files and creates a direct job request
const createDirectUploadJob = async (req, res, io) => {
    const clientId = req.user.userId;
    const {
        clientInstructions,
        audioQualityParam, // UPDATED: Changed from 'qualityParam' to 'audioQualityParam'
        deadlineTypeParam,
        specialRequirements, // Expecting this as a JSON string or array
        quoteAmountUsd, // Received from frontend after quote calculation
        pricePerMinuteUsd, // Received from frontend after quote calculation
        agreedDeadlineHours // Received from frontend after quote calculation
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

    // NEW: Add validation for quoteAmountUsd, pricePerMinuteUsd, and agreedDeadlineHours
    if (typeof quoteAmountUsd === 'undefined' || quoteAmountUsd === null || isNaN(parseFloat(quoteAmountUsd))) {
        await cleanupFiles();
        return res.status(400).json({ error: 'Quote amount is missing or invalid. Please ensure quote is calculated and sent.' });
    }
    if (typeof pricePerMinuteUsd === 'undefined' || pricePerMinuteUsd === null || isNaN(parseFloat(pricePerMinuteUsd))) {
        await cleanupFiles();
        return res.status(400).json({ error: 'Price per minute is missing or invalid. Please ensure quote is calculated and sent.' });
    }
    if (typeof agreedDeadlineHours === 'undefined' || agreedDeadlineHours === null || isNaN(parseInt(agreedDeadlineHours, 10))) {
        await cleanupFiles();
        return res.status(400).json({ error: 'Agreed deadline hours are missing or invalid. Please ensure quote is calculated and sent.' });
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

        // 1. Get audio/video file duration (already done for quote, but re-calculate or retrieve if needed for validation)
        const audioLengthSeconds = await getAudioDurationInSeconds(audioVideoFilePath);
        const audioLengthMinutes = audioLengthSeconds / 60;

        // 2. Prepare instruction file names (if any)
        const instructionFileNames = instructionFiles.map(file => file.filename).join(',');

        // 3. Create the direct upload job record in the 'direct_upload_jobs' table
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
                    quote_amount_usd: parseFloat(quoteAmountUsd), // Ensure it's a float, from frontend
                    price_per_minute_usd: parseFloat(pricePerMinuteUsd), // Ensure it's a float, from frontend
                    currency: 'USD',
                    agreed_deadline_hours: parseInt(agreedDeadlineHours, 10), // Ensure it's an int, from frontend
                    status: 'pending_review', // Initial status
                    audio_quality_param: audioQualityParam, // UPDATED: Use new param name
                    deadline_type_param: deadlineTypeParam, // UPDATED: Use new param name
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

        // 4. Notify qualified transcribers (4-star and 5-star) via Socket.IO
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
                    quote: newJob.quote_amount_usd,
                    message: `A new direct upload job from ${req.user.full_name} is available for USD ${newJob.quote_amount_usd}!`,
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
                id,
                file_name,
                file_url,
                file_size_mb,
                audio_length_minutes,
                client_instructions,
                instruction_files,
                quote_amount_usd,
                price_per_minute_usd,
                currency,
                agreed_deadline_hours,
                status,
                audio_quality_param, // UPDATED: Use new param name
                deadline_type_param, // UPDATED: Use new param name
                special_requirements,
                created_at,
                client:users!client_id(full_name, email), // Join to get client details
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
                quote_amount_usd,
                price_per_minute_usd,
                currency,
                agreed_deadline_hours,
                status,
                audio_quality_param, // UPDATED: Use new param name
                deadline_type_param, // UPDATED: Use new param name
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
        console.error('Error fetching available direct upload jobs for transcriber:', error); // SYNTAX FIX: Corrected console.error
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
                id,
                file_name,
                file_url,
                file_size_mb,
                audio_length_minutes,
                client_instructions,
                instruction_files,
                quote_amount_usd,
                price_per_minute_usd,
                currency,
                agreed_deadline_hours,
                status,
                audio_quality_param,
                deadline_type_param,
                special_requirements,
                created_at,
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
    // uploadDirectFiles, // Multer middleware is now defined and used in generalApiRoutes.js
    handleQuoteCalculationRequest, // NEW: Export the quote calculation handler
    createDirectUploadJob,
    getDirectUploadJobsForClient,
    getAvailableDirectUploadJobsForTranscriber,
    takeDirectUploadJob,
    completeDirectUploadJob,
    getAllDirectUploadJobsForAdmin
};
