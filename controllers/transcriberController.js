const supabase = require('../database');
const path = require('path'); // Corrected: Ensure 'path' is correctly required
const fs = require('fs');
const emailService = require('../emailService'); // Make sure this path is correct
const { updateAverageRating } = require('./ratingController'); // NEW: Import updateAverageRating (if not already)

// Utility function to sync availability status between 'users' and 'transcribers' tables
const syncAvailabilityStatus = async (userId, isAvailable, currentJobId = null) => {
    const updateData = {
        is_available: isAvailable,
        current_job_id: currentJobId,
        updated_at: new Date().toISOString()
    };

    // Update 'users' table (primary source for availability status)
    const { error: userError } = await supabase
        .from('users')
        .update(updateData)
        .eq('id', userId);

    // Also update 'transcribers' table for consistency, though 'users' table is primary
    const { error: transcriberError } = await supabase
        .from('transcribers')
        .update(updateData)
        .eq('id', userId);

    if (userError) {
        console.error(`Supabase error updating user availability for ${userId}:`, userError);
        throw userError;
    }
    if (transcriberError) {
        // Log as a warning as the primary update might have succeeded
        console.warn(`Transcribers table availability sync warning for ${userId}:`, transcriberError);
    }
};

// NEW: Function to set a transcriber's online status in the 'users' table
const setOnlineStatus = async (userId, isOnline) => {
    try {
        const { error } = await supabase
            .from('users')
            .update({ is_online: isOnline, updated_at: new Date().toISOString() })
            .eq('id', userId)
            .eq('user_type', 'transcriber'); // Ensure this only affects transcriber records

        if (error) {
            console.error(`Error setting online status for user ${userId} to ${isOnline}:`, error);
            throw error;
        }
        console.log(`User ${userId} is_online status set to ${isOnline}.`);

        // If going offline, also set is_available to false and clear current_job_id for consistency
        if (!isOnline) {
            await syncAvailabilityStatus(userId, false, null);
            console.log(`User ${userId} set to unavailable and current job cleared due to going offline.`);
        }

    } catch (error) {
        console.error('setOnlineStatus error:', error);
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

    // Fetch transcriber status and profile details from the 'transcribers' table
    const { data: transcriberProfile, error: profileError } = await supabase
      .from('transcribers') // Query the 'transcribers' table
      .select('status, user_level, mpesa_number, paypal_email') // Include payment details
      .eq('id', userId) // The 'id' in transcribers table corresponds to the user's ID
      .single();

    if (profileError || !transcriberProfile) {
        console.error('Transcriber profile not found for user:', userId, profileError);
        return res.status(404).json({ error: 'Transcriber profile not found for this user.' });
    }

    // Fetch the latest test submission for the user
    const { data: testSubmission, error: testSubmissionError } = await supabase
      .from('test_submissions')
      .select('*') // Select all columns for the submission
      .eq('user_id', userId) // Correctly query by user_id in test_submissions
      .single();

    // Handle case where no test submission is found (PGRST116 is the Supabase error code for "no rows found")
    if (testSubmissionError && testSubmissionError.code !== 'PGRST116') {
      throw testSubmissionError; // Throw error if it's not a "not found" error
    }

    // Return the combined information
    res.json({
      user_status: transcriberProfile.status, // Status from transcriber profile (e.g., pending_assessment, active_transcriber)
      user_level: transcriberProfile.user_level, // e.g., 'transcriber'
      mpesa_number: transcriberProfile.mpesa_number, // Include payment details
      paypal_email: transcriberProfile.paypal_email, // Include payment details
      test_submission: testSubmission || null, // Ensure it's null if no submission found
      has_submitted_test: !!testSubmission // Boolean indicating if a test has been submitted
    });

  } catch (error) {
    console.error('Check test status error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get transcriber's negotiations - FIXED VERSION
const getTranscriberNegotiations = async (req, res) => {
  try {
    const transcriberId = req.user.userId;

    console.log('Get transcriber negotiations for:', transcriberId);

    // Fetch negotiations associated with the transcriber, joining with client details from the 'users' table
    const { data: negotiations, error: negotiationsError } = await supabase
      .from('negotiations')
      .select(`
        id,
        status,
        agreed_price_kes,
        requirements,
        deadline_hours,
        client_message,
        transcriber_response,
        negotiation_files,
        created_at,
        client_id,
        client:users!client_id (
            id,
            full_name,
            email
        )
      `) // Removed the embedded comment here
      .eq('transcriber_id', transcriberId)
      .order('created_at', { ascending: false }); // Order by creation date, newest first

    if (negotiationsError) {
      console.error('Transcriber negotiations query error:', negotiationsError);
      throw negotiationsError;
    }

    // Handle case where no negotiations are found
    if (!negotiations || negotiations.length === 0) {
      return res.json({
        message: 'No negotiations found',
        negotiations: []
      });
    }

    // Restructure data to match frontend's expected format, ensuring client info is nested correctly
    const negotiationsWithClients = negotiations.map(negotiation => {
        const { client, ...rest } = negotiation; // Destructure to separate client info
        return {
            ...rest, // Include all negotiation details
            client_info: client ? { // Nest client details under 'client_info'
                id: client.id,
                full_name: client.full_name,
                client_rating: 5.0, // Default rating since we don't have this in users table here
                email: client.email,
            } : { // Fallback if client data is missing
                id: negotiation.client_id,
                full_name: 'Unknown Client',
                client_rating: 5.0,
                email: 'unknown@example.com',
            }
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
            .select('is_available, current_job_id') // Check primary availability flags
            .eq('id', transcriberId)
            .eq('user_type', 'transcriber')
            .single();

        if (fetchUserError || !userProfile) {
            return res.status(404).json({ error: 'User profile not found.' });
        }

        // Check if the transcriber is already busy or manually unavailable
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
            return res.status(404).json({ error: 'Negotiation not found or not assigned to you.' });
        }

        // Ensure the negotiation is in a 'pending' state before accepting
        if (negotiationToAccept.status !== 'pending') {
            return res.status(409).json({ error: 'Negotiation is no longer pending (it may have been accepted or deleted by the client).' });
        }

        // Update the negotiation status to 'accepted' (or 'accepted_awaiting_payment' if that's the next step)
        const { error: negError, count } = await supabase
            .from('negotiations')
            .update({ status: 'accepted', updated_at: new Date().toISOString() }) // Changed status to 'accepted'
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .eq('status', 'pending') // Conditional update based on current status
            .select('*', { count: 'exact' }); // Use select with count to check if update affected a row

        if (negError) throw negError;

        // Check if the update actually affected a row (handles race conditions)
        if (count === 0) {
            return res.status(409).json({ error: 'Negotiation was not found, or its status is no longer pending. This could be a race condition.' });
        }

        // Step 3: Update transcriber's status to busy (unavailable) with the current job ID
        await syncAvailabilityStatus(transcriberId, false, negotiationId); // Set is_available to false and assign current_job_id

        // Send a real-time notification to the client about the acceptance
        if (io) {
            io.to(negotiationToAccept.client_id).emit('negotiation_accepted', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                message: `Your negotiation request (ID: ${negotiationId}) was accepted by a transcriber.`,
                newStatus: 'accepted' // Inform frontend of the status change
            });
            console.log(`Emitted 'negotiation_accepted' to client ${negotiationToAccept.client_id}`);
        }

        res.status(200).json({
            message: 'Negotiation accepted successfully. You are now busy with this job.',
            jobId: negotiationId
        });

    } catch (error) {
        console.error('Error accepting negotiation:', error);
        res.status(500).json({ error: error.message });
    }
};

// Reject Negotiation
const rejectNegotiation = async (req, res, next, io) => {
    const { negotiationId } = req.params;
    const transcriberId = req.user.userId;
    const transcriberResponse = req.body.transcriber_response || 'Transcriber rejected the offer.'; // Default rejection reason

    if (!negotiationId) {
        return res.status(400).json({ error: 'Negotiation ID is required.' });
    }

    try {
        // Fetch negotiation details to verify assignment and current status
        const { data: negotiationToReject, error: fetchNegError } = await supabase
            .from('negotiations')
            .select('client_id, status')
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId) // Ensure it's assigned to this transcriber
            .single();

        if (fetchNegError || !negotiationToReject) {
            return res.status(404).json({ error: 'Negotiation not found or not assigned to you.' });
        }

        // Ensure the negotiation is in a 'pending' state before rejection
        if (negotiationToReject.status !== 'pending') {
            return res.status(409).json({ error: 'Negotiation is no longer pending.' });
        }

        // Update negotiation status to 'rejected' and store the transcriber's response
        const { error: negError, count } = await supabase
            .from('negotiations')
            .update({
                status: 'rejected',
                transcriber_response: transcriberResponse, // Store the rejection reason
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .eq('status', 'pending') // Conditional update
            .select('*', { count: 'exact' });

        if (negError) throw negError;

        if (count === 0) {
            return res.status(404).json({ error: 'Negotiation not found or not in pending status.' });
        }

        // Send a real-time notification to the client about the rejection
        if (io) {
            io.to(negotiationToReject.client_id).emit('negotiation_rejected', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                message: `Your negotiation request (ID: ${negotiationId}) was rejected by a transcriber. Reason: ${transcriberResponse}`,
                newStatus: 'rejected' // Inform frontend of the status change
            });
            console.log(`Emitted 'negotiation_rejected' to client ${negotiationToReject.client_id}`);
        }

        res.status(200).json({ message: 'Negotiation rejected successfully.' });

    } catch (error) {
        console.error('Error rejecting negotiation:', error);
        res.status(500).json({ error: error.message });
    }
};

// Counter Negotiation
const counterNegotiation = async (req, res, next, io) => {
    const { negotiationId } = req.params;
    const { proposed_price_kes, deadline_hours, transcriber_response } = req.body;
    const transcriberId = req.user.userId;

    // Validate input fields
    if (!negotiationId || !proposed_price_kes || !deadline_hours) {
        return res.status(400).json({ error: 'Negotiation ID, proposed price, and deadline hours are required for a counter-offer.' });
    }

    // Parse and validate numeric inputs
    const parsedPrice = parseFloat(proposed_price_kes);
    const parsedDeadline = parseInt(deadline_hours, 10);

    if (isNaN(parsedPrice) || parsedPrice <= 0 || isNaN(parsedDeadline) || parsedDeadline <= 0) {
        return res.status(400).json({ error: 'Proposed price and deadline hours must be positive numbers.' });
    }

    try {
        // Fetch negotiation details to verify assignment and current status
        const { data: negotiationToCounter, error: fetchNegError } = await supabase
            .from('negotiations')
            .select('client_id, status')
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId) // Ensure it's assigned to this transcriber
            .single();

        if (fetchNegError || !negotiationToCounter) {
            return res.status(404).json({ error: 'Negotiation not found or not assigned to you.' });
        }

        // Ensure the negotiation is in a 'pending' state before countering
        if (negotiationToCounter.status !== 'pending') {
            return res.status(409).json({ error: 'Negotiation is no longer pending.' });
        }

        // Update negotiation with counter-offer details and set status to 'transcriber_counter'
        const { error: negError, count } = await supabase
            .from('negotiations')
            .update({
                status: 'transcriber_counter', // Status indicating transcriber's counter-offer
                agreed_price_kes: parsedPrice,
                deadline_hours: parsedDeadline,
                transcriber_response: transcriber_response || `Transcriber proposed KES ${parsedPrice} with a ${parsedDeadline} hour deadline.`, // Store the response/message
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .eq('status', 'pending') // Conditional update
            .select('*', { count: 'exact' });

        if (negError) throw negError;

        if (count === 0) {
            return res.status(404).json({ error: 'Negotiation not found or not in pending status.' });
        }

        // Send a real-time notification to the client about the counter-offer
        if (io) {
            io.to(negotiationToCounter.client_id).emit('negotiation_countered', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                newPrice: parsedPrice,
                newDeadline: parsedDeadline,
                message: `Your negotiation request (ID: ${negotiationId}) received a counter-offer: KES ${parsedPrice}, ${parsedDeadline} hours. ${transcriber_response ? `Transcriber's message: ${transcriber_response}` : ''}`,
                newStatus: 'transcriber_counter' // Indicate the new status
            });
            console.log(`Emitted 'negotiation_countered' to client ${negotiationToCounter.client_id}`);
        }

        res.status(200).json({ message: 'Counter-offer submitted successfully. Awaiting client response.' });

    } catch (error) {
        console.error('Error submitting counter-offer:', error);
        res.status(500).json({ error: 'Server error submitting counter-offer' });
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
        // Verify the negotiation belongs to this transcriber and is in an active state ('accepted' or 'hired')
        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('client_id, status')
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Job not found or not assigned to you.' });
        }

        // Check if the job is in a state that can be completed
        if (negotiation.status !== 'accepted' && negotiation.status !== 'hired') {
            return res.status(409).json({ error: 'Job is not in an active state. Only active jobs can be marked complete.' });
        }

        // Update negotiation status to 'completed'
        const { error: updateError } = await supabase
            .from('negotiations')
            .update({
                status: 'completed',
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId);

        if (updateError) throw updateError;

        // UPDATED: Sync availability status - make transcriber available again and clear current job ID
        await syncAvailabilityStatus(transcriberId, true, null); // Set is_available to true, clear current_job_id

        // Send a real-time notification to the client that the job is completed
        if (io) {
            io.to(negotiation.client_id).emit('job_completed', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                message: `Your transcription job (ID: ${negotiationId}) has been completed!`,
                newStatus: 'completed' // Indicate the new status
            });
            console.log(`Emitted 'job_completed' to client ${negotiation.client_id}`);
        }

        res.status(200).json({
            message: 'Job marked as completed successfully. You are now available for new jobs.',
        });

    } catch (error) {
        console.error('Error completing job:', error);
        res.status(500).json({ error: error.message });
    }
};

// NEW: Function for transcribers to update their profile (including payment details)
const updateTranscriberProfile = async (req, res) => {
    const { userId } = req.params; // ID of the profile to update
    const { mpesa_number, paypal_email } = req.body;
    const currentUserId = req.user.userId; // User making the request (from JWT)

    // Authorization check: User must be the owner or an admin
    if (userId !== currentUserId && req.user.userType !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized to update this transcriber profile.' });
    }

    try {
        // Prepare update data, including only fields that are provided
        const updateData = { updated_at: new Date().toISOString() };
        if (mpesa_number !== undefined) updateData.mpesa_number = mpesa_number;
        if (paypal_email !== undefined) updateData.paypal_email = paypal_email;

        // Update the 'transcribers' table and select relevant fields to return
        const { data, error } = await supabase
            .from('transcribers')
            .update(updateData)
            .eq('id', userId)
            .select('id, mpesa_number, paypal_email, average_rating, completed_jobs, badges, user_level, status') // Select fields to return
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Transcriber profile not found.' });

        res.status(200).json({
            message: 'Transcriber profile updated successfully.',
            profile: data // Return the updated profile data
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
  updateTranscriberProfile // NEW: Export updateTranscriberProfile
};
