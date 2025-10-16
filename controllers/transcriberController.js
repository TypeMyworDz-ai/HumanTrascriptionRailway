// backend/controllers/transcriberController.js - Part 1 - UPDATED with users table sync

const supabase = require('../database');
const path = require('path');
const fs = require('fs');
const emailService = require('../emailService'); // Make sure this path is correct

// Utility function to sync availability status between tables
const syncAvailabilityStatus = async (userId, isAvailable, currentJobId = null) => {
    const updateData = {
        is_available: isAvailable,
        current_job_id: currentJobId,
        updated_at: new Date().toISOString()
    };

    // Update users table (primary source)
    const { error: userError } = await supabase
        .from('users')
        .update(updateData)
        .eq('id', userId);

    // Update transcribers table (backup for compatibility)
    const { error: transcriberError } = await supabase
        .from('transcribers')
        .update(updateData)
        .eq('id', userId);

    if (userError) throw userError;
    if (transcriberError) console.warn('Transcribers table sync warning:', transcriberError);
};

// Submit transcriber test
const submitTest = async (req, res) => {
  try {
    const { grammar_score, transcription_text } = req.body;
    const userId = req.user.userId; // Assuming userId is available from auth middleware

    const { data: existingTest } = await supabase
      .from('test_submissions')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (existingTest) {
      return res.status(400).json({ error: 'Test already submitted' });
    }

    const { data, error } = await supabase
      .from('test_submissions')
      .insert([
        {
          user_id: userId,
          grammar_score: grammar_score,
          transcription_text: transcription_text,
          status: 'pending'
        }
      ])
      .select();

    if (error) throw error;

    res.status(201).json({
      message: 'Test submitted successfully',
      submission: data[0]
    });

    // --- SENDING THE TEST SUBMITTED EMAIL ---
    // Fetch user details if not fully available in req.user
    let userDetails = req.user; // Assume userId, email, full_name are available
    if (!userDetails || !userDetails.email) {
        // Fallback: Fetch user details from Supabase if not in req.user
        const { data: fetchedUser } = await supabase
            .from('users')
            .select('id, email, full_name')
            .eq('id', userId)
            .single();
        userDetails = fetchedUser;
    }

    if (userDetails && userDetails.email) {
        await emailService.sendTranscriberTestSubmittedEmail(userDetails);
    }
    // --- END OF EMAIL INTEGRATION ---

  } catch (error) {
    console.error('Test submission error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Check test status
const checkTestStatus = async (req, res) => {
  try {
    const userId = req.user.userId;

    // IMPORTANT FIX: Fetch status and user_level from the 'transcribers' table
    const { data: transcriberProfile, error: profileError } = await supabase
      .from('transcribers') // Query 'transcribers' table
      .select('status, user_level')
      .eq('id', userId) // The 'id' in transcribers table is the user's ID
      .single();

    if (profileError || !transcriberProfile) {
        console.error('Transcriber profile not found for user:', userId, profileError);
        return res.status(404).json({ error: 'Transcriber profile not found for this user.' });
    }

    const { data: testSubmission, error: testSubmissionError } = await supabase
      .from('test_submissions')
      .select('*')
      .eq('user_id', userId) // Correctly query by user_id in test_submissions
      .single();

    if (testSubmissionError && testSubmissionError.code !== 'PGRST116') { // PGRST116 = no rows found
      throw testSubmissionError;
    }

    res.json({
      user_status: transcriberProfile.status, // Get from transcriber profile
      user_level: transcriberProfile.user_level, // Get from transcriber profile
      test_submission: testSubmission || null, // CRITICAL FIX: Ensure it's null if not found
      has_submitted_test: !!testSubmission
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

    // FIXED: Use users table instead of clients table
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
        const { client, ...rest } = negotiation;
        return {
            ...rest,
            client_info: client ? {
                id: client.id,
                full_name: client.full_name,
                client_rating: 5.0, // Default rating since we don't have this in users table
                email: client.email,
            } : {
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

// UPDATED: Accept Negotiation with users table synchronization
const acceptNegotiation = async (req, res, next, io) => {
    const { negotiationId } = req.params;
    const transcriberId = req.user.userId;

    if (!negotiationId) {
        return res.status(400).json({ error: 'Negotiation ID is required.' });
    }

    try {
        // UPDATED: Check transcriber availability from the users table (primary source)
        const { data: userProfile, error: fetchUserError } = await supabase
            .from('users')
            .select('is_available, is_online')
            .eq('id', transcriberId)
            .eq('user_type', 'transcriber')
            .single();

        if (fetchUserError || !userProfile) {
            return res.status(404).json({ error: 'User profile not found.' });
        }

        if (!userProfile.is_available || !userProfile.is_online) {
             return res.status(409).json({ error: 'You are currently offline or busy. Please update your status before accepting a job.' });
        }

        // Fetch the negotiation details before updating to get client_id
        const { data: negotiationToAccept, error: fetchNegError } = await supabase
            .from('negotiations')
            .select('client_id, status')
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .single();

        if (fetchNegError || !negotiationToAccept) {
            return res.status(404).json({ error: 'Negotiation not found or not assigned to you.' });
        }

        if (negotiationToAccept.status !== 'pending') {
            return res.status(409).json({ error: 'Negotiation is no longer pending (it may have been accepted or deleted by the client).' });
        }

        // Step 2: Update the negotiation status to 'accepted'
        const { error: negError, count } = await supabase
            .from('negotiations')
            .update({ status: 'accepted', updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .eq('status', 'pending')
            .select('*', { count: 'exact' });

        if (negError) throw negError;

        if (count === 0) {
            return res.status(409).json({ error: 'Negotiation was not found, or its status is no longer pending (it may have been accepted or deleted by the client).' });
        }

        // Step 3: UPDATED - Sync availability status in BOTH tables
        await syncAvailabilityStatus(transcriberId, false, negotiationId);

        // Send notification to client that the negotiation was accepted.
        if (io) {
            io.to(negotiationToAccept.client_id).emit('negotiation_accepted', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                message: `Your negotiation request (ID: ${negotiationId}) was accepted by a transcriber.`
            });
            console.log(`Emitted 'negotiation_accepted' to client ${negotiationToAccept.client_id}`);
        }

        res.status(200).json({
            message: 'Negotiation accepted successfully. Job started.',
            jobId: negotiationId
        });

    } catch (error) {
        console.error('Error accepting negotiation:', error);
        res.status(500).json({ error: error.message });
    }
};
// backend/controllers/transcriberController.js - Part 2 (Continue from Part 1)

// Reject Negotiation
const rejectNegotiation = async (req, res, next, io) => {
    const { negotiationId } = req.params;
    const transcriberId = req.user.userId;
    const transcriberResponse = req.body.transcriber_response || 'Transcriber rejected the offer.';

    if (!negotiationId) {
        return res.status(400).json({ error: 'Negotiation ID is required.' });
    }

    try {
        // Fetch the negotiation details before updating to get client_id
        const { data: negotiationToReject, error: fetchNegError } = await supabase
            .from('negotiations')
            .select('client_id, status')
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .single();

        if (fetchNegError || !negotiationToReject) {
            return res.status(404).json({ error: 'Negotiation not found or not assigned to you.' });
        }

        if (negotiationToReject.status !== 'pending') {
            return res.status(409).json({ error: 'Negotiation is no longer pending.' });
        }

        // Update negotiation status to 'rejected'
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

        if (negError) throw negError;

        if (count === 0) {
            return res.status(404).json({ error: 'Negotiation not found or not in pending status.' });
        }

        // Send notification to client that the negotiation was rejected.
        if (io) {
            io.to(negotiationToReject.client_id).emit('negotiation_rejected', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                message: `Your negotiation request (ID: ${negotiationId}) was rejected by a transcriber. Reason: ${transcriberResponse}`
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

    if (!negotiationId || !proposed_price_kes || !deadline_hours) {
        return res.status(400).json({ error: 'Negotiation ID, proposed price, and deadline hours are required.' });
    }

    const parsedPrice = parseFloat(proposed_price_kes);
    const parsedDeadline = parseInt(deadline_hours, 10);

    if (isNaN(parsedPrice) || parsedPrice <= 0 || isNaN(parsedDeadline) || parsedDeadline <= 0) {
        return res.status(400).json({ error: 'Proposed price and deadline hours must be positive numbers.' });
    }

    try {
        // Fetch the negotiation details before updating to get client_id
        const { data: negotiationToCounter, error: fetchNegError } = await supabase
            .from('negotiations')
            .select('client_id, status')
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .single();

        if (fetchNegError || !negotiationToCounter) {
            return res.status(404).json({ error: 'Negotiation not found or not assigned to you.' });
        }

        if (negotiationToCounter.status !== 'pending') {
            return res.status(409).json({ error: 'Negotiation is no longer pending.' });
        }

        // Update negotiation with new counter values and set status to 'transcriber_counter'
        const { error: negError, count } = await supabase
            .from('negotiations')
            .update({
                status: 'transcriber_counter',
                agreed_price_kes: parsedPrice,
                deadline_hours: parsedDeadline,
                transcriber_response: transcriber_response || `Transcriber proposed KES ${parsedPrice} with a ${parsedDeadline} hour deadline.`,
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .eq('status', 'pending')
            .select('*', { count: 'exact' });

        if (negError) throw negError;

        if (count === 0) {
            return res.status(404).json({ error: 'Negotiation not found or not in pending status.' });
        }

        // Send notification to client about the counter-offer.
        if (io) {
            io.to(negotiationToCounter.client_id).emit('negotiation_countered', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                newPrice: parsedPrice,
                newDeadline: parsedDeadline,
                message: `Your negotiation request (ID: ${negotiationId}) received a counter-offer: KES ${parsedPrice}, ${parsedDeadline} hours. ${transcriber_response ? `Transcriber's message: ${transcriber_response}` : ''}`
            });
            console.log(`Emitted 'negotiation_countered' to client ${negotiationToCounter.client_id}`);
        }

        res.status(200).json({ message: 'Counter-offer submitted successfully. Awaiting client response.' });

    } catch (error) {
        console.error('Error submitting counter-offer:', error);
        res.status(500).json({ error: 'Server error submitting counter-offer' });
    }
};

// ADDED: Function to complete a job and make transcriber available again
const completeJob = async (req, res, next, io) => {
    const { negotiationId } = req.params;
    const transcriberId = req.user.userId;

    if (!negotiationId) {
        return res.status(400).json({ error: 'Negotiation ID is required.' });
    }

    try {
        // Verify the negotiation belongs to this transcriber and is active
        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('client_id, status')
            .eq('id', negotiationId)
            .eq('transcriber_id', transcriberId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Job not found or not assigned to you.' });
        }

        if (negotiation.status !== 'accepted' && negotiation.status !== 'hired') {
            return res.status(409).json({ error: 'Job is not in an active state.' });
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

        // UPDATED: Sync availability status - make transcriber available again
        await syncAvailabilityStatus(transcriberId, true, null);

        // Send notification to client that the job was completed
        if (io) {
            io.to(negotiation.client_id).emit('job_completed', {
                negotiationId: negotiationId,
                transcriberId: transcriberId,
                message: `Your transcription job (ID: ${negotiationId}) has been completed!`
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

module.exports = {
  submitTest,
  checkTestStatus,
  // --- Export Negotiation Actions ---
  getTranscriberNegotiations,
  acceptNegotiation,
  rejectNegotiation,
  counterNegotiation,
  completeJob, // NEW: Added completeJob function
  syncAvailabilityStatus // NEW: Export utility function for other controllers to use
};
