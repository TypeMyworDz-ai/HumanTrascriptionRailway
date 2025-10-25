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
        audio_quality: audioQualityParam,
        deadline_type: deadlineTypeParam,
        duration_minutes: audioLengthMinutes,
        special_requirements: specialRequirements
    };

    const pricePerMinuteUsd = await calculatePricePerMinute(jobParams);

    if (pricePerMinuteUsd === null) {
        throw new Error('No pricing rule matched for the provided job parameters. Please check admin settings.');
    }

    const totalQuoteUsd = parseFloat((audioLengthMinutes * pricePerMinuteUsd).toFixed(2));

    // Determine suggested deadline hours based on parameters
    let suggestedDeadlineHours;
    switch (deadlineTypeParam) {
        case 'urgent':
            suggestedDeadlineHours = Math.max(2, Math.round(audioLengthMinutes * 0.5));
            break;
        case 'standard':
            suggestedDeadlineHours = Math.max(12, Math.round(audioLengthMinutes * 1));
            break;
        case 'flexible':
            suggestedDeadlineHours = Math.max(24, Math.round(audioLengthMinutes * 2));
            break;
        default:
            suggestedDeadlineHours = 24;
    }
    suggestedDeadlineHours = Math.min(suggestedDeadlineHours, 168);
    suggestedDeadlineHours = Math.max(suggestedDeadlineHours, 2);

    return {
        quote_amount: totalQuoteUsd,
        agreed_deadline_hours: suggestedDeadlineHours,
        price_per_minute_usd: pricePerMinuteUsd,
        audio_length_minutes: audioLengthMinutes,
        audio_quality_param: audioQualityParam,
        deadline_type_param: deadlineTypeParam,
        special_requirements: specialRequirements
    };
};


// --- Controller Functions ---

// Handles the quote calculation request from the client
const handleQuoteCalculationRequest = async (req, res, io) => {
    const clientId = req.user.userId;
    const {
        audioQualityParam,
        deadlineTypeParam,
        specialRequirements
    } = req.body;

    let audioVideoFile = req.files?.audioVideoFile?.[0];

    const uploadedFilePaths = [];
    if (audioVideoFile) uploadedFilePaths.push(audioVideoFile.path);

    const cleanupFiles = async () => {
        await Promise.all(uploadedFilePaths.map(async (filePath) => {
            if (fs.existsSync(filePath)) {
                try {
                    await unlinkAsync(filePath);
                    console.log(`Cleaned up temporary uploaded file: ${filePath}`);
                } catch (unlinkError) {
                    console.error(`Error deleting uploaded file during cleanup: ${unlinkError}`);
                }
            }
        }));
    };

    if (!audioVideoFile) {
        await cleanupFiles();
        return res.status(400).json({ error: 'Main audio/video file is required for quote calculation.' });
    }

    // Robustly parse specialRequirements
    const parsedSpecialRequirements = (specialRequirements && specialRequirements !== '[]') 
        ? JSON.parse(specialRequirements) 
        : [];

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
            audioQualityParam,
            deadlineTypeParam,
            parsedSpecialRequirements // Pass the correctly parsed array
        );

        res.status(200).json({
            message: 'Quote calculated successfully.',
            quoteDetails: quoteDetails
        });

    } catch (error) {
        console.error('handleQuoteCalculationRequest: UNCAUGHT EXCEPTION:', error);
        await cleanupFiles();
        res.status(500).json({ error: error.message || 'Failed to calculate quote due to server error.' });
    } finally {
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
        audioQualityParam,
        deadlineTypeParam,
        specialRequirements,
        quote_amount, // FIX: Changed from quoteAmount to quote_amount to match frontend
        pricePerMinuteUsd,
        agreedDeadlineHours,
        jobType // Assuming jobType is also sent from frontend for explicit check
    } = req.body;

    let audioVideoFile = req.files?.audioVideoFile?.[0];
    let instructionFiles = req.files?.instructionFiles || [];

    const uploadedFilePaths = [];
    if (audioVideoFile) uploadedFilePaths.push(audioVideoFile.path);
    instructionFiles.forEach(file => uploadedFilePaths.push(file.path));

    const cleanupFiles = async () => {
        await Promise.all(uploadedFilePaths.map(async (filePath) => {
            if (fs.existsSync(filePath)) {
                try {
                    await unlinkAsync(filePath);
                    console.log(`Cleaned up uploaded file: ${filePath}`);
                } catch (unlinkError) {
                    console.error(`Error deleting uploaded file during cleanup: ${unlinkError}`);
                }
            }
        }));
    };

    if (!audioVideoFile) {
        if (instructionFiles.length > 0) {
            await cleanupFiles();
        }
        return res.status(400).json({ error: 'Main audio/video file is required.' });
    }

    // NEW: Perform parsing once and store in new variables for consistent validation and insertion
    const parsedQuoteAmount = parseFloat(quote_amount); // FIX: Use quote_amount
    const parsedPricePerMinuteUsd = parseFloat(pricePerMinuteUsd);
    const parsedAgreedDeadlineHours = parseInt(agreedDeadlineHours, 10);

    // Robustly parse specialRequirements for job creation
    const parsedSpecialRequirements = (specialRequirements && specialRequirements !== '[]') 
        ? JSON.parse(specialRequirements) 
        : [];

    // NEW: Add robust validation for parsed numeric fields
    if (isNaN(parsedQuoteAmount) || parsedQuoteAmount === null) { 
        await cleanupFiles();
        return res.status(400).json({ error: 'Quote amount is missing or invalid. Please ensure quote is calculated and sent correctly.' });
    }
    if (isNaN(parsedPricePerMinuteUsd) || parsedPricePerMinuteUsd === null) {
        await cleanupFiles();
        return res.status(400).json({ error: 'Price per minute is missing or invalid. Please ensure quote is calculated and sent correctly.' });
    }
    if (isNaN(parsedAgreedDeadlineHours) || parsedAgredDeadlineHours === null) {
        await cleanupFiles();
        return res.status(400).json({ error: 'Agreed deadline hours are missing or invalid. Please ensure quote is calculated and sent correctly.' });
    }

    // Optional: Validate jobType if it's explicitly sent
    if (jobType && jobType !== 'direct_upload') {
        await cleanupFiles();
        return res.status(400).json({ error: 'Invalid job type for this endpoint.' });
    }

    try {
        const audioVideoFilePath = audioVideoFile.path;
        if (!fs.existsSync(audioVideoFilePath)) {
            console.error(`!!! CRITICAL WARNING !!! Audio/Video file NOT found at expected path: ${audioVideoFilePath}`);
            await cleanupFiles();
            return res.status(500).json({ error: 'Uploaded audio/video file not found on server after processing.' });
        } else {
            console.log(`Confirmed Audio/Video file exists at: ${audioVideoFilePath}`);
        }

        const audioLengthSeconds = await getAudioDurationInSeconds(audioVideoFilePath);
        const audioLengthMinutes = audioLengthSeconds / 60;

        const instructionFileNames = instructionFiles.map(file => file.filename).join(',');

        // 3. Create the direct upload job record in the 'direct_upload_jobs' table
        const { data: job, error: jobError } = await supabase
            .from('direct_upload_jobs')
            .insert([
                {
                    client_id: clientId,
                    file_name: audioVideoFile.filename,
                    file_url: `/uploads/direct_upload_files/${audioVideoFile.filename}`,
                    file_size_mb: audioVideoFile.size / (1024 * 1024),
                    audio_length_minutes: audioLengthMinutes,
                    client_instructions: clientInstructions,
                    instruction_files: instructionFileNames || null,
                    quote_amount: parsedQuoteAmount, // FIX: Use parsedQuoteAmount
                    price_per_minute_usd: parsedPricePerMinuteUsd,
                    currency: 'USD',
                    agreed_deadline_hours: parsedAgreedDeadlineHours,
                    status: 'pending_review',
                    audio_quality_param: audioQualityParam,
                    deadline_type_param: deadlineTypeParam,
                    special_requirements: parsedSpecialRequirements // Use the correctly parsed array
                }
            ])
            .select()
            .single();

        if (jobError) {
            console.error('createDirectUploadJob: Supabase error inserting new direct upload job:', jobError);
            await cleanupFiles();
            throw jobError;
        }

        const newJob = job;

        // 4. Notify qualified transcribers (4-star and 5-star) via Socket.IO
        // FIX: Select transcriber_average_rating directly from 'users' table
        const { data: transcribers, error: transcriberFetchError } = await supabase
            .from('users')
            .select('id, full_name, email, transcriber_average_rating')
            .eq('user_type', 'transcriber')
            .eq('is_online', true)
            .eq('is_available', true)
            .gte('transcriber_average_rating', 4); // Filter for rating >= 4

        if (transcriberFetchError) console.error("Error fetching transcribers for direct job notification:", transcriberFetchError);

        if (io && transcribers && transcribers.length > 0) {
            const qualifiedTranscribers = transcribers.filter(t => t.transcriber_average_rating >= 4); // FIX: Use transcriber_average_rating
            qualifiedTranscribers.forEach(transcriber => {
                io.to(transcriber.id).emit('new_direct_job_available', {
                    jobId: newJob.id,
                    clientName: req.user.full_name,
                    quote: newJob.quote_amount, // FIX: Use newJob.quote_amount
                    message: `A new direct upload job from ${req.user.full_name} is available for USD ${newJob.quote_amount}!`, // FIX: Use newJob.quote_amount
                    newStatus: 'pending_review'
                });
            });
            console.log(`Emitted 'new_direct_job_available' to ${qualifiedTranscribers.length} transcribers.`);
        }

        res.status(201).json({
            message: 'Direct upload job created successfully. Awaiting transcriber.',
            job: newJob
        });

    } catch (error) {
        console.error('createDirectUploadJob: UNCAUGHT EXCEPTION:', error);
        await cleanupFiles();
        res.status(500).json({ error: error.message || 'Failed to create direct upload job due to server error.' });
    }
};

// Get all direct upload jobs for a specific client
const getDirectUploadJobsForClient = async (req, res) => {
    const clientId = req.user.userId;

    try {
        // Fetch jobs associated with the client, joining with client and transcriber user details
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

// Get available direct upload jobs for qualified transcribers (4-star and 5-star)
const getAvailableDirectUploadJobsForTranscriber = async (req, res) => {
    const transcriberId = req.user.userId;

    try {
        // 1. Verify the transcriber's eligibility (online, available, and rating >= 4)
        // FIX: Select transcriber_average_rating and transcriber_status directly from 'users'
        const { data: transcriberUser, error: userError } = await supabase
            .from('users')
            .select('is_online, is_available, current_job_id, transcriber_average_rating, transcriber_status')
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
        // FIX: Use transcriber_average_rating for the check
        if (transcriberUser.transcriber_average_rating < 4) {
            return res.status(403).json({ error: 'Only 4-star and 5-star transcribers can view these jobs.' });
        }
        // FIX: Also check transcriber_status
        if (transcriberUser.transcriber_status !== 'active_transcriber') {
            return res.status(403).json({ error: 'You are not an active transcriber. Please complete your assessment.' });
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
                price_per_minute_usd,
                currency,
                agreed_deadline_hours,
                status,
                audio_quality_param,
                deadline_type_param,
                special_requirements,
                created_at,
                client:users!client_id(full_name, email)
            `)
            .eq('status', 'pending_review')
            .is('transcriber_id', null)
            .order('created_at', { ascending: true });

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
        // FIX: Select transcriber_average_rating and transcriber_status directly from 'users'
        const { data: transcriberUser, error: userError } = await supabase
            .from('users')
            .select('is_online, is_available, current_job_id, transcriber_average_rating, transcriber_status')
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
        // FIX: Use transcriber_average_rating for the check
        if (transcriberUser.transcriber_average_rating < 4) {
            return res.status(403).json({ error: 'Only 4-star and 5-star transcribers can take these jobs.' });
        }
        // FIX: Also check transcriber_status
        if (transcriberUser.transcriber_status !== 'active_transcriber') {
            return res.status(403).json({ error: 'You are not an active transcriber. Please complete your assessment.' });
        }

        // 2. Atomically update the job: assign transcriber ID and change status
        const { data: updatedJob, error: jobUpdateError, count } = await supabase
            .from('direct_upload_jobs')
            .update({
                transcriber_id: transcriberId,
                status: 'in_progress',
                taken_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId)
            .eq('status', 'pending_review')
            .is('transcriber_id', null)
            .select()
            .single();

        if (jobUpdateError) throw jobUpdateError;
        if (!updatedJob || count === 0) {
            return res.status(409).json({ error: 'Job not found, already taken, or no longer pending review.' });
        }

        // 3. Update the transcriber's availability status (set to busy with this job)
        await syncAvailabilityStatus(transcriberId, false, jobId);

        // 4. Notify the client and potentially other transcribers about the job status change
        if (io) {
            io.to(updatedJob.client_id).emit('direct_job_taken', {
                jobId: updatedJob.id,
                transcriberName: req.user.full_name,
                message: `Your direct upload job has been taken by ${req.user.full_name}!`,
                newStatus: 'in_progress'
            });
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

        // 3. Update the transcriber's availability status (set back to available)
        await syncAvailabilityStatus(transcriberId, true, null);

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
 * */
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
                quote_amount,
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
