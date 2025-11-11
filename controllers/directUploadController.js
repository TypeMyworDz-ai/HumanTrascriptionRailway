const supabase = require('..//database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { syncAvailabilityStatus } = require('./transcriberController'); // Keep for syncAvailabilityStatus
const emailService = require('..//emailService');
const util = require('util');
const { getAudioDurationInSeconds } = require('get-audio-duration');
const { calculatePricePerMinute } = require('..//utils/pricingCalculator');
const { updateAverageRating } = require('./ratingController');

const axios = require('axios');
const { convertUsdToKes, EXCHANGE_RATE_USD_TO_KES, calculateTranscriberEarning } = require('..//utils/paymentUtils');
const http = require('http');
const https = require('https');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const CLIENT_URL = process.env.CLIENT_URL || 'http:--localhost:3000';
const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY;
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY;
const KORAPAY_BASE_URL = process.env.KORAPAY_BASE_URL || 'https:--api-sandbox.korapay.com-v1';
const KORAPAY_WEBHOOK_URL = process.env.REACT_APP_KORAPAY_WEBHOOK_URL || 'http://localhost:5000/api/payment/korapay-webhook';


const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });


const unlinkAsync = util.promisify(fs.unlink);

const getQuoteAndDeadline = async (audioLengthMinutes, audioQualityParam, deadlineTypeParam, specialRequirements) => {
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
        return res.status(400).json({ error: 'Main audio/video file is required for quote calculation.ᐟ' });
    }

    const parsedSpecialRequirements = (specialRequirements && specialRequirements !== '[]') 
        ? JSON.parse(specialRequirements) 
        : [];

    try {
        const audioVideoFilePath = audioVideoFile.path;
        if (!fs.existsSync(audioVideoFilePath)) {
            console.error(`!!! CRITICAL WARNING !!! Audio/Video file NOT found at expected path after upload: ${audioVideoFilePath}`);
            await cleanupFiles();
            return res.status(500).json({ error: 'Uploaded audio/video file not found on server after processing.ᐟ' });
        }

        const audioLengthSeconds = await getAudioDurationInSeconds(audioVideoFilePath);
        const audioLengthMinutes = audioLengthSeconds / 60;

        const quoteDetails = await getQuoteAndDeadline(
            audioLengthMinutes,
            audioQualityParam,
            deadlineTypeParam,
            parsedSpecialRequirements
        );

        res.status(200).json({
            message: 'Quote calculated successfully.',
            quoteDetails: quoteDetails
        });

    } catch (error) {
        console.error('handleQuoteCalculationRequest: UNCAUGHT EXCEPTION:', error);
        await cleanupFiles();
        res.status(500).json({ error: error.message || 'Failed to calculate quote due to server error.ᐟ' });
    } finally {
        if (audioVideoFile && fs.existsSync(audioVideoFile.path)) {
            await unlinkAsync(audioVideoFile.path).catch(err => console.error("Error cleaning up audioVideoFile after quote:", err));
        }
    }
};


const createDirectUploadJob = async (req, res, io) => {
    const clientId = req.user.userId;
    const {
        clientInstructions,
        audioQualityParam,
        deadlineTypeParam,
        specialRequirements,
        quote_amount,
        pricePerMinuteUsd,
        agreedDeadlineHours,
        jobType
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
        return res.status(400).json({ error: 'Main audio/video file is required.ᐟ' });
    }

    const parsedQuoteAmount = parseFloat(quote_amount);
    const parsedPricePerMinuteUsd = parseFloat(pricePerMinuteUsd);
    const parsedAgreedDeadlineHours = parseInt(agreedDeadlineHours, 10);

    const parsedSpecialRequirements = (specialRequirements && specialRequirements !== '[]') 
        ? JSON.parse(specialRequirements) 
        : [];

    if (isNaN(parsedQuoteAmount) || parsedQuoteAmount === null) { 
        await cleanupFiles();
        return res.status(400).json({ error: 'Quote amount is missing or invalid. Please ensure quote is calculated and sent correctly.ᐟ' });
    }
    if (isNaN(parsedPricePerMinuteUsd) || parsedPricePerMinuteUsd === null) {
        await cleanupFiles();
        return res.status(400).json({ error: 'Price per minute is missing or invalid. Please ensure quote is calculated and sent correctly.ᐟ' });
    }
    if (isNaN(parsedAgreedDeadlineHours) || parsedAgreedDeadlineHours === null) {
        await cleanupFiles();
        return res.status(400).json({ error: 'Agreed deadline hours are missing or invalid. Please ensure quote is calculated and sent correctly.ᐟ' });
    }

    if (jobType && jobType !== 'direct_upload') {
        await cleanupFiles();
        return res.status(400).json({ error: 'Invalid job type for this endpoint.ᐟ' });
    }

    try {
        const audioVideoFilePath = audioVideoFile.path;
        if (!fs.existsSync(audioVideoFilePath)) {
            console.error(`!!! CRITICAL WARNING !!! Audio/Video file NOT found at expected path: ${audioVideoFilePath}`);
            await cleanupFiles();
            return res.status(500).json({ error: 'Uploaded audio/video file not found on server after processing.ᐟ' });
        } else {
            console.log(`Confirmed Audio/Video file exists at: ${audioVideoFilePath}`);
        }

        const audioLengthSeconds = await getAudioDurationInSeconds(audioVideoFilePath);
        const audioLengthMinutes = audioLengthSeconds / 60;

        const instructionFileNames = instructionFiles.map(file => file.filename).join(',');

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
                    quote_amount: parsedQuoteAmount,
                    price_per_minute_usd: parsedPricePerMinuteUsd,
                    currency: 'USD',
                    agreed_deadline_hours: parsedAgreedDeadlineHours,
                    status: 'pending_review',
                    audio_quality_param: audioQualityParam,
                    deadline_type_param: deadlineTypeParam,
                    special_requirements: parsedSpecialRequirements
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

        const transcriberEstimatedPay = (newJob.quote_amount * 0.70).toFixed(2);

        const { data: transcribers, error: transcriberFetchError } = await supabase
            .from('users')
            .select('id, full_name, email, transcriber_average_rating')
            .eq('user_type', 'transcriber')
            .eq('is_online', true)
            .gte('transcriber_average_rating', 4);

        if (transcriberFetchError) console.error("Error fetching transcribers for direct job notification:", transcriberFetchError);

        if (io && transcribers && transcribers.length > 0) {
            const qualifiedTranscribers = transcribers.filter(t => t.transcriber_average_rating >= 4);
            qualifiedTranscribers.forEach(transcriber => {
                io.to(transcriber.id).emit('new_direct_job_available', {
                    jobId: newJob.id,
                    clientName: req.user.full_name,
                    transcriberPay: transcriberEstimatedPay,
                    message: `A new direct upload job from ${req.user.full_name} is available for USD ${transcriberEstimatedPay}!`,
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
        res.status(500).json({ error: error.message || 'Failed to create direct upload job due to server error.ᐟ' });
    }
};

const getDirectUploadJobsForClient = async (req, res) => {
    const clientId = req.user.userId;

    try {
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
                transcriber_id,
                client:users!client_id(id, full_name, email, client_average_rating, client_completed_jobs),
                transcriber:users!transcriber_id(id, full_name, email, transcriber_average_rating, transcriber_completed_jobs)
            `)
            .eq('client_id', clientId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('getDirectUploadJobsForClient Supabase error:', error);
            throw new Error(`Supabase query failed: ${error.message}`);
        }

        res.status(200).json({
            message: 'Client direct upload jobs retrieved successfully.',
            jobs: jobs
        });

    } catch (error) {
        console.error('Error fetching client direct upload jobs:', error);
        res.status(500).json({ error: 'Server error fetching client direct upload jobs: ' + error.message });
    }
};

const getAvailableDirectUploadJobsForTranscriber = async (req, res) => {
    const transcriberId = req.user.userId;

    try {
        const { data: transcriberUser, error: userError } = await supabase
            .from('users')
            .select('is_online, current_job_id, transcriber_average_rating, transcriber_status')
            .eq('id', transcriberId)
            .eq('user_type', 'transcriber')
            .single();

        if (userError || !transcriberUser) {
            console.error(`[getAvailableDirectUploadJobsForTranscriber] Transcriber profile not found for ${transcriberId}:`, userError);
            return res.status(404).json({ error: 'Transcriber profile not found.ᐟ' });
        }

        console.log(`[getAvailableDirectUploadJobsForTranscriber] Fetched transcriberUser for ${transcriberId}:`, {
            is_online: transcriberUser.is_online,
            current_job_id: transcriscriberUser.current_job_id,
            transcriber_average_rating: transcriberUser.transcriber_average_rating,
            transcriber_status: transcriberUser.transcriber_status
        });

        if (transcriberUser.transcriber_average_rating < 4) {
            return res.status(403).json({ error: 'You must be a 4-star or 5-star transcriber to access these jobs.ᐟ' });
        }
        if (transcriberUser.transcriber_status !== 'active_transcriber') {
            return res.status(403).json({ error: 'You are not an active transcriber. Please complete your assessment.ᐟ' });
        }

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
            .eq('status', 'available_for_transcriber')
            .is('transcriber_id', null)
            .order('created_at', { ascending: true });

        if (error) throw error;

        const jobsWithTranscriberPay = jobs.map(job => ({
            ...job,
            transcriber_pay: (job.quote_amount * 0.70).toFixed(2)
        }));

        res.status(200).json({
            message: 'Available direct upload jobs retrieved successfully.',
            jobs: jobsWithTranscriberPay
        });

    } catch (error) {
        console.error('Error fetching available direct upload jobs for transcriber:', error);
        res.status(500).json({ error: 'Server error fetching available direct upload jobs.ᐟ' });
    }
};

const getAllDirectUploadJobsForTranscriber = async (req, res) => {
    const transcriberId = req.user.userId;

    try {
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
                completed_at, 
                client_completed_at, 
                transcriber_comment, 
                client_feedback_comment, 
                client_feedback_rating, 
                client:users!client_id(full_name, email)
            `)
            .eq('transcriber_id', transcriberId) 
            .order('created_at', { ascending: false });

        if (error) {
            console.error(`[getAllDirectUploadJobsForTranscriber] Supabase error fetching direct upload jobs for transcriber ${transcriberId}:`, error);
            throw error;
        }

        res.status(200).json({
            message: 'Transcriber direct upload jobs retrieved successfully.',
            jobs: jobs
        });

    } catch (error) {
        console.error('[getAllDirectUploadJobsForTranscriber] Error fetching transcriber direct upload jobs:', error);
        res.status(500).json({ error: 'Server error fetching transcriber direct upload jobs.ᐟ' });
    }
};


const takeDirectUploadJob = async (req, res, io) => {
    const { jobId } = req.params;
    const transcriberId = req.user.userId;

    try {
        const { data: transcriberUser, error: userError } = await supabase
            .from('users')
            .select('is_online, current_job_id, transcriber_average_rating, transcriber_status')
            .eq('id', transcriberId)
            .eq('user_type', 'transcriber')
            .single();

        if (userError || !transcriberUser) {
            return res.status(404).json({ error: 'Transcriber profile not found.ᐟ' });
        }
        if (!transcriberUser.is_online || transcriberUser.current_job_id) {
            let errorMessage = 'You cannot take this job. ';
            if (!transcriberUser.is_online) { 
                errorMessage += 'Reason: You are currently offline. Please go online. ';
            }
            if (transcriberUser.current_job_id) {
                errorMessage += 'Reason: You already have an active job. Please complete your current job first. ';
            }
            return res.status(409).json({ error: errorMessage.trim() });
        }
        if (transcriberUser.transcriber_average_rating < 4) {
            return res.status(403).json({ error: 'Only 4-star and 5-star transcribers can take these jobs.ᐟ' });
        }
        if (transcriberUser.transcriber_status !== 'active_transcriber') {
            return res.status(403).json({ error: 'You are not an active transcriber. Please complete your assessment.ᐟ' });
        }

        const { data: updatedJob, error: jobUpdateError, count } = await supabase
            .from('direct_upload_jobs')
            .update({
                transcriber_id: transcriberId,
                status: 'taken',
                taken_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId)
            .eq('status', 'available_for_transcriber')
            .is('transcriber_id', null)
            .select()
            .single();

        if (jobUpdateError) throw jobUpdateError;
        if (!updatedJob || count === 0) {
            return res.status(409).json({ error: 'Job not found, already taken, or no longer available.ᐟ' });
        }

        await syncAvailabilityStatus(transcriberId, updatedJob.id);

        if (io) {
            io.to(updatedJob.client_id).emit('direct_job_taken', {
                jobId: updatedJob.id,
                transcriberName: req.user.full_name,
                message: `Your direct upload job has been taken by ${req.user.full_name}!`,
                newStatus: 'taken'
            });
            io.emit('direct_upload_job_taken', {
                jobId: updatedJob.id,
                newStatus: 'taken'
            });
            console.log(`Emitted 'direct_job_taken' to client ${updatedJob.client_id} and 'direct_upload_job_taken' to all.`);
        }

        res.status(200).json({
            message: 'Job successfully taken. It is now in progress.&amp;#x27;',
            job: updatedJob
        });

    } catch (error) {
        console.error('Error taking direct upload job:&amp;#x27;', error);
        res.status(500).json({ error: 'Server error taking direct upload job.ᐟ' });
    }
};

const completeDirectUploadJob = async (req, res, io) => {
    const { jobId } = req.params;
    const transcriberId = req.user.userId;
    const { transcriberComment } = req.body;

    try {
        const { data: job, error: jobError } = await supabase
            .from('direct_upload_jobs')
            .select('client_id, transcriber_id, status')
            .eq('id', jobId)
            .eq('transcriber_id', transcriberId)
            .single();

        if (jobError || !job) {
            console.error(`[completeDirectUploadJob] Job fetch error or not found:`, jobError);
            return res.status(404).json({ error: 'Job not found or not assigned to you.ᐟ' });
        }
        if (job.status !== 'taken' && job.status !== 'in_progress') {
            return res.status(400).json({ error: `Job is not currently active for completion.ᐟ` });
        }

        const { data: updatedJob, error: updateError } = await supabase
            .from('direct_upload_jobs')
            .update({
                status: 'completed',
                transcriber_comment: transcriberComment,
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId)
            .select()
            .single();

        if (updateError) {
            console.error(`[completeDirectUploadJob] Supabase update error for job ${jobId}:`, updateError);
            throw updateError;
        }

        const { data: existingPayment, error: paymentFetchError } = await supabase
            .from('payments')
            .select('id, payout_status')
            .eq('direct_upload_job_id', jobId)
            .eq('transcriber_id', transcriberId)
            .single();

        if (paymentFetchError && paymentFetchError.code !== 'PGRST116') {
             console.error(`[completeDirectUploadJob] Error fetching payment record for direct upload job ${jobId}:`, paymentFetchError);
        }

        if (existingPayment) {
            // UPDATED: Set payout_status to 'pending' when transcriber completes the job
            const { error: paymentUpdateError } = await supabase
                .from('payments')
                .update({ payout_status: 'pending', updated_at: new Date().toISOString() })
                .eq('id', existingPayment.id);

            if (paymentUpdateError) {
                console.error(`[completeDirectUploadJob] Error updating payment record for direct upload job ${jobId} to 'pending':`, paymentUpdateError);
            } else {
                console.log(`[completeDirectUploadJob] Payment record for direct upload job ${jobId} updated to 'pending' payout status.`);
            }
        } else {
            console.warn(`[completeDirectUploadJob] No existing payment record found for direct upload job ${jobId} and transcriber ${transcriberId}. A payment record should have been created upon client payment.`);
        }

        await syncAvailabilityStatus(transcriberId, null);

        if (io) {
            io.to(updatedJob.client_id).emit('direct_job_completed', {
                jobId: updatedJob.id,
                transcriberName: req.user.full_name,
                message: `Your direct upload job '${updatedJob.id.substring(0, 8)}...' has been submitted for client review!`,
                newStatus: 'completed'
            });
            io.emit('direct_job_completed_transcriber_side', { 
                jobId: updatedJob.id,
                message: `Direct upload job '${updatedJob.id.substring(0, 8)}...' submitted. Awaiting client review.`,
                newStatus: 'completed'
            });
            console.log(`Emitted 'direct_job_completed' to client ${updatedJob.client_id} and 'direct_job_completed_transcriber_side' to all transcribers.`);
        }

        res.status(200).json({
            message: 'Direct upload job submitted successfully. Awaiting client review.',
            job: updatedJob
        });

    } catch (error) {
        console.error(`[completeDirectUploadJob] UNCAUGHT EXCEPTION for job ${jobId}:`, error);
        res.status(500).json({ error: 'Server error completing direct upload job: ' + error.message });
    }
};

const clientCompleteDirectUploadJob = async (req, res, io) => {
    const { jobId } = req.params;
    const clientId = req.user.userId;
    const { clientFeedbackComment, clientFeedbackRating } = req.body;

    if (!jobId || !clientFeedbackRating) {
        return res.status(400).json({ error: 'Job ID and client feedback rating are required.ᐟ' });
    }

    try {
        const { data: job, error: jobFetchError } = await supabase
            .from('direct_upload_jobs')
            .select('client_id, transcriber_id, status')
            .eq('id', jobId)
            .eq('client_id', clientId)
            .single();

        if (jobFetchError || !job) {
            return res.status(404).json({ error: 'Direct upload job not found or not owned by you.ᐟ' });
        }

        if (job.status !== 'completed') {
            return res.status(400).json({ error: `Job must be in 'completed' status by transcriber before client can mark it complete. Current status: ${job.status}` });
        }

        const { data: updatedJob, error: updateError } = await supabase
            .from('direct_upload_jobs')
            .update({
                status: 'client_completed',
                client_feedback_comment: clientFeedbackComment,
                client_feedback_rating: clientFeedbackRating,
                client_completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId)
            .select()
            .single();

        if (updateError) throw updateError;

        if (job.transcriber_id && clientFeedbackRating) {
            await updateAverageRating(job.transcriber_id, clientFeedbackRating, 'transcriber');
        }

        // REMOVED: This payment update is no longer needed here, as payout_status is set to 'pending' when transcriber submits.
        // The payment should already be in 'pending' status if the transcriber completed it.
        /*
        const { error: paymentUpdateError } = await supabase
            .from('payments')
            .update({ payout_status: 'pending', updated_at: new Date().toISOString() })
            .eq('direct_upload_job_id', jobId)
            .eq('transcriber_id', job.transcriber_id) 
            .eq('payout_status', 'awaiting_completion'); 

        if (paymentUpdateError) {
            console.error(`[clientCompleteDirectUploadJob] Error updating payment record for direct upload job ${jobId} to 'pending':`, paymentUpdateError);
        } else {
            console.log(`[clientCompleteDirectUploadJob] Payment record for direct upload job ${jobId} updated to 'pending' payout status.`);
        }
        */

        if (io && updatedJob.transcriber_id) {
            io.to(updatedJob.transcriber_id).emit('direct_job_client_completed', {
                jobId: updatedJob.id,
                clientId: clientId,
                message: `Client has marked your direct upload job '${updatedJob.id.substring(0, 8)}...' as complete and provided feedback!`,
                newStatus: 'client_completed',
                feedback: {
                    comment: clientFeedbackComment,
                    rating: clientFeedbackRating
                }
            });
            console.log(`Emitted 'direct_job_client_completed' to transcriber ${updatedJob.transcriber_id}`);
        }

        res.status(200).json({
            message: 'Direct upload job marked as client-completed successfully.',
            job: updatedJob
        });

    } catch (error) {
        console.error('Error completing direct upload job by client:', error);
        res.status(500).json({ error: 'Server error completing direct upload job by client. ' + (error.message || '') });
    }
};

const getAllDirectUploadJobsForAdmin = async (req, res) => {
    try {
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
                completed_at, 
                client_completed_at, 
                transcriber_comment, 
                client_feedback_comment, 
                client_feedback_rating, 
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
        res.status(500).json({ error: 'Server error fetching client direct upload jobs.ᐟ' });
    }
};

const initializeDirectUploadPayment = async (req, res, io) => {
    console.log('[initializeDirectUploadPayment] Received request body:', req.body);

    const { jobId: directUploadJobId, amount, email, paymentMethod = 'paystack', mobileNumber, fullName } = req.body;
    const clientId = req.user.userId;

    const finalJobId = directUploadJobId;
    const finalClientEmail = email;

    console.log(`[initializeDirectUploadPayment] Destructured parameters - directUploadJobId: ${finalJobId}, amount: ${amount}, clientEmail: ${finalClientEmail}, clientId: ${clientId}, paymentMethod: ${paymentMethod}, mobileNumber: ${mobileNumber}`);

    if (!finalJobId || !amount || !finalClientEmail) {
        console.error('[initializeDirectUploadPayment] Validation failed: Missing required parameters.ᐟ');
        return res.status(400).json({ error: 'Direct Upload Job ID, amount, and client email are required.ᐟ' });
    }
    if (!['paystack', 'korapay'].includes(paymentMethod)) {
        console.error(`[initializeDirectUploadPayment] Validation failed: Invalid payment method provided: ${paymentMethod}`);
        return res.status(400).json({ error: 'Invalid payment method provided.ᐟ' });
    }

    if (paymentMethod === 'paystack' && !PAYSTACK_SECRET_KEY) {
        console.error('[initializeDirectUploadPayment] PAYSTACK_SECRET_KEY is not set.ᐟ');
        return res.status(500).json({ error: 'Paystack service not configured.ᐟ' });
    }
    if (paymentMethod === 'korapay' && !KORAPAY_SECRET_KEY) {
        console.error('[initializeDirectUploadPayment] KORAPAY_SECRET_KEY is not set.ᐟ');
        return res.status(500).json({ error: 'KoraPay service not configured.ᐟ' });
    }


    const parsedAmountUsd = parseFloat(amount);
    if (isNaN(parsedAmountUsd) || parsedAmountUsd <= 0) {
        return res.status(400).json({ error: 'Invalid payment amount.ᐟ' });
    }

    try {
        let jobDetails;
        let transcriberId;
        let agreedPriceUsd;
        let jobStatus;

        const { data, error } = await supabase
            .from('direct_upload_jobs')
            .select('id, client_id, transcriber_id, quote_amount, status')
            .eq('id', finalJobId)
            .eq('client_id', clientId)
            .single();
        if (error || !data) {
            console.error(`[initializeDirectUploadPayment] Error fetching direct upload job ${finalJobId} for payment:`, error);
            return res.status(404).json({ error: 'Direct upload job not found or not accessible.ᐟ' });
        }
        jobDetails = data;
        transcriberId = data.transcriber_id;
        agreedPriceUsd = data.quote_amount;
        jobStatus = data.status;
        if (jobStatus !== 'pending_review' && jobStatus !== 'transcriber_assigned') {
            console.error(`[initializeDirectUploadPayment] Direct upload job ${finalJobId} status is ${jobStatus}, not 'pending_review' or 'transcriber_assigned'.`);
            return res.status(400).json({ error: `Payment can only be initiated for direct upload jobs awaiting review or with assigned transcriber. Current status: ${jobStatus}` });
        }

        if (Math.round(parsedAmountUsd * 100) !== Math.round(agreedPriceUsd * 100)) {
            console.error('[initializeDirectUploadPayment] Payment amount mismatch. Provided USD:', parsedAmountUsd, 'Agreed USD:', agreedPriceUsd);
            return res.status(400).json({ error: 'Payment amount does not match the agreed job price.ᐟ' });
        }

        if (paymentMethod === 'paystack') {
            const amountKes = convertUsdToKes(parsedAmountUsd);
            const amountInCentsKes = Math.round(amountKes * 100);

            const paystackResponse = await axios.post(
                'https://api.paystack.co/transaction/initialize',
                {
                    email: finalClientEmail,
                    amount: amountInCentsKes,
                    reference: `${finalJobId}-${Date.now()}`,
                    callback_url: `${CLIENT_URL}/payment-callback?relatedJobId=${finalJobId}&jobType=direct_upload`,
                    currency: 'KES',
                    channels: ['mobile_money', 'card', 'bank_transfer', 'pesalink'],
                    metadata: {
                        related_job_id: finalJobId,
                        related_job_type: 'direct_upload',
                        client_id: clientId,
                        transcriber_id: transcriberId,
                        agreed_price_usd: agreedPriceUsd,
                        currency_paid: 'KES',
                        exchange_rate_usd_to_kes: EXCHANGE_RATE_USD_TO_KES,
                        amount_paid_kes: amountKes
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
                    }
                }
            );

            if (!paystackResponse.data.status) {
                console.error('[initializeDirectUploadPayment] Paystack initialization failed:', paystackResponse.data.message);
                return res.status(500).json({ error: paystackResponse.data.message || 'Failed to initialize payment with Paystack.ᐟ' });
            }

            res.status(200).json({
                message: 'Payment initialization successful',
                data: paystackResponse.data.data
            });
        } else if (paymentMethod === 'korapay') {
            if (!KORAPAY_PUBLIC_KEY) {
                console.error('[initializeDirectUploadPayment] KORAPAY_PUBLIC_KEY is not set for KoraPay frontend integration.ᐟ');
                return res.status(500).json({ error: 'KoraPay public key not configured.ᐟ' });
            }

            const reference = `JOB-${finalJobId.substring(0, 8)}-${Date.now().toString(36)}`;
            
            const amountKes = convertUsdToKes(parsedAmountUsd);
            const amountInKes = Math.round(amountKes); 

            const korapayCustomer = {
                name: fullName || req.user.full_name || 'Customer',
                email: finalClientEmail,
            };
            // Re-introducing: Conditionally add mobileNumber to KoraPay customer object
            if (mobileNumber) {
                korapayCustomer.phone = mobileNumber;
            }

            const korapayData = {
                key: KORAPAY_PUBLIC_KEY,
                reference: reference,
                amount: amountInKes,
                currency: 'KES',
                customer: korapayCustomer,
                notification_url: KORAPAY_WEBHOOK_URL,
                // REMOVED: channels: ['card', 'mobile_money'], to match trainingController.js
                metadata: {
                    related_job_id: finalJobId,
                    related_job_type: 'direct_upload',
                    client_id: clientId,
                    transcriber_id: transcriberId,
                    agreed_price_usd: agreedPriceUsd,
                    currency_paid: 'KES',
                    exchange_rate_usd_to_kes: EXCHANGE_RATE_USD_TO_KES,
                    amount_paid_kes: amountKes
                }
            };
            
            res.status(200).json({
                message: 'KoraPay payment initialization data successful',
                korapayData: korapayData
            });
        }

    } catch (error) {
        console.error(`[initializeDirectUploadPayment] Error initializing ${paymentMethod} payment:`, error.response ? error.response.data : error.message);
        res.status(500).json({ error: `Server error during ${paymentMethod} payment initialization.ᐟ` });
    }
};

const verifyDirectUploadPayment = async (req, res, io) => {
    // UPDATED: Extract relatedJobId from req.params as per frontend URL structure
    const { reference, jobId: relatedJobId } = req.params; 
    const { paymentMethod = 'paystack' } = req.query;

    if (!reference || !relatedJobId) {
        return res.status(400).json({ error: 'Payment reference and direct upload job ID are required for verification.ᐟ' });
    }
    if (!['paystack', 'korapay'].includes(paymentMethod)) {
        console.error(`Invalid payment method provided: ${paymentMethod}`);
        return res.status(400).json({ error: 'Invalid payment method provided.ᐟ' });
    }
    if (paymentMethod === 'paystack' && !PAYSTACK_SECRET_KEY) {
        return res.status(500).json({ error: 'Paystack service not configured.ᐟ' });
    }
    if (paymentMethod === 'korapay' && !KORAPAY_SECRET_KEY) {
        return res.status(500).json({ error: 'KoraPay service not configured.ᐟ' });
    }

    try {
        let transaction;
        let metadataCurrencyPaid;
        let metadataExchangeRate;
        let actualAmountPaidUsd;

        if (paymentMethod === 'paystack') {
            const paystackResponse = await axios.get(
                `https://api.paystack.co/transaction/verify/${reference}`,
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
                    }
                }
            );

            if (!paystackResponse.data.status || paystackResponse.data.data.status !== 'success') {
                console.error('Paystack verification failed:ᐟ', paystackResponse.data.data.gateway_response);
                return res.status(400).json({ error: paystackResponse.data.data.gateway_response || 'Payment verification failed.ᐟ' });
            }
            transaction = paystackResponse.data.data;
            metadataCurrencyPaid = transaction.metadata.currency_paid;
            metadataExchangeRate = transaction.metadata.exchange_rate_usd_to_kes;
            actualAmountPaidUsd = parseFloat((transaction.amount / 100 / metadataExchangeRate).toFixed(2));
        } else if (paymentMethod === 'korapay') {
            const korapayResponse = await axios.get(
                `${KORAPAY_BASE_URL}/charges/${reference}`,
                {
                    headers: {
                        Authorization: `Bearer ${KORAPAY_SECRET_KEY}`,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
                    },
                    httpsAgent: httpsAgent,
                    httpAgent: httpAgent
                }
            );

            if (!korapayResponse.data.status || korapayResponse.data.data.status !== 'success') {
                console.error('KoraPay verification failed:ᐟ', korapayResponse.data.message || korapayResponse.data.errors);
                return res.status(400).json({ error: korapayResponse.data.message || 'Payment verification failed with KoraPay.ᐟ' });
            }
            transaction = korapayResponse.data.data;
            const amountPaidKes = parseFloat(transaction.amount);
            actualAmountPaidUsd = parseFloat((amountPaidKes / EXCHANGE_RATE_USD_TO_KES).toFixed(2));
            metadataCurrencyPaid = 'KES';
            metadataExchangeRate = EXCHANGE_RATE_USD_TO_KES;
            
            transaction.metadata = {
                related_job_id: relatedJobId,
                related_job_type: 'direct_upload',
                client_id: req.user.userId,
                transcriber_id: transaction.metadata?.transcriber_id || null,
                agreed_price_usd: actualAmountPaidUsd,
                currency_paid: metadataCurrencyPaid,
                exchange_rate_usd_to_kes: metadataExchangeRate,
                amount_paid_kes: amountPaidKes
            };
            // UPDATED: Safely parse transaction.paid_at to handle potential 'Invalid time value'
            transaction.paid_at = transaction.createdAt ? new Date(transaction.createdAt).toISOString() : new Date().toISOString(); 
        }


        const {
            related_job_id: metadataRelatedJobId,
            related_job_type: metadataRelatedJobType,
            client_id: metadataClientId,
            transcriber_id: metadataTranscriberIdRaw,
            agreed_price_usd: metadataAgreedPrice,
            currency_paid: metadataCurrencyPaidFromMeta,
            exchange_rate_usd_to_kes: metadataExchangeRateFromMeta,
            amount_paid_kes: metadataAmountPaidKes
        } = transaction.metadata;

        const finalTranscriberId = (metadataTranscriberIdRaw === '' || metadataTranscriberIdRaw === undefined) ? null : metadataTranscriberIdRaw;

        if (metadataRelatedJobId !== relatedJobId || metadataRelatedJobType !== 'direct_upload') {
            console.error('Metadata job ID or type mismatch:ᐟ', metadataRelatedJobId, relatedJobId, metadataRelatedJobType);
            return res.status(400).json({ error: 'Invalid transaction metadata (job ID or type mismatch).ᐟ' });
        }

        if (Math.round(actualAmountPaidUsd * 100) !== Math.round(metadataAgreedPrice * 100)) {
            console.error('Payment verification amount mismatch. Transaction amount (USD):ᐟ', actualAmountPaidUsd, 'Expected USD:', metadataAgreedPrice);
            return res.status(400).json({ error: 'Invalid transaction metadata (amount mismatch). Payment charged a different amount than expected.ᐟ' });
        }
        
        let currentJob;
        let updateTable = 'direct_upload_jobs';
        let updateStatusColumn = 'status';
        let newJobStatus = 'available_for_transcriber';

        const { data, error } = await supabase
            .from('direct_upload_jobs')
            .select('id, client_id, transcriber_id, quote_amount, status')
            .eq('id', relatedJobId)
            .single();
        if (error || !data) {
            console.error(`Error fetching direct upload job ${relatedJobId} during payment verification: `, error);
            return res.status(404).json({ error: 'Direct upload job not found for verification.ᐟ' });
        }
        currentJob = data;
        if (currentJob.status === 'available_for_transcriber' || currentJob.status === 'taken' || currentJob.status === 'in_progress') {
             return res.status(200).json({ message: 'Payment already processed and direct upload job already active.ᐟ' });
        }
        
        const transcriberPayAmount = calculateTranscriberEarning(actualAmountPaidUsd);
        
        const paymentData = {
            related_job_type: 'direct_upload',
            client_id: metadataClientId,
            transcriber_id: finalTranscriberId,
            amount: actualAmountPaidUsd,
            transcriber_earning: transcriberPayAmount,
            currency: 'USD',
            paystack_reference: paymentMethod === 'paystack' ? transaction.reference : null,
            korapay_reference: paymentMethod === 'korapay' ? transaction.reference : null,
            paystack_status: paymentMethod === 'paystack' ? transaction.status : null,
            korapay_status: paymentMethod === 'korapay' ? transaction.status : null,
            transaction_date: new Date(transaction.paid_at).toISOString(),
            payout_status: 'awaiting_completion',
            currency_paid_by_client: metadataCurrencyPaidFromMeta,
            exchange_rate_used: metadataExchangeRateFromMeta
        };

        paymentData.direct_upload_job_id = relatedJobId;
        paymentData.negotiation_id = null;

        const { data: paymentRecord, error: paymentError } = await supabase
            .from('payments')
            .insert([paymentData])
            .select()
            .single();

        if (paymentError) {
            console.error('Error recording payment in Supabase: ', paymentError);
            throw paymentError;
        }

        const { error: jobUpdateError } = await supabase
            .from(updateTable)
            .update({ [updateStatusColumn]: newJobStatus, updated_at: new Date().toISOString() })
            .eq('id', relatedJobId);

        if (jobUpdateError) {
            console.error(`Error updating job status to ${newJobStatus} for direct upload job ${relatedJobId}: `, jobUpdateError);
            throw jobUpdateError;
        }

        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', metadataClientId).single();
        const transcriberUser = (finalTranscriberId)
            ? (await supabase.from('users').select('full_name, email').eq('id', finalTranscriberId).single()).data
            : null;

        if (clientError) console.error('Error fetching client for payment email: ', clientError);
        if (transcriberUser === null && finalTranscriberId) console.error('Error fetching transcriber for payment email: ', clientError);

        if (clientUser) {
            await emailService.sendPaymentConfirmationEmail(clientUser, transcriberUser, currentJob, paymentRecord);
        }

        if (io) {
            io.to(metadataClientId).emit('payment_successful', {
                relatedJobId: relatedJobId,
                jobType: 'direct_upload',
                message: 'Your payment was successful and the job is now active!ᐟ',
                newStatus: newJobStatus
            });
            io.emit('direct_job_paid', {
                jobId: relatedJobId,
                message: `A direct upload job has been paid for and is now available!`,
                newStatus: newJobStatus
            });
            console.log(`Emitted 'payment_successful' to client ${metadataClientId} and 'direct_job_paid' to all transcribers.`);
        }

        res.status(200).json({
            message: 'Payment verified successfully and job is now active.ᐟ',
            transaction: transaction
        });

    } catch (error) {
        console.error(`[verifyDirectUploadPayment] Error verifying ${paymentMethod} payment:`, error.response ? error.response.data : error.message);
        res.status(500).json({ error: `Server error during ${paymentMethod} payment verification.ᐟ` + (error.message || '') });
    }
};

// NEW: Function to handle direct upload file downloads for transcribers
const downloadDirectUploadFile = async (req, res) => {
    const { jobId, fileName } = req.params;
    const userId = req.user.userId;
    const userType = req.user.userType;

    if (!fileName) {
        return res.status(400).json({ error: 'File name is required.' });
    }

    try {
        // First, check if the user is a transcriber or admin
        if (userType !== 'transcriber' && userType !== 'admin') {
            return res.status(403).json({ error: 'Access denied. Only transcribers and admins can download these files.' });
        }

        // Fetch job details to verify status and ownership (if applicable)
        const { data: job, error: jobError } = await supabase
            .from('direct_upload_jobs')
            .select('id, status, file_name, instruction_files, transcriber_id')
            .eq('id', jobId)
            .single();

        if (jobError || !job) {
            console.error(`[downloadDirectUploadFile] Job ${jobId} not found or Supabase error:`, jobError);
            return res.status(404).json({ error: 'Job not found.' });
        }

        const isMainFile = job.file_name === fileName;
        const isInstructionFile = job.instruction_files && job.instruction_files.split(',').includes(fileName);

        if (!isMainFile && !isInstructionFile) {
            console.warn(`[downloadDirectUploadFile] File '${fileName}' not associated with job ${jobId}.`);
            return res.status(404).json({ error: 'File not found for this job.' });
        }

        // Allow download if:
        // 1. The job is 'available_for_transcriber' (for any transcriber to preview)
        // 2. The job is 'taken', 'in_progress', or 'completed' AND the current user is the assigned transcriber or an admin
        const isAssignedTranscriber = job.transcriber_id === userId;

        if (job.status === 'available_for_transcriber' && userType === 'transcriber') {
            // Allow any active transcriber to download for preview
            // (Further checks on transcriber status/level could be added here if needed)
            console.log(`[downloadDirectUploadFile] Transcriber ${userId} downloading file ${fileName} for available job ${jobId}.`);
        } else if ((job.status === 'taken' || job.status === 'in_progress' || job.status === 'completed') && (isAssignedTranscriber || userType === 'admin')) {
            // Allow assigned transcriber or admin to download for active/completed jobs
            console.log(`[downloadDirectUploadFile] ${userType === 'admin' ? 'Admin' : 'Assigned Transcriber'} ${userId} downloading file ${fileName} for job ${jobId} (status: ${job.status}).`);
        } else {
            return res.status(403).json({ error: `Access denied. You are not authorized to download this file for job status '${job.status}'.` });
        }

        const filePath = path.join('uploads/direct_upload_files', fileName);

        if (fs.existsSync(filePath)) {
            res.download(filePath, fileName, (err) => {
                if (err) {
                    console.error(`[downloadDirectUploadFile] Error sending file ${fileName} for job ${jobId}:`, err);
                    return res.status(500).json({ error: 'Failed to download file.' });
                }
            });
        } else {
            console.error(`[downloadDirectUploadFile] File not found on disk: ${filePath}`);
            return res.status(404).json({ error: 'File not found on server.' });
        }

    } catch (error) {
        console.error(`[downloadDirectUploadFile] UNCAUGHT EXCEPTION for job ${jobId}, file ${fileName}:`, error);
        res.status(500).json({ error: 'Server error during file download.' });
    }
};


module.exports = {
    handleQuoteCalculationRequest,
    createDirectUploadJob,
    getDirectUploadJobsForClient,
    getAvailableDirectUploadJobsForTranscriber,
    takeDirectUploadJob,
    completeDirectUploadJob,
    clientCompleteDirectUploadJob,
    getAllDirectUploadJobsForTranscriber, 
    getAllDirectUploadJobsForAdmin,
    initializeDirectUploadPayment,
    verifyDirectUploadPayment,
    downloadDirectUploadFile // NEW: Export the download function
};
