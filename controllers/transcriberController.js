const supabase = require('..//database');
const path = require('path');
const fs = require('fs');
const emailService = require('..//emailService');
const { updateAverageRating } = require('./ratingController'); // This will also need updating later
const { calculateTranscriberEarning } = require('..//utils/paymentUtils'); // Import calculateTranscriberEarning
const { getNextFriday } = require('..//utils/paymentUtils'); // Import getNextFriday

// Utility function to sync availability status (updates 'users' table only)
const syncAvailabilityStatus = async (userId, isAvailable, currentJobId = null) => {
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
        // FIX: Only update 'users' table for is_online
        const { data, error } = await supabase
            .from('users')
            .update({ is_online: isOnline, updated_at: new Date().toISOString() })
            .eq('id', userId)
            .eq('user_type', 'transcriber'); // Ensure this only affects transcriber records

        if (error) {
            console.error(`[setOnlineStatus] Supabase error setting online status for user ${userId} to ${isOnline}:`, error);
            throw error;
        }
        console.log(`[setOnlineStatus] User ${userId} is_online status successfully set to ${isOnline}. Supabase response data:`, data);

        // NEW LOGIC: When a transcriber goes online, ensure their availability status is correct.
        // If they are online and not assigned to a job, they should be available.
        if (isOnline) {
            // Fetch current availability status from the USERS table
            const { data: userProfile, error: fetchUserError } = await supabase
                .from('users')
                .select('is_available, current_job_id') // Check primary availability flags
                .eq('id', userId)
                .single();

            if (fetchUserError) {
                console.error(`[setOnlineStatus] Error fetching user profile for availability check on login for ${userId}:`, fetchUserError);
                // Don't throw, just log and continue, as setting online status was successful.
            } else if (userProfile) {
                // If they are not available AND not assigned to a job (inconsistent state), make them available.
                // This handles cases where is_available was incorrectly left as FALSE from a previous session or bug.
                if (!userProfile.is_available && !userProfile.current_job_id) {
                    await syncAvailabilityStatus(userId, true, null);
                    console.log(`[setOnlineStatus] Corrected inconsistent availability status for user ${userId} on login: set is_available=TRUE, current_job_id=NULL.`);
                }
            }
        }

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

        // --- NEW: Create transcriber_payouts record upon job completion ---
        const { data: paymentRecord, error: paymentFetchError } = await supabase
            .from('payments')
            .select('id, transcriber_id, negotiation_id, amount, transcriber_earning, currency')
            .eq('negotiation_id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .eq('payout_status', 'awaiting_completion')
            .single();

        if (paymentFetchError || !paymentRecord) {
            console.error(`[completeJob] Error fetching payment record for negotiation ${negotiationId} to create payout:`, paymentFetchError);
        } else {
            const { data: payoutRecord, error: payoutError } = await supabase
                .from('transcriber_payouts')
                .insert([
                    {
                        transcriber_id: paymentRecord.transcriber_id,
                        payment_id: paymentRecord.id,
                        negotiation_id: paymentRecord.negotiation_id,
                        amount: paymentRecord.transcriber_earning,
                        currency: paymentRecord.currency,
                        status: 'pending',
                        due_date: getNextFriday(),
                    }
                ])
                .select()
                .single();

            if (payoutError) {
                console.error(`[completeJob] Error recording transcriber payout for negotiation ${negotiationId}:`, payoutError);
            } else {
                console.log(`[completeJob] Recorded payout for transcriber ${paymentRecord.transcriber_id}:`, payoutRecord);
                await supabase.from('payments').update({ payout_status: 'pending' }).eq('id', paymentRecord.id);
            }
        }
        // --- END NEW: Create transcriber_payouts record upon job completion ---


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

// NEW: Function to get a transcriber's upcoming payouts
const getTranscriberUpcomingPayouts = async (req, res) => {
    const transcriberId = req.user.userId;

    try {
        // Fetch all pending payouts for this transcriber, ordered by due date
        const { data: payouts, error } = await supabase
            .from('transcriber_payouts')
            .select(`
                id,
                negotiation_id,
                amount,
                currency,
                status,
                due_date,
                created_at,
                negotiation:negotiations(requirements, client_id, client:users!client_id(full_name))
            `)
            .eq('transcriber_id', transcriberId)
            .eq('status', 'pending')
            .order('due_date', { ascending: true });

        if (error) {
            console.error(`[getTranscriberUpcomingPayouts] Supabase error fetching payouts for transcriber ${transcriberId}:`, error);
            throw error;
        }

        // Group payouts by payout_week_end_date (due_date) and calculate weekly totals
        const groupedPayouts = {};
        let totalUpcomingPayouts = 0;

        (payouts || []).forEach(payout => {
            const weekEndDate = new Date(payout.due_date).toLocaleDateString();
            if (!groupedPayouts[weekEndDate]) {
                groupedPayouts[weekEndDate] = {
                    date: weekEndDate,
                    totalAmount: 0,
                    payouts: []
                };
            }
            groupedPayouts[weekEndDate].totalAmount += payout.amount;
            groupedPayouts[weekEndDate].payouts.push({
                id: payout.id,
                negotiation_id: payout.negotiation_id,
                amount: payout.amount,
                currency: payout.currency,
                status: payout.status,
                clientName: payout.negotiation?.client?.full_name || 'N/A',
                jobRequirements: payout.negotiation?.requirements || 'N/A',
                created_at: new Date(payout.created_at).toLocaleDateString()
            });
            totalUpcomingPayouts += payout.amount;
        });

        // Convert groupedPayouts object to an array and sort by date
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
