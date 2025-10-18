const supabase = require('../database');
const multer = require('multer');
const path = require('path'); // CORRECTED: Changed 'require' to 'path' in previous fix, ensuring it's correct
const fs = require('fs');
const emailService = require('../emailService');
const { updateAverageRating } = require('./ratingController');

const syncAvailabilityStatus = async (userId, isAvailable, currentJobId = null) => {
    const updateData = {
        is_available: isAvailable,
        current_job_id: currentJobId,
        updated_at: new Date().toISOString()
    };

    // Update the 'users' table
    const { error: userError } = await supabase
        .from('users')
        .update(updateData)
        .eq('id', userId);

    // Also update the 'transcribers' table for consistency if it exists
    const { error: transcriberError } = await supabase
        .from('transcribers')
        .update(updateData)
        .eq('id', userId);

    if (userError) {
        console.error(`Supabase error updating user availability for ${userId}:`, userError);
        throw userError;
    }
    // Log a warning if only one table update failed, as the other might have succeeded
    if (transcriberError) {
        console.warn(`Transcribers table sync warning for ${userId}:`, transcriberError);
    }
};

// Multer configuration for negotiation files
const negotiationFileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/negotiation_files';
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

const negotiationFileFilter = (req, file, cb) => {
  // Allowed MIME types for negotiation attachments
  const allowedTypes = [
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/mp4', 'audio/m4a', 'audio/ogg',
    'video/mp4', 'video/webm', 'video/ogg',
    'application/pdf',
    'application/msword', // .doc
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'text/plain',
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif'
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true); // Accept the file
  } else {
    // Reject the file and provide an error message
    cb(new Error('Only audio, video, PDF, DOC, DOCX, TXT, and image files are allowed for negotiation attachments!'), false);
  }
};

const uploadNegotiationFiles = multer({
  storage: negotiationFileStorage,
  fileFilter: negotiationFileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
}).single('negotiationFile'); // Expecting a single file with the field name 'negotiationFile'

const getAvailableTranscribers = async (req, res) => {
  try {
    console.log('Fetching available transcribers...');

    // Fetch users who are transcribers, online, available, not currently in a job, and have an active status
    const { data: transcribers, error } = await supabase
      .from('users')
      .select(`
        id,
        full_name,
        email,
        created_at,
        is_online,
        is_available,
        current_job_id,
        transcribers (
            status,
            user_level,
            average_rating,
            completed_jobs,
            badges
        )
      `)
      .eq('user_type', 'transcriber')
      .eq('is_available', true) // Ensure they are marked as available in the users table
      .is('current_job_id', null) // Ensure they are not currently assigned to a job
      .eq('transcribers.status', 'active_transcriber'); // Ensure their transcriber status is active

    if (error) {
        console.error('Supabase error fetching available transcribers:', error);
        throw error;
    }

    // Filter the results further in JS to ensure all conditions are met (sometimes DB filters can be tricky with nested data)
    let availableTranscribers = (transcribers || []).filter(user =>
      user.transcribers &&
      user.transcribers.status === 'active_transcriber' &&
      user.is_online === true &&
      user.is_available === true &&
      user.current_job_id === null
    );

    // Map the data to a cleaner format for the frontend
    availableTranscribers = availableTranscribers.map(user => ({
      id: user.id,
      status: user.transcribers.status,
      user_level: user.transcribers.user_level,
      is_online: user.is_online,
      is_available: user.is_available,
      average_rating: user.transcribers.average_rating || 5.0, // Default to 5.0 if no rating
      completed_jobs: user.transcribers.completed_jobs || 0,
      badges: user.transcribers.badges,
      users: { // Nest user details under a 'users' key for consistency with other responses
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        created_at: user.created_at
      }
    }));

    // Sort transcribers by rating in descending order
    availableTranscribers.sort((a, b) => b.average_rating - a.average_rating);

    // Development-specific: Create sample data if no transcribers are found
    if (availableTranscribers.length === 0 && process.env.NODE_ENV === 'development') {
      console.log('No transcribers found, creating sample data...');

      const sampleUsers = [
        { full_name: 'Sarah Wanjiku', email: 'sarah@example.com', password_hash: '$2b$10$sample.hash.for.demo', user_type: 'transcriber', is_online: true, is_available: true, current_job_id: null },
        { full_name: 'John Kipchoge', email: 'john@example.com', password_hash: '$2b$10$sample.hash.for.demo', user_type: 'transcriber', is_online: true, is_available: true, current_job_id: null },
        { full_name: 'Grace Akinyi', email: 'grace@example.com', password_hash: '$2b$10$sample.hash.for.demo', user_type: 'transcriber', is_online: true, is_available: true, current_job_id: null }
      ];

      // Insert sample users
      const { data: insertedUsers, error: insertUserError } = await supabase
        .from('users')
        .insert(sampleUsers)
        .select('id, full_name, email');

      if (insertUserError) {
        console.error('Error creating sample users for transcribers:', insertUserError);
      } else {
        // Create corresponding transcriber profiles
        const sampleTranscriberProfiles = insertedUsers.map(user => ({
            id: user.id,
            status: 'active_transcriber',
            user_level: 'transcriber',
            average_rating: parseFloat((Math.random() * (5.0 - 4.0) + 4.0).toFixed(1)), // Random rating between 4.0 and 5.0
            completed_jobs: Math.floor(Math.random() * 50) + 10, // Random completed jobs
            badges: (user.full_name === 'Sarah Wanjiku') ? 'fast_delivery,quality_expert' :
                    (user.full_name === 'John Kipchoge') ? 'reliable,experienced' :
                    'quality_expert,experienced'
        }));

        const { error: insertProfileError } = await supabase
            .from('transcribers')
            .insert(sampleTranscriberProfiles);

        if (insertProfileError) {
          console.error('Error creating sample transcriber profiles:', insertProfileError);
        } else {
          // Re-fetch and format the newly created sample data
          availableTranscribers = insertedUsers.map((user, index) => ({
            id: user.id,
            status: 'active_transcriber',
            user_level: 'transcriber',
            is_online: true,
            is_available: true,
            average_rating: sampleTranscriberProfiles[index].average_rating,
            completed_jobs: sampleTranscriberProfiles[index].completed_jobs,
            badges: sampleTranscriberProfiles[index].badges,
            users: {
              id: user.id,
              full_name: user.full_name,
              email: user.email,
              created_at: new Date().toISOString() // Use current date for creation time
            }
          }));
          availableTranscribers.sort((a, b) => b.average_rating - a.average_rating);
        }
      }
    }

    res.json({
      message: 'Available transcribers retrieved successfully',
      transcribers: availableTranscribers,
      count: availableTranscribers.length
    });

  } catch (error) {
    console.error('Get available transcribers error:', error);
    res.status(500).json({ error: error.message });
  }
};

const createNegotiation = async (req, res, next, io) => {
  let negotiationFile = req.file; // The file uploaded via multer
  try {
    const { transcriber_id, requirements, proposed_price_kes, deadline_hours } = req.body;
    const clientId = req.user.userId;

    // Basic validation for required fields
    if (!transcriber_id || !requirements || !proposed_price_kes || !deadline_hours) {
      // Clean up the uploaded file if any required field is missing
      if (negotiationFile && fs.existsSync(negotiationFile.path)) {
        fs.unlinkSync(negotiationFile.path);
      }
      return res.status(400).json({ error: 'All fields (transcriber_id, requirements, proposed_price_kes, deadline_hours) are required.' });
    }

    // Check if a file was actually uploaded
    if (!negotiationFile) {
      return res.status(400).json({ error: 'Audio/video file is required for negotiation.' });
    }

    const negotiationFileName = negotiationFile.filename;
    const filePath = negotiationFile.path;

    // Verify that the uploaded file exists on the server after multer processing
    if (!fs.existsSync(filePath)) {
      console.error(`CRITICAL WARNING: Uploaded file NOT found at expected path: ${filePath}`);
      // Attempt to clean up if the file reference still exists but the file doesn't
      if (negotiationFile && fs.existsSync(negotiationFile.path)) {
        fs.unlinkSync(negotiationFile.path);
      }
      return res.status(500).json({ error: 'Uploaded file not found on server after processing. Please try again.' });
    }

    // Check if the target transcriber is available and active
    const { data: transcriberUser, error: transcriberError } = await supabase
      .from('users')
      .select(`
        id,
        full_name,
        email,
        is_online,
        is_available,
        current_job_id,
        transcribers (
          id,
          status,
          user_level
        )
      `)
      .eq('id', transcriber_id)
      .eq('user_type', 'transcriber')
      .eq('is_online', true)
      .eq('is_available', true)
      .is('current_job_id', null)
      .eq('transcribers.status', 'active_transcriber')
      .single();

    if (transcriberError || !transcriberUser) {
      // Clean up the uploaded file if the transcriber is not found or not available
      if (negotiationFile && fs.existsSync(negotiationFile.path)) {
        fs.unlinkSync(negotiationFile.path);
      }
      console.error('createNegotiation: Transcriber not found or not available. Supabase Error:', transcriberError);
      return res.status(404).json({ error: 'Transcriber not found, not online, or not available for new jobs.' });
    }
    // Additional checks based on transcriber status
    if (!transcriberUser.is_available) {
      if (negotiationFile && fs.existsSync(negotiationFile.path)) fs.unlinkSync(negotiationFile.path);
      return res.status(400).json({ error: 'Transcriber is currently busy with another job or manually set to unavailable.' });
    }
    if (transcriberUser.current_job_id) {
        if (negotiationFile && fs.existsSync(negotiationFile.path)) fs.unlinkSync(negotiationFile.path);
        return res.status(400).json({ error: 'Transcriber is currently busy with an active job.' });
    }

    // Check if a pending negotiation already exists between this client and transcriber
    const { data: existingNegotiation, error: existingNegError } = await supabase
      .from('negotiations')
      .select('id')
      .eq('client_id', clientId)
      .eq('transcriber_id', transcriber_id)
      .eq('status', 'pending') // Only check for pending negotiations
      .single();

    if (existingNegError && existingNegError.code !== 'PGRST116') { // PGRST116 means "No rows found"
        console.error('createNegotiation: Supabase error checking existing negotiation:', existingNegError);
        if (negotiationFile && fs.existsSync(negotiationFile.path)) fs.unlinkSync(negotiationFile.path);
        return res.status(500).json({ error: existingNegError.message });
    }
    if (existingNegotiation) {
      // Clean up file if a pending negotiation already exists
      if (negotiationFile && fs.existsSync(negotiationFile.path)) fs.unlinkSync(negotiationFile.path);
      return res.status(400).json({ error: 'You already have a pending negotiation with this transcriber. Please wait for their response or cancel the existing one.' });
    }

    // Insert the new negotiation request
    const { data, error: insertError } = await supabase
      .from('negotiations')
      .insert([
        {
          client_id: clientId,
          transcriber_id: transcriber_id,
          requirements: requirements,
          agreed_price_kes: proposed_price_kes,
          deadline_hours: deadline_hours,
          client_message: `Budget: KES ${proposed_price_kes}, Deadline: ${deadline_hours} hours`,
          negotiation_files: negotiationFileName, // Store only the filename
          status: 'pending'
        }
      ])
      .select() // Select the inserted row
      .single();

    if (insertError) {
      console.error('createNegotiation: Supabase error inserting new negotiation:', insertError);
      // Clean up file on insertion error
      if (negotiationFile && fs.existsSync(negotiationFile.path)) {
        fs.unlinkSync(negotiationFile.path);
      }
      throw insertError;
    }

    const newNegotiation = data[0];

    // Emit a real-time event to the transcriber
    if (io) {
      io.to(transcriber_id).emit('new_negotiation_request', {
        negotiationId: newNegotiation.id,
        clientId: clientId,
        clientName: req.user.full_name,
        message: `You have a new negotiation request from ${req.user.full_name}.`,
        newStatus: 'pending' // Indicate the new status for frontend updates
      });
      console.log(`Emitted 'new_negotiation_request' to transcriber ${transcriber_id}`);
    }

    // Send an email notification to the transcriber
    const clientDetailsForEmail = {
        full_name: req.user.full_name,
        email: req.user.email
    };
    const transcriberDetailsForEmail = {
        full_name: transcriberUser.full_name,
        email: transcriberUser.email
    };

    if (transcriberDetailsForEmail && transcriberDetailsForEmail.email && clientDetailsForEmail && clientDetailsForEmail.email) {
        await emailService.sendNewNegotiationRequestEmail(transcriberDetailsForEmail, clientDetailsForEmail);
    }

    res.status(201).json({
      message: 'Negotiation request sent successfully',
      negotiation: newNegotiation,
      transcriber_name: transcriberUser.full_name // Include transcriber name for frontend display
    });

  } catch (error) {
    console.error('createNegotiation: UNCAUGHT EXCEPTION:', error);
    // Ensure file cleanup occurs if an error happens at any stage
    if (negotiationFile && fs.existsSync(negotiationFile.path)) {
        try {
            fs.unlinkSync(negotiationFile.path);
            console.log(`Cleaned up uploaded file due to error: ${negotiationFile.path}`);
        } catch (unlinkError) {
            console.error(`Error deleting uploaded file after failed negotiation creation: ${unlinkError}`);
        }
    }
    res.status(500).json({ error: error.message || 'Failed to create negotiation due to server error.' });
  }
};

const getClientNegotiations = async (req, res) => {
  try {
    const clientId = req.user.userId;
    console.log(`Fetching client negotiations for client ID: ${clientId}`);

    // Fetch negotiations for the client, joining with transcriber details
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
        transcriber_id,
        transcriber:users!transcriber_id (
            id,
            full_name,
            email,
            transcribers (
                average_rating,
                completed_jobs
            )
        )
      `)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false }); // Order by creation date, newest first

    if (negotiationsError) {
      console.error('Negotiations query error:', negotiationsError);
      throw negotiationsError;
    }

    if (!negotiations || negotiations.length === 0) {
      return res.json({
        message: 'No negotiations found',
        negotiations: []
      });
    }

    // Process negotiations to format transcriber data cleanly
    const negotiationsWithTranscribers = negotiations.map(negotiation => {
        const { transcriber, ...rest } = negotiation; // Destructure to separate transcriber info

        // Safely access nested transcriber profile data
        const transcriberProfileData = transcriber?.transcribers?.[0] || {};

        return {
            ...rest, // Include all negotiation details
            users: transcriber ? { // Nest transcriber details under 'users' key
                id: transcriber.id,
                full_name: transcriber.full_name,
                email: transcriber.email,
                average_rating: transcriberProfileData.average_rating || 0, // Default to 0 if no rating
                completed_jobs: transcriberProfileData.completed_jobs || 0,
            } : { // Fallback if transcriber data is missing
                id: negotiation.transcriber_id, // Use the ID from the negotiation table
                full_name: 'Unknown Transcriber',
                average_rating: 0,
                completed_jobs: 0
            }
        };
    });

    res.json({
      message: 'Negotiations retrieved successfully',
      negotiations: negotiationsWithTranscribers
    });

  } catch (error) {
    console.error('Get client negotiations error:', error);
    res.status(500).json({ error: error.message });
  }
};

const getTranscriberNegotiations = async (req, res) => {
  try {
    const transcriberId = req.user.userId;

    console.log('Get transcriber negotiations for:', transcriberId);

    // Fetch negotiations for the transcriber, joining with client details
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
        client:users!client_id(
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

    // Process negotiations to format client data cleanly
    const negotiationsWithClients = negotiations.map(negotiation => {
        const { client, ...rest } = negotiation;
        return {
            ...rest,
            client_info: client ? {
                id: client.id,
                full_name: client.full_name,
                client_rating: 5.0, // Default rating since we don't have this in users table here
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

const deleteNegotiation = async (req, res, io) => {
  try {
    const { negotiationId } = req.params;
    const clientId = req.user.userId;

    // Fetch negotiation details to verify ownership and status
    const { data: negotiation, error: fetchError } = await supabase
      .from('negotiations')
      .select('status, client_id, negotiation_files, transcriber_id')
      .eq('id', negotiationId)
      .single();

    if (fetchError || !negotiation) {
      return res.status(404).json({ error: 'Negotiation not found.' });
    }

    // Ensure the user attempting deletion is the client
    if (negotiation.client_id !== clientId) {
      return res.status(403).json({ error: 'You are not authorized to delete this negotiation.' });
    }

    // Define allowed statuses for deletion (updated based on previous feedback)
    const deletableStatuses = ['pending', 'accepted_awaiting_payment', 'rejected', 'cancelled'];
    if (!deletableStatuses.includes(negotiation.status)) {
      return res.status(400).json({ error: `Negotiations with status '${negotiation.status}' cannot be deleted. Only ${deletableStatuses.join(', ')} can be deleted.` });
    }

    // Delete the associated file from the server if it exists
    if (negotiation.negotiation_files) {
      const filePath = path.join('uploads/negotiation_files', negotiation.negotiation_files);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Deleted negotiation file: ${filePath}`);
      } else {
        console.warn(`Negotiation file not found on disk for deletion: ${filePath}`);
      }
    }

    // Delete the negotiation record from the database
    const { error: deleteError } = await supabase
      .from('negotiations')
      .delete()
      .eq('id', negotiationId);

    if (deleteError) throw deleteError;

    // Emit a real-time event to the transcriber if they exist
    if (io && negotiation.transcriber_id) {
      io.to(negotiation.transcriber_id).emit('negotiation_cancelled', {
        negotiationId: negotiation.id,
        message: `A negotiation request from ${req.user.full_name} was cancelled.`,
        newStatus: 'cancelled' // Indicate the new status for frontend updates
      });
      console.log(`Emitted 'negotiation_cancelled' to transcriber ${negotiation.transcriber_id}`);
    }

    res.json({ message: 'Negotiation deleted successfully' });

  } catch (error) {
    console.error('Delete negotiation error:', error);
    res.status(500).json({ error: error.message });
  }
};

const acceptNegotiation = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const transcriberId = req.user.userId;

        // Fetch negotiation details to verify status and user authorization
        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id, agreed_price_kes, deadline_hours')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.' });
        }

        // Authorize the user (must be the transcriber)
        if (negotiation.transcriber_id !== transcriberId) {
            return res.status(403).json({ error: 'You are not authorized to accept this negotiation.' });
        }

        // Check if the negotiation is in an acceptable state (pending or client countered)
        if (negotiation.status !== 'pending' && negotiation.status !== 'client_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state that can be accepted.' });
        }

        // Update the negotiation status to 'accepted_awaiting_payment'
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'accepted_awaiting_payment', updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // Emit a real-time event to the client
        if (io) {
            io.to(negotiation.client_id).emit('negotiation_accepted', {
                negotiationId: updatedNegotiation.id,
                message: `Your negotiation with ${req.user.full_name} has been accepted!`,
                newStatus: 'accepted_awaiting_payment' // Inform frontend of the status change
            });
            console.log(`Emitted 'negotiation_accepted' to client ${negotiation.client_id}`);
        }

        // Send an email notification to the client
        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.client_id).single();
        if (clientError) console.error('Error fetching client for negotiation accepted email:', clientError);

        if (clientUser) {
            await emailService.sendNegotiationAcceptedEmail(clientUser, req.user, updatedNegotiation);
        }

        res.json({ message: 'Negotiation accepted. Awaiting client payment.', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Accept negotiation error:', error);
        res.status(500).json({ error: error.message });
    }
};

const counterNegotiation = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const { proposed_price_kes, deadline_hours, transcriber_response } = req.body;
        const transcriberId = req.user.userId;

        // Validate input fields
        if (!proposed_price_kes || !deadline_hours || !transcriber_response) {
            return res.status(400).json({ error: 'Proposed price, deadline, and response are required for a counter-offer.' });
        }

        // Fetch negotiation details to verify status and authorization
        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.' });
        }

        // Authorize the user (must be the transcriber)
        if (negotiation.transcriber_id !== transcriberId) {
            return res.status(403).json({ error: 'You are not authorized to make a counter-offer on this negotiation.' });
        }

        // Check if the negotiation is in an acceptable state (pending or client countered)
        if (negotiation.status !== 'pending' && negotiation.status !== 'client_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state that allows for a counter-offer.' });
        }

        // Update negotiation with counter-offer details
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({
                status: 'transcriber_counter', // Set status to indicate transcriber's counter
                agreed_price_kes: proposed_price_kes,
                deadline_hours: deadline_hours,
                transcriber_response: transcriber_response, // Store the transcriber's message
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // Emit a real-time event to the client
        if (io) {
            io.to(negotiation.client_id).emit('negotiation_countered', {
                negotiationId: updatedNegotiation.id,
                message: `Transcriber ${req.user.full_name} sent a counter offer!`,
                newStatus: 'transcriber_counter' // Inform frontend of the status change
            });
            console.log(`Emitted 'negotiation_countered' to client ${negotiation.client_id}`);
        }

        // Send an email notification to the client
        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.client_id).single();
        if (clientError) console.error('Error fetching client for counter offer email:', clientError);

        if (clientUser) {
            await emailService.sendCounterOfferEmail(clientUser, req.user, updatedNegotiation);
        }

        res.json({ message: 'Counter offer sent successfully.', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Counter negotiation error:', error);
        res.status(500).json({ error: error.message });
    }
};

const rejectNegotiation = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const { reason } = req.body; // Reason for rejection
        const transcriberId = req.user.userId;

        // Fetch negotiation details to verify status and authorization
        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.' });
        }

        // Authorize the user (must be the transcriber)
        if (negotiation.transcriber_id !== transcriberId) {
            return res.status(403).json({ error: 'You are not authorized to reject this negotiation.' });
        }

        // Check if the negotiation is in an acceptable state (pending or client countered)
        if (negotiation.status !== 'pending' && negotiation.status !== 'client_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state that can be rejected.' });
        }

        // Update negotiation status to 'rejected' and store the rejection reason
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'rejected', transcriber_response: reason, updated_at: new Date().toISOString() }) // Use transcriber_response for rejection reason
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // Emit a real-time event to the client
        if (io) {
            io.to(negotiation.client_id).emit('negotiation_rejected', {
                negotiationId: updatedNegotiation.id,
                message: `Transcriber ${req.user.full_name} rejected your negotiation.`,
                newStatus: 'rejected' // Inform frontend of the status change
            });
            console.log(`Emitted 'negotiation_rejected' to client ${negotiation.client_id}`);
        }

        // Send an email notification to the client
        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.client_id).single();
        if (clientError) console.error('Error fetching client for negotiation rejected email:', clientError);

        if (clientUser) {
            await emailService.sendNegotiationRejectedEmail(clientUser, updatedNegotiation, reason); // Pass the rejection reason
        }

        res.json({ message: 'Negotiation rejected successfully.', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Reject negotiation error:', error);
        res.status(500).json({ error: error.message });
    }
};

const clientAcceptCounter = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const clientId = req.user.userId;

        // Fetch negotiation details to verify status and authorization
        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id, agreed_price_kes, deadline_hours')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.' });
        }

        // Authorize the user (must be the client)
        if (negotiation.client_id !== clientId) {
            return res.status(403).json({ error: 'You are not authorized to accept this counter-offer.' });
        }

        // Check if the negotiation is in the 'transcriber_counter' state
        if (negotiation.status !== 'transcriber_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state to accept a counter-offer.' });
        }

        // Update negotiation status to 'accepted_awaiting_payment'
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'accepted_awaiting_payment', updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // Emit a real-time event to the transcriber
        if (io) {
            io.to(negotiation.transcriber_id).emit('negotiation_accepted', {
                negotiationId: updatedNegotiation.id,
                message: `Client ${req.user.full_name} accepted your counter-offer!`,
                newStatus: 'accepted_awaiting_payment' // Inform frontend of the status change
            });
            console.log(`Emitted 'negotiation_accepted' to transcriber ${negotiation.transcriber_id}`);
        }

        // Send an email notification to the transcriber
        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.transcriber_id).single();
        if (transcriberError) console.error('Error fetching transcriber for client accept counter email:', transcriberError);

        if (transcriberUser) {
            // Use the same email template as when transcriber accepts, but with client details as sender
            await emailService.sendNegotiationAcceptedEmail(req.user, transcriberUser, updatedNegotiation);
        }

        res.json({ message: 'Counter-offer accepted. Proceed to payment.', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Client accept counter-offer error:', error);
        res.status(500).json({ error: error.message });
    }
};

const clientRejectCounter = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const { client_response } = req.body; // Client's reason for rejection
        const clientId = req.user.userId;

        // Fetch negotiation details to verify status and authorization
        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.' });
        }

        // Authorize the user (must be the client)
        if (negotiation.client_id !== clientId) {
            return res.status(403).json({ error: 'You are not authorized to reject this counter-offer.' });
        }

        // Check if the negotiation is in the 'transcriber_counter' state
        if (negotiation.status !== 'transcriber_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state to reject a counter-offer.' });
        }

        // Update negotiation status to 'rejected' and store the client's response
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'rejected', client_response: client_response, updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // Emit a real-time event to the transcriber
        if (io) {
            io.to(negotiation.transcriber_id).emit('negotiation_rejected', {
                negotiationId: updatedNegotiation.id,
                message: `Client ${req.user.full_name} rejected your counter-offer.`,
                newStatus: 'rejected' // Inform frontend of the status change
            });
            console.log(`Emitted 'negotiation_rejected' to transcriber ${negotiation.transcriber_id}`);
        }

        // Send an email notification to the transcriber
        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.transcriber_id).single();
        if (transcriberError) console.error('Error fetching transcriber for client reject counter email:', transcriberError);

        if (transcriberUser) {
            await emailService.sendNegotiationRejectedEmail(transcriberUser, updatedNegotiation, client_response); // Pass client's response as reason
        }

        res.json({ message: 'Counter-offer rejected successfully.', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Client reject counter-offer error:', error);
        res.status(500).json({ error: error.message });
    }
};

const clientCounterBack = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const { proposed_price_kes, deadline_hours, client_response } = req.body;
        const clientId = req.user.userId;

        // Validate input fields
        if (!proposed_price_kes || !deadline_hours || !client_response) {
            return res.status(400).json({ error: 'Proposed price, deadline, and message are required for a counter-offer back.' });
        }

        // Fetch negotiation details to verify status and authorization
        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.' });
        }

        // Authorize the user (must be the client)
        if (negotiation.client_id !== clientId) {
            return res.status(403).json({ error: 'You are not authorized to counter back on this negotiation.' });
        }

        // Check if the negotiation is in the 'transcriber_counter' state
        if (negotiation.status !== 'transcriber_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state that allows for a counter-offer back.' });
        }

        // Update negotiation with the client's counter-offer
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({
                status: 'client_counter', // Set status to indicate client's counter
                agreed_price_kes: proposed_price_kes,
                deadline_hours: deadline_hours,
                client_message: client_response, // Store the client's message/response
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // Emit a real-time event to the transcriber
        if (io) {
            io.to(negotiation.transcriber_id).emit('negotiation_countered', { // Use same event as transcriber's counter
                negotiationId: updatedNegotiation.id,
                message: `Client ${req.user.full_name} sent a counter-offer back!`,
                newStatus: 'client_counter' // Inform frontend of the status change
            });
            console.log(`Emitted 'negotiation_countered' to transcriber ${negotiation.transcriber_id}`);
        }

        // Send an email notification to the transcriber
        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.transcriber_id).single();
        if (transcriberError) console.error('Error fetching transcriber for client counter back email:', transcriberError);

        if (transcriberUser) {
            // Use the counter-offer email template, with client details as the sender
            await emailService.sendCounterOfferEmail(transcriberUser, req.user, updatedNegotiation);
        }

        res.json({ message: 'Counter-offer sent successfully.', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Client counter back error:', error);
        res.status(500).json({ error: error.message });
    }
};


module.exports = {
  uploadNegotiationFiles,
  getAvailableTranscribers,
  createNegotiation,
  getClientNegotiations,
  deleteNegotiation,
  syncAvailabilityStatus,
  acceptNegotiation,
  counterNegotiation,
  rejectNegotiation,
  clientAcceptCounter,
  clientRejectCounter,
  clientCounterBack
};
