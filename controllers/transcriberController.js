const supabase = require('..//database');
const path = require('path');
const fs = require('fs');
const emailService = require('..//emailService');
const { updateAverageRating } = require('.//ratingController'); // This will also need updating later
const { calculateTranscriberEarning } = require('..//utils/paymentUtils'); // Import calculateTranscriberEarning
const { getNextFriday } = require('..//utils/paymentUtils'); // Import getNextFriday

// Utility function to sync availability status (updates 'users' table only)
const syncAvailabilityStatus = async (userId, isAvailable, currentJobId = null) => {
    // NEW: Add a check for null or undefined userId
    if (!userId) {
        console.warn('syncAvailabilityStatus: userId is null or undefined. Skipping availability sync.');
        return; // Exit early if no valid user ID
    }

    const updateData = {
        is_available: isAvailable,
        current_job_id: currentJobId,
        updated_at: new Date().toISOString()
    };

    try {
        // FIX: Only update 'users' table for availability flags
        const { error: userError } = await supabase
            .from('users')
            .update(updateData)
            .eq('id', userId);

        if (userError) {
            console.error(`Supabase error updating user availability in 'users' table for ${userId}:`, userError);
            throw userError;
        }
        console.log(`User ${userId} availability synced: is_available=${isAvailable}, current_job_id=${currentJobId}`);
    } catch (error) {
        console.error(`syncAvailabilityStatus: Uncaught error for user ${userId}:`, error);
        throw error;
    }
};

// Function to set a user's online status (updates 'users' table only)
const setOnlineStatus = async (userId, isOnline) => {
    console.log(`[setOnlineStatus] Attempting to set user ${userId} is_online to ${isOnline}`);
    try {
        // Fetch current user data before updating to ensure consistency
        const { data: currentUser, error: fetchError } = await supabase
            .from('users')
            .select('is_available, current_job_id')
            .eq('id', userId)
            .eq('user_type', 'transcriber')
            .single();

        if (fetchError || !currentUser) {
            console.error(`[setOnlineStatus] Error fetching current user data for ${userId}:`, fetchError);
            // Proceed with setting online status, but log the error
        }

        const updateData = {
            is_online: isOnline,
            updated_at: new Date().toISOString()
        };

        // NEW LOGIC: If transcriber is going online and is NOT currently assigned a job,
        // ensure their 'is_available' status is also set to true.
        // This prevents cases where 'is_available' might be false due to a previous session or bug.
        if (isOnline && (!currentUser || !currentUser.current_job_id)) {
            updateData.is_available = true;
            updateData.current_job_id = null; // Ensure no stale job ID if making available
            console.log(`[setOnlineStatus] Correcting 'is_available' to true for user ${userId} as they are coming online and have no active job.`);
        } else if (!isOnline) {
            // When going offline, also set is_available to false as they are no longer actively working
            updateData.is_available = false;
            console.log(`[setOnlineStatus] Setting 'is_available' to false for user ${userId} as they are going offline.`);
        }

        const { data, error } = await supabase
            .from('users')
            .update(updateData)
            .eq('id', userId)
            .eq('user_type', 'transcriber'); // Ensure this only affects transcriber records

        if (error) {
            console.error(`[setOnlineStatus] Supabase error setting online status for user ${userId} to ${isOnline}:`, error);
            throw error;
        }
        console.log(`[setOnlineStatus] User ${userId} is_online status successfully set to ${isOnline}. Supabase response data:`, data);

    } catch (error) {
        console.error('[setOnlineStatus] Uncaught error:', error);
        throw error;
    }
};

// Submit transcriber test
const submitTest = async (req, res) => {
  try {
    const { grammar_score, transcription_text } = req.body;
    const userId = req.user.userId; // Assuming userId is available from auth middleware

    // Check if the user has already submitted a test
    const { data: existingTest } = await supabase
      .from('test_submissions')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (existingTest) {
      return res.status(400).json({ error: 'Test already submitted' });
    }

    // Insert the new test submission
    const { data, error } = await supabase
      .from('test_submissions')
      .insert([
        {
          user_id: userId,
          grammar_score: grammar_score,
          transcription_text: transcription_text,
          status: 'pending' // Initial status after submission
        }
      ])
      .select(); // Return the inserted row

    if (error) throw error;

    // Respond with success message and submission details
    res.status(201).json({
      message: 'Test submitted successfully',
      submission: data[0]
    });

    // --- SENDING THE TEST SUBMITTED EMAIL ---
    // Fetch user details if not fully available in req.user (e.g., if only userId is present)
    let userDetails = req.user; // Assume userId, email, full_name are available from JWT payload
    if (!userDetails || !userDetails.email) {
        // Fallback: Fetch user details from Supabase if not fully populated in JWT payload
        const { data: fetchedUser } = await supabase
            .from('users')
            .select('id, email, full_name')
            .eq('id', userId)
            .single();
        userDetails = fetchedUser;
    }

    // Send email notification if user details are available
    if (userDetails && userDetails.email) {
        await emailService.sendTranscriberTestSubmittedEmail(userDetails);
    }
    // --- END OF EMAIL INTEGRATION ---

  } catch (error) {
    console.error('Test submission error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Check test status and transcriber profile details
const checkTestStatus = async (req, res) => {
  try {
    const userId = req.user.userId;

    // Ensure userId is valid before querying
    if (!userId) {
        console.warn('[checkTestStatus] userId is undefined or null.');
        return res.status(400).json({ error: 'User ID is required.' });
    }

    // FIX: Fetch transcriber profile details directly from the 'users' table
    const { data: userProfile, error: profileError } = await supabase
      .from('users') // Query the 'users' table
      .select('transcriber_status, transcriber_user_level, transcriber_mpesa_number, transcriber_paypal_email') // Select specific transcriber fields
      .eq('id', userId) // The 'id' in users table
      .eq('user_type', 'transcriber') // Ensure it's a transcriber
      .single();

    if (profileError) {
        console.error(`[checkTestStatus] Supabase error fetching transcriber profile for user ${userId}:`, profileError);
        if (profileError.code === 'PGRST116') { // No rows found
             console.warn(`[checkTestStatus] Transcriber profile not found for user ${userId}.`);
             return res.status(404).json({ error: 'Transcriber profile not found for this user.' });
        }
        throw profileError;
    }
    if (!userProfile) { // Defensive check
        console.warn(`[checkTestStatus] Transcriber profile not found for user ${userId} (after initial check).`);
        return res.status(404).json({ error: 'Transcriber profile not found for this user.' });
    }

    // Fetch the latest test submission for the user
    const { data: testSubmission, error: testSubmissionError } = await supabase
      .from('test_submissions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (testSubmissionError && testSubmissionError.code !== 'PGRST116') {
        console.error(`[checkTestStatus] Supabase error fetching test submission for user ${userId}:`, testSubmissionError);
        throw testSubmissionError;
    }

    // Return the combined information
    res.json({
      user_status: userProfile.transcriber_status, // Status from users table
      user_level: userProfile.transcriber_user_level, // Level from users table
      mpesa_number: userProfile.transcriber_mpesa_number, // Payment details from users table
      paypal_email: userProfile.transcriber_paypal_email, // Payment details from users table
      test_submission: testSubmission || null,
      has_submitted_test: !!testSubmission
    });

  } catch (error) {
    console.error('[checkTestStatus] Error checking test status: ', error.message || error);
    res.status(500).json({ error: error.message || 'Server error checking transcriber status.' });
  }
};

// Get transcriber's negotiations - FIXED VERSION (will need further updates for nested client/transcriber data)
const getTranscriberNegotiations = async (req, res) => {
  try {
    const transcriberId = req.user.userId;

    console.log('Get transcriber negotiations for:', transcriberId);

    // FIX: Join with 'users' table to get all client and transcriber profile data
    const { data: negotiations, error: negotiationsError } = await supabase
      .from('negotiations')
      .select(`
        id,
        status,
        agreed_price_usd,
        requirements,
        deadline_hours,
        due_date,
        client_message,
        transcriber_response,
        negotiation_files,
        created_at,
        client_id,
        client:users!client_id (
            id,
            full_name,
            email,
            phone,
            client_average_rating,
            client_completed_jobs,
            client_comment
        ),
        transcriber:users!transcriber_id (
            id,
            full_name,
            email,
            phone,
            transcriber_status,
            transcriber_user_level,
            transcriber_average_rating,
            transcriber_completed_jobs,
            transcriber_mpesa_number,
            transcriber_paypal_email
        )
      `)
      .eq('transcriber_id', transcriberId)
      .order('created_at', { ascending: false });

    if (negotiationsError) {
      console.error('Transcriber negotiations query error:', negotiationsError);
      throw negotiationsError;
    }

    if (!negotiations || negotiations.length === 0) {
      return res.json({
        message: 'No negotiations found',
        negotiations: []
      });
    }

    // Restructure data to match frontend's expected format
    const negotiationsWithClients = negotiations.map(negotiation => {
        const { client, transcriber, ...rest } = negotiation; // Destructure client and transcriber data
        return {
            ...rest,
            client_info: client ? {
                id: client.id,
                full_name: client.full_name,
                email: client.email,
                phone: client.phone,
                client_rating: client.client_average_rating || 5.0, // Use client_average_rating
                client_completed_jobs: client.client_completed_jobs || 0, // NEW: client_completed_jobs
                client_comment: client.client_comment || null, // NEW: client_comment
            } : {
                id: negotiation.client_id,
                full_name: 'Unknown Client',
                email: 'unknown@example.com',
                client_rating: 5.0,
                client_completed_jobs: 0,
                client_comment: null,
            },
            transcriber_info: transcriber ? { // Include transcriber's own profile info if needed
                id: transcriber.id,
                full_name: transcriber.full_name,
                email: transcriber.email,
                phone: transcriber.phone,
                status: transcriber.transcriber_status,
                user_level: transcriber.transcriber_user_level,
                average_rating: transcriber.transcriber_average_rating || 0.0,
                completed_jobs: transcriber.transcriber_completed_jobs || 0,
                mpesa_number: transcriber.transcriber_mpesa_number,
                paypal_email: transcriber.transcriber_paypal_email,
            } : null // Transcriber info should always be present for transcriber's own negotiation list
        };
    });

    res.json({
      message: 'Transcriber negotiations retrieved successfully',
      negotiations: negotiationsWithClients
    });

  } catch (error) {
    console.error('Get transcriber negotiations error:', error);
    res.status(500).json({ error: error.message });
  }
};

// UPDATED: Accept Negotiation - Syncs availability status and emits events
const acceptNegotiation = async (req, res, next, io) => {
    const { negotiationId } = req.params;
    const transcriberId = req.user.userId;

    if (!negotiationId) {
        return res.status(400).json({ error: 'Negotiation ID is required.' });
    }

    try {
        // Fetch transcriber's current availability status from the 'users' table
        const { data: userProfile, error: fetchUserError } = await supabase
            .from('users')
            .select('is_available, current_job_id, transcriber_status') // FIX: Select transcriber_status for checks
            .eq('id', transcriberId)
            .eq('user_type', 'transcriber')
            .single();

        if (fetchUserError || !userProfile) {
            console.error(`[acceptNegotiation] Error fetching user profile for transcriber ${transcriberId}:`, fetchUserError);
            return res.status(404).json({ error: 'User profile not found.' });
        }

        // Check if the transcriber is active and available
        if (userProfile.transcriber_status !== 'active_transcriber') { // FIX: Check transcriber_status from 'users'
            return res.status(403).json({ error: 'You are not an active transcriber. Please complete your assessment.' });
        }
        if (!userProfile.is_available || userProfile.current_job_id) {
             return res.status(409).json({ error: 'You are currently busy or have an ongoing job. Please update your status before accepting a new job.' });
        }

        // Fetch negotiation details to verify assignment and current status
        const { data: negotiationToAccept, error: fetchNegError } = await supabase
            .from('negotiations')
            .select('client_id, status')
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId) // Ensure it's assigned to this transcriber
            .single();

        if (fetchNegError || !negotiationToAccept) {
            console.error(`[acceptNegotiation] Negotiation ${negotiationId} not found or not assigned to transcriber ${transcriberId}:`, fetchNegError);
            return res.status(404).json({ error: 'Negotiation not found or not assigned to you.' });
        }

        // Ensure the negotiation is in a 'pending' state before accepting
        if (negotiationToAccept.status !== 'pending') {
            return res.status(409).json({ error: 'Negotiation is no longer pending (it may have been accepted or deleted by the client). Current status: ' + negotiationToAccept.status });
        }

        // Update the negotiation status to 'accepted_awaiting_payment'
        const { error: negError, count } = await supabase
            .from('negotiations')
            .update({ status: 'accepted_awaiting_payment', updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .eq('status', 'pending')
            .select('*', { count: 'exact' });

        if (negError) {
            console.error(`[acceptNegotiation] Supabase error updating negotiation ${negotiationId} status:`, negError);
            throw negError;
        }

        if (count === 0) {
            return res.status(409).json({ error: 'Negotiation was not found, or its status is no longer pending. This could be a race, or the negotiation was already accepted/deleted.' });
        }

        // Send a real-time notification to the client about the acceptance
        if (io) {
            io.to(negotiationToAccept.client_id).emit('negotiation_accepted', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                message: `Your negotiation request (ID: ${negotiationId}) was accepted by a transcriber. Awaiting payment.`,
                newStatus: 'accepted_awaiting_payment'
            });
            console.log(`Emitted 'negotiation_accepted' to client ${negotiationToAccept.client_id}`);
        }

        res.status(200).json({
            message: 'Negotiation accepted successfully. Awaiting client payment.',
            jobId: negotiationId
        });

    } catch (error) {
        console.error('[acceptNegotiation] Error accepting negotiation:', error);
        res.status(500).json({ error: error.message || 'Server error accepting negotiation.' });
    }
};

// Reject Negotiation
const rejectNegotiation = async (req, res, next, io) => {
    const { negotiationId } = req.params;
    const transcriberId = req.user.userId;
    const transcriberResponse = req.body.transcriber_response || 'Transcriber rejected the offer.';

    if (!negotiationId) {
        return res.status(400).json({ error: 'Negotiation ID is required.' });
    }

    try {
        // Fetch negotiation details to verify assignment and current status
        const { data: negotiationToReject, error: fetchNegError } = await supabase
            .from('negotiations')
            .select('client_id, status')
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .single();

        if (fetchNegError || !negotiationToReject) {
            console.error(`[rejectNegotiation] Negotiation ${negotiationId} not found or not assigned to transcriber ${transcriberId}:`, fetchNegError);
            return res.status(404).json({ error: 'Negotiation not found or not assigned to you.' });
        }

        if (negotiationToReject.status !== 'pending') {
            return res.status(409).json({ error: 'Negotiation is no longer pending. Current status: ' + negotiationToReject.status });
        }

        const { error: negError, count } = await supabase
            .from('negotiations')
            .update({
                status: 'rejected',
                transcriber_response: transcriberResponse,
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .eq('status', 'pending')
            .select('*', { count: 'exact' });

        if (negError) {
            console.error(`[rejectNegotiation] Supabase error updating negotiation ${negotiationId} status:`, negError);
            throw negError;
        }

        if (count === 0) {
            return res.status(404).json({ error: 'Negotiation not found or not in pending status. This could be a race condition.' });
        }

        if (io) {
            io.to(negotiationToReject.client_id).emit('negotiation_rejected', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                message: `Your negotiation request (ID: ${negotiationId}) was rejected by a transcriber. Reason: ${transcriberResponse}`,
                newStatus: 'rejected'
            });
            console.log(`Emitted 'negotiation_rejected' to client ${negotiationToReject.client_id}`);
        }

        res.status(200).json({ message: 'Negotiation rejected successfully.' });

    } catch (error) {
        console.error('[rejectNegotiation] Error rejecting negotiation:', error);
        res.status(500).json({ error: error.message || 'Server error rejecting negotiation.' });
    }
};

// Counter Negotiation
const counterNegotiation = async (req, res, next, io) => {
    const { negotiationId } = req.params;
    const { proposed_price_usd, deadline_hours, transcriber_response } = req.body;
    const transcriberId = req.user.userId;

    if (!negotiationId || !proposed_price_usd || !deadline_hours) {
        return res.status(400).json({ error: 'Negotiation ID, proposed price, and deadline hours are required for a counter-offer.' });
    }

    const parsedPrice = parseFloat(proposed_price_usd);
    const parsedDeadline = parseInt(deadline_hours, 10);

    if (isNaN(parsedPrice) || parsedPrice <= 0 || isNaN(parsedDeadline) || parsedDeadline <= 0) {
        return res.status(400).json({ error: 'Proposed price and deadline hours must be positive numbers.' });
    }

    try {
        const { data: negotiationToCounter, error: fetchNegError } = await supabase
            .from('negotiations')
            .select('client_id, status')
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .single();

        if (fetchNegError || !negotiationToCounter) {
            console.error(`[counterNegotiation] Negotiation ${negotiationId} not found or not assigned to transcriber ${transcriberId}:`, fetchNegError);
            return res.status(404).json({ error: 'Negotiation not found or not assigned to you.' });
        }

        if (negotiationToCounter.status !== 'pending') {
            return res.status(409).json({ error: 'Negotiation is no longer pending. Current status: ' + negotiationToCounter.status });
        }

        const { error: negError, count } = await supabase
            .from('negotiations')
            .update({
                status: 'transcriber_counter',
                agreed_price_usd: parsedPrice,
                deadline_hours: parsedDeadline,
                transcriber_response: transcriber_response || `Transcriber proposed USD ${parsedPrice} with a ${parsedDeadline} hour deadline.`,
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .eq('status', 'pending')
            .select('*', { count: 'exact' });

        if (negError) {
            console.error(`[counterNegotiation] Supabase error updating negotiation ${negotiationId} status:`, negError);
            throw negError;
        }

        if (count === 0) {
            return res.status(404).json({ error: 'Negotiation not found or not in pending status. This could be a race condition.' });
        }

        if (io) {
            io.to(negotiationToCounter.client_id).emit('negotiation_countered', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                newPrice: parsedPrice,
                newDeadline: parsedDeadline,
                message: `Your negotiation request (ID: ${negotiationId}) received a counter-offer: USD ${parsedPrice}, ${parsedDeadline} hours. ${transcriber_response ? `Transcriber's message: ${transcriber_response}` : ''}`,
                newStatus: 'transcriber_counter'
            });
            console.log(`Emitted 'negotiation_countered' to client ${negotiationToCounter.client_id}`);
        }

        res.status(200).json({ message: 'Counter-offer submitted successfully. Awaiting client response.' });

    } catch (error) {
        console.error('Error submitting counter-offer:', error);
        res.status(500).json({ error: error.message || 'Server error submitting counter-offer' });
    }
};

// ADDED: Function to complete a job and make the transcriber available again
const completeJob = async (req, res, next, io) => {
    const { negotiationId } = req.params;
    const transcriberId = req.user.userId;

    if (!negotiationId) {
        return res.status(400).json({ error: 'Negotiation ID is required.' });
    }

    try {
        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('client_id, status')
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .single();

        if (fetchError || !negotiation) {
            console.error(`[completeJob] Negotiation ${negotiationId} not found or not assigned to transcriber ${transcriberId}:`, fetchError);
            return res.status(404).json({ error: 'Job not found or not assigned to you.' });
        }

        if (negotiation.status !== 'accepted' && negotiation.status !== 'hired' && negotiation.status !== 'accepted_awaiting_payment') {
            return res.status(409).json({ error: 'Job is not in an active state. Only active jobs can be marked complete. Current status: ' + negotiation.status });
        }

        const { error: updateError } = await supabase
            .from('negotiations')
            .update({
                status: 'completed',
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId);

        if (updateError) {
            console.error(`[completeJob] Supabase error updating negotiation ${negotiationId} status:`, updateError);
            throw updateError;
        }

        // --- UPDATED: Update payments record upon job completion ---
        // Find the payment record associated with this negotiation
        const { error: paymentUpdateError } = await supabase
            .from('payments')
            .update({ payout_status: 'pending', updated_at: new Date().toISOString() })
            .eq('negotiation_id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .eq('payout_status', 'awaiting_completion'); // Only update if still awaiting completion

        if (paymentUpdateError) {
            console.error(`[completeJob] Error updating payment record for negotiation ${negotiationId} to 'pending':`, paymentUpdateError);
            // Don't throw, just log, as job completion is primary.
        } else {
            console.log(`[completeJob] Payment record for negotiation ${negotiationId} updated to 'pending' payout status.`);
        }
        // --- END UPDATED: Update payments record upon job completion ---


        // UPDATED: Sync availability status - make transcriber available again and clear current job ID
        await syncAvailabilityStatus(transcriberId, true, null);

        if (io) {
            io.to(negotiation.client_id).emit('job_completed', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                message: `Your transcription job (ID: ${negotiationId}) has been completed!`,
                newStatus: 'completed'
            });
            console.log(`Emitted 'job_completed' to client ${negotiation.client_id}`);
        }

        res.status(200).json({
            message: 'Job marked as completed successfully. You are now available for new jobs.',
        });

    } catch (error) {
        console.error('[completeJob] Error completing job:', error);
        res.status(500).json({ error: error.message || 'Server error completing job.' });
    }
};

// NEW: Function to get a transcriber's upcoming payouts (This function will be removed in favor of paymentController's getTranscriberPaymentHistory)
const getTranscriberUpcomingPayouts = async (req, res) => {
    const transcriberId = req.user.userId;

    try {
        // Fetch all pending payouts for this transcriber from the 'payments' table
        const { data: payments, error } = await supabase
            .from('payments')
            .select(`
                id,
                negotiation_id,
                direct_upload_job_id,
                amount,
                transcriber_earning,
                currency,
                payout_status,
                transaction_date,
                negotiation:negotiation_id(requirements, client_id, client:users!client_id(full_name)),
                direct_upload_job:direct_upload_job_id(client_instructions, client_id, client:users!client_id(full_name))
            `)
            .eq('transcriber_id', transcriberId)
            .eq('payout_status', 'pending') // Fetch payments awaiting payout
            .order('transaction_date', { ascending: true });

        if (error) {
            console.error(`[getTranscriberUpcomingPayouts] Supabase error fetching payments for transcriber ${transcriberId}:`, error);
            throw error;
        }

        const groupedPayouts = {};
        let totalUpcomingPayouts = 0;

        (payments || []).forEach(payment => {
            const transactionDate = new Date(payment.transaction_date);
            const dayOfWeek = transactionDate.getDay(); 
            const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
            
            const weekEndingDate = new Date(transactionDate);
            weekEndingDate.setDate(transactionDate.getDate() + daysUntilFriday);
            weekEndingDate.setHours(23, 59, 59, 999); 
            const weekEndingString = weekEndingDate.toISOString().split('T')[0]; 

            if (!groupedPayouts[weekEndingString]) {
                groupedPayouts[weekEndingString] = {
                    date: weekEndingString,
                    totalAmount: 0,
                    payouts: []
                };
            }
            groupedPayouts[weekEndingString].totalAmount += payment.transcriber_earning;
            groupedPayouts[weekEndingString].payouts.push({
                id: payment.id,
                negotiation_id: payment.negotiation_id,
                direct_upload_job_id: payment.direct_upload_job_id,
                amount: payment.transcriber_earning,
                currency: payment.currency,
                status: payment.payout_status, 
                clientName: payment.negotiation?.client?.full_name || payment.direct_upload_job?.client?.full_name || 'N/A',
                jobRequirements: payment.negotiation?.requirements || payment.direct_upload_job?.client_instructions || 'N/A',
                created_at: new Date(payment.transaction_date).toLocaleDateString()
            });
            totalUpcomingPayouts += payment.transcriber_earning;
        });

        const upcomingPayoutsArray = Object.values(groupedPayouts).sort((a, b) => new Date(a.date) - new Date(b.date));


        res.status(200).json({
            message: 'Upcoming payouts retrieved successfully.',
            upcomingPayouts: upcomingPayoutsArray,
            totalUpcomingPayouts: totalUpcomingPayouts,
        });

    } catch (error) {
        console.error('[getTranscriberUpcomingPayouts] Error fetching upcoming payouts:', error);
        res.status(500).json({ error: error.message || 'Server error fetching upcoming payouts.! ' });
    }
};


// NEW: Function for transcribers to update their profile (including payment details)
const updateTranscriberProfile = async (req, res) => {
    const { userId } = req.params;
    const { transcriber_mpesa_number, transcriber_paypal_email, transcriber_status, transcriber_user_level } = req.body; // FIX: Destructure new fields
    const currentUserId = req.user.userId;

    if (userId !== currentUserId && req.user.userType !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized to update this transcriber profile.' });
    }

    try {
        // Prepare update data for the 'users' table
        const userUpdateData = { updated_at: new Date().toISOString() };
        if (transcriber_mpesa_number !== undefined) userUpdateData.transcriber_mpesa_number = transcriber_mpesa_number;
        if (transcriber_paypal_email !== undefined) userUpdateData.transcriber_paypal_email = transcriber_paypal_email;
        if (transcriber_status !== undefined) userUpdateData.transcriber_status = transcriber_status; // NEW: Update transcriber_status
        if (transcriber_user_level !== undefined) userUpdateData.transcriber_user_level = transcriber_user_level; // NEW: Update transcriber_user_level

        // Update the 'users' table and select relevant fields to return
        const { data: updatedUser, error } = await supabase
            .from('users')
            .update(userUpdateData)
            .eq('id', userId)
            .eq('user_type', 'transcriber') // Ensure this is for a transcriber
            .select('*') // Select all updated columns to return the full user object
            .single();

        if (error) throw error;
        if (!updatedUser) return res.status(404).json({ error: 'Transcriber user not found or not a transcriber.' });

        // No need to update 'transcribers' table for profile data anymore.

        const { password_hash, ...userWithoutPasswordHash } = updatedUser; // Remove password_hash for security

        res.status(200).json({
            message: 'Transcriber profile updated successfully.',
            profile: userWithoutPasswordHash // Return the full updated user object
        });

    } catch (error) {
        console.error('Error updating transcriber profile:', error);
        res.status(500).json({ error: 'Server error updating transcriber profile.' });
    }
};


module.exports = {
  submitTest,
  checkTestStatus,
  // --- Export Negotiation Actions ---
  getTranscriberNegotiations,
  acceptNegotiation,
  rejectNegotiation,
  counterNegotiation,
  completeJob, // NEW: Added completeJob function
  syncAvailabilityStatus, // NEW: Export utility function for other controllers to use
  setOnlineStatus, // NEW: Export the setOnlineStatus function
  updateTranscriberProfile, // NEW: Export updateTranscriberProfile
  getTranscriberUpcomingPayouts, // NEW: Export the new function
};
