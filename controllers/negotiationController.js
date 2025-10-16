// backend/controllers/negotiationController.js - Part 1 - UPDATED for simplified online/availability logic and Client Rating Trigger

const supabase = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const emailService = require('../emailService'); // Ensure this path is correct
const { updateAverageRating } = require('./ratingController'); // NEW: Import updateAverageRating

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

// Configure multer for negotiation files
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
    cb(new Error('Only audio, video, PDF, DOC, DOCX, TXT, and image files are allowed for negotiation attachments!'), false);
  }
};

const uploadNegotiationFiles = multer({
  storage: negotiationFileStorage,
  fileFilter: negotiationFileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit for negotiation files
  }
}).single('negotiationFile');

// Get all available transcribers (for clients to browse)
const getAvailableTranscribers = async (req, res) => {
  try {
    console.log('Fetching available transcribers...');

    // FIXED: Query users table directly and join with transcribers for additional info
    // Removed .eq('is_online', true) from Supabase query
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
      .eq('is_available', true) // Filter by manually set availability
      .is('current_job_id', null) // Filter out transcribers with an active job
      .eq('transcribers.status', 'active_transcriber');
      // REMOVED: .order('transcribers.average_rating', { ascending: false }); // Handled in JS now

    if (error) {
        console.error('Supabase error fetching available transcribers::', error);
        throw error;
    }

    console.log('Raw transcribers data from Supabase:', transcribers); // Added debug log

    // Filter out any transcribers without valid transcriber profiles, not online, or with active jobs
    let availableTranscribers = (transcribers || []).filter(user =>
      user.transcribers &&
      user.transcribers.status === 'active_transcriber' &&
      user.is_online === true && // Ensure they are actually logged in/online
      user.is_available === true && // Ensure they are manually set to available
      user.current_job_id === null // Ensure they don't have an active job
    );

    // Restructure data to match frontend expectations
    availableTranscribers = availableTranscribers.map(user => ({
      id: user.id,
      status: user.transcribers.status,
      user_level: user.transcribers.user_level,
      is_online: user.is_online,
      is_available: user.is_available,
      average_rating: user.transcribers.average_rating || 5.0,
      completed_jobs: user.transcribers.completed_jobs || 0,
      badges: user.transcribers.badges,
      users: { // Frontend expects 'users' object here
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        created_at: user.created_at
      }
    }));

    // ADDED: Sort by average_rating in JavaScript after data transformation
    availableTranscribers.sort((a, b) => b.average_rating - a.average_rating);

    console.log('Processed available transcribers (after JS filter and sort):', availableTranscribers);

    // If no real transcribers, create sample ones in database for testing (DEV ONLY)
    if (availableTranscribers.length === 0 && process.env.NODE_ENV === 'development') {
      console.log('No transcribers found, creating sample data... (NOTE: This will create online/available users for testing)');

      const sampleUsers = [
        {
          full_name: 'Sarah Wanjiku',
          email: 'sarah@example.com',
          password_hash: '$2b$10$sample.hash.for.demo', // Dummy hash
          user_type: 'transcriber',
          is_online: true, // Sample users should be online
          is_available: true, // Sample users should be available
          current_job_id: null
        },
        {
          full_name: 'John Kipchoge',
          email: 'john@example.com',
          password_hash: '$2b$10$sample.hash.for.demo', // Dummy hash
          user_type: 'transcriber',
          is_online: true,
          is_available: true,
          current_job_id: null
        },
        {
          full_name: 'Grace Akinyi',
          email: 'grace@example.com',
          password_hash: '$2b$10$sample.hash.for.demo', // Dummy hash
          user_type: 'transcriber',
          is_online: true,
          is_available: true,
          current_job_id: null
        }
      ];

      const { data: insertedUsers, error: insertUserError } = await supabase
        .from('users')
        .insert(sampleUsers)
        .select('id, full_name, email');

      if (insertUserError) {
        console.error('Error creating sample users for transcribers:', insertUserError);
      } else {
        const sampleTranscriberProfiles = insertedUsers.map(user => ({
            id: user.id, // Link to the user's ID
            status: 'active_transcriber',
            user_level: 'transcriber',
            average_rating: parseFloat((Math.random() * (5.0 - 4.0) + 4.0).toFixed(1)), // Random rating
            completed_jobs: Math.floor(Math.random() * 50) + 10, // Random jobs
            badges: (user.full_name === 'Sarah Wanjiku') ? 'fast_delivery,quality_expert' :
                    (user.full_name === 'John Kipchoge') ? 'reliable,experienced' :
                    'quality_expert,experienced'
        }));

        const { data: insertedProfiles, error: insertProfileError } = await supabase
            .from('transcribers')
            .insert(sampleTranscriberProfiles)
            .select(`
                id,
                status,
                user_level,
                average_rating,
                completed_jobs,
                badges
            `);

        if (insertProfileError) {
          console.error('Error creating sample transcriber profiles:', insertProfileError);
        } else {
          // Restructure sample data to match expected format
          availableTranscribers = insertedUsers.map((user, index) => ({
            id: user.id,
            status: 'active_transcriber',
            user_level: 'transcriber',
            is_online: true,
            is_available: true,
            average_rating: insertedProfiles[index].average_rating,
            completed_jobs: insertedProfiles[index].completed_jobs,
            badges: insertedProfiles[index].badges,
            users: { // Frontend expects 'users' object here
              id: user.id,
              full_name: user.full_name,
              email: user.email,
              created_at: new Date().toISOString()
            }
          }));

          // Sort sample data by rating too
          availableTranscribers.sort((a, b) => b.average_rating - a.average_rating);
        }
      }
    }

    console.log('Final transcribers count:', availableTranscribers.length);

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
// backend/controllers/negotiationController.js - Part 2 - UPDATED for simplified online/availability logic and Client Rating Trigger (Continue from Part 1)

// Create negotiation request (for clients)
const createNegotiation = async (req, res, next, io) => {
  try {
    const { transcriber_id, requirements, proposed_price_kes, deadline_hours } = req.body;
    const clientId = req.user.userId;

    const negotiationFile = req.file;
    let negotiationFileName = '';
    if (negotiationFile) {
      negotiationFileName = negotiationFile.filename;
    } else {
      return res.status(400).json({ error: 'Audio/video file is required for negotiation' });
    }

    if (!transcriber_id || !requirements || !proposed_price_kes || !deadline_hours) {
      if (negotiationFile) fs.unlinkSync(negotiationFile.path);
      return res.status(400).json({ error: 'All fields are required' });
    }

    // FIXED: Check transcriber existence from both users and transcribers tables
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
      .eq('is_online', true) // Ensure they are logged in
      .eq('is_available', true) // Ensure they are manually set to available
      .is('current_job_id', null) // Ensure they don't have an active job
      .eq('transcribers.status', 'active_transcriber')
      .single();

    if (transcriberError || !transcriberUser) {
      if (negotiationFile) fs.unlinkSync(negotiationFile.path);
      return res.status(404).json({ error: 'Transcriber not found or not available' });
    }

    if (!transcriberUser.is_available) { // This check is now redundant with the Supabase query, but good for explicit error message
      if (negotiationFile) fs.unlinkSync(negotiationFile.path);
      return res.status(400).json({ error: 'Transcriber is currently busy with another job or manually set to busy' });
    }
    if (transcriberUser.current_job_id) { // Also redundant, but good for explicit error message
        if (negotiationFile) fs.unlinkSync(negotiationFile.path);
        return res.status(400).json({ error: 'Transcriber is currently busy with an active job' });
    }


    const { data: existingNegotiation } = await supabase
      .from('negotiations')
      .select('id')
      .eq('client_id', clientId)
      .eq('transcriber_id', transcriber_id)
      .eq('status', 'pending')
      .single();

    if (existingNegotiation) {
      if (negotiationFile) fs.unlinkSync(negotiationFile.path);
      return res.status(400).json({ error: 'You already have a pending negotiation with this transcriber' });
    }

    const { data, error } = await supabase
      .from('negotiations')
      .insert([
        {
          client_id: clientId,
          transcriber_id: transcriber_id,
          requirements: requirements,
          agreed_price_kes: proposed_price_kes,
          deadline_hours: deadline_hours,
          client_message: `Budget: KES ${proposed_price_kes}, Deadline: ${deadline_hours} hours`,
          negotiation_files: negotiationFileName,
          status: 'pending'
        }
      ])
      .select();

    if (error) {
      if (negotiationFile) fs.unlinkSync(negotiationFile.path);
      throw error;
    }

    const newNegotiation = data[0];

    if (io) {
      io.to(transcriber_id).emit('new_negotiation_request', {
        negotiationId: newNegotiation.id,
        clientId: clientId,
        clientName: req.user.full_name,
        message: `You have a new negotiation request from ${req.user.full_name}.`
      });
      console.log(`Emitted 'new_negotiation_request' to transcriber ${transcriber_id}`);
    }

    // --- SEND NEW NEGOTIATION REQUEST EMAIL ---
    // Fetch client details for the email
    const clientDetailsForEmail = {
        full_name: req.user.full_name,
        email: req.user.email
    };
    // Fetch transcriber details for the email
    const transcriberDetailsForEmail = {
        full_name: transcriberUser.full_name,
        email: transcriberUser.email
    };

    if (transcriberDetailsForEmail && transcriberDetailsForEmail.email && clientDetailsForEmail && clientDetailsForEmail.email) {
        await emailService.sendNewNegotiationRequestEmail(transcriberDetailsForEmail, clientDetailsForEmail);
    }
    // --- END OF EMAIL INTEGRATION ---

    res.status(201).json({
      message: 'Negotiation request sent successfully',
      negotiation: newNegotiation,
      transcriber_name: transcriberUser.full_name
    });

  } catch (error) {
    console.error('Create negotiation error:', error);
    res.status(500).json({ error: error.message });
  }
};

// UPDATED: Get client's negotiations - FIXED FOR NEW DATA MODEL AND SUPABASE BEHAVIOR
const getClientNegotiations = async (req, res) => {
  try {
    const clientId = req.user.userId;
    console.log(`Fetching client negotiations for client ID: ${clientId}`);

    // FIXED: Select directly from negotiations, and join with 'users' (for transcriber's main info)
    // and then to 'transcribers' (for profile-specific data like rating/jobs)
    // Alias 'transcriber' to 'users!transcriber_id' to correctly fetch user details
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
      .order('created_at', { ascending: false });

    if (negotiationsError) {
      console.error('Negotiations query error:', negotiationsError);
      throw negotiationsError;
    }
    console.log('Raw client negotiations data:', negotiations);

    if (!negotiations || negotiations.length === 0) {
      return res.json({
        message: 'No negotiations found',
        negotiations: []
      });
    }

    // Restructure data to match frontend's expected 'users' field for transcriber info
    const negotiationsWithTranscribers = negotiations.map(negotiation => {
        const { transcriber, ...rest } = negotiation; // Extract 'transcriber' alias

        // Safely access nested transcriber profile data. Supabase often returns one-to-one
        // relationships as an array, so we take the first element if it exists.
        const transcriberProfileData = transcriber?.transcribers?.[0] || {};

        return {
            ...rest,
            users: transcriber ? { // Rename transcriber alias to 'users' for frontend consistency
                id: transcriber.id,
                full_name: transcriber.full_name,
                email: transcriber.email,
                average_rating: transcriberProfileData.average_rating || 0,
                completed_jobs: transcriberProfileData.completed_jobs || 0,
            } : {
                id: negotiation.transcriber_id,
                full_name: 'Unknown Transcriber',
                average_rating: 0,
                completed_jobs: 0
            }
        };
    });
    console.log('Processed client negotiations for frontend:', negotiationsWithTranscribers);

    res.json({
      message: 'Negotiations retrieved successfully',
      negotiations: negotiationsWithTranscribers
    });

  } catch (error) {
    console.error('Get client negotiations error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Client deletes a pending negotiation
const deleteNegotiation = async (req, res) => {
  try {
    const { negotiationId } = req.params;
    const clientId = req.user.userId;

    const { data: negotiation, error: fetchError } = await supabase
      .from('negotiations')
      .select('status, client_id, negotiation_files, transcriber_id')
      .eq('id', negotiationId)
      .single();

    if (fetchError || !negotiation) {
      return res.status(404).json({ error: 'Negotiation not found' });
    }

    if (negotiation.client_id !== clientId) {
      return res.status(403).json({ error: 'You are not authorized to delete this negotiation' });
    }

    if (negotiation.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending negotiations can be deleted' });
    }

    if (negotiation.negotiation_files) {
      const filePath = path.join('uploads/negotiation_files', negotiation.negotiation_files);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    const { error: deleteError } = await supabase
      .from('negotiations')
      .delete()
      .eq('id', negotiationId);

    if (deleteError) throw deleteError;

    // TODO: Emit real-time notification to the transcriber that the negotiation was deleted
    // This 'io' is not available in this controller function by default.
    // It would need to be passed from the route if an emit is desired here.
    // For now, it's commented out.

    res.json({ message: 'Negotiation deleted successfully' });

  } catch (error) {
    console.error('Delete negotiation error:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  uploadNegotiationFiles,
  getAvailableTranscribers,
  createNegotiation,
  getClientNegotiations,
  deleteNegotiation,
  syncAvailabilityStatus // Export the utility function
};
