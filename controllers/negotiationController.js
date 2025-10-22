const supabase = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const emailService = require('../emailService');
// Removed import for updateAverageRating as client rating is being removed.

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB limit

// Helper function to calculate the next Friday's date
const getNextFriday = () => {
    const today = new Date();
    const dayOfWeek = today.getDay(); // Sunday - 0, Monday - 1, ..., Saturday - 6
    const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
    const nextFriday = new Date(today);
    nextFriday.setDate(today.getDate() + daysUntilFriday);
    nextFriday.setHours(23, 59, 59, 999); // Set to end of day Friday
    return nextFriday.toISOString();
};

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

// Multer configuration for negotiation files (used by clientCounterBack)
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
    // Reject the file and provide a MulterError for consistent handling in the route
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only audio, video, PDF, DOC, DOCX, TXT, and image files are allowed for negotiation attachments!'), false);
  }
};

const uploadNegotiationFiles = multer({
  storage: negotiationFileStorage,
  fileFilter: negotiationFileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE // 500MB limit
  }
}).single('negotiationFile'); // Expecting a single file with the field name 'negotiationFile'

// Multer configuration for temporary file uploads (used by /api/negotiations/temp-upload)
const tempNegotiationFileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/temp_negotiation_files'; // Separate directory for temporary files
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

const uploadTempNegotiationFile = multer({
  storage: tempNegotiationFileStorage,
  fileFilter: negotiationFileFilter, // Reuse the same file filter
  limits: {
    fileSize: MAX_FILE_SIZE // 500MB limit
  }
}).single('negotiationFile'); // Expecting a single file with the field name 'negotiationFile'


const getAvailableTranscribers = async (req, res) => {
  try {
    console.log('Fetching available transcribers...');

    // FIX: Select all relevant transcriber profile fields directly from the 'users' table
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
        transcriber_status,
        transcriber_user_level,
        transcriber_average_rating,
        transcriber_completed_jobs,
        transcriber_mpesa_number,
        transcriber_paypal_email
      `)
      .eq('user_type', 'transcriber')
      .eq('is_online', true) // Must be online (logged in and on website)
      .eq('is_available', true) // Must be explicitly available (not manually set to unavailable)
      .is('current_job_id', null) // Must not have an active/hired job
      .eq('transcriber_status', 'active_transcriber'); // Ensure their transcriber status is active

    if (error) {
        console.error('Supabase error fetching available transcribers:', error);
        throw error;
    }

    // Filter out any users who are 'trainee' level, even if they somehow got into this list
    const filteredTranscribers = (transcribers || []).filter(
      (user) => user.transcriber_user_level !== 'trainee'
    );

    // Map the data to the expected frontend format
    let availableTranscribers = filteredTranscribers
      .map(user => ({
        id: user.id,
        // Transcriber profile data from 'users' table
        status: user.transcriber_status,
        user_level: user.transcriber_user_level,
        is_online: user.is_online,
        is_available: user.is_available,
        average_rating: user.transcriber_average_rating || 0.0, // Default to 0.0 if null
        completed_jobs: user.transcriber_completed_jobs || 0, // Default to 0 if null
        mpesa_number: user.transcriber_mpesa_number,
        paypal_email: user.paypal_email,
        users: {
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
        { full_name: 'Sarah Wanjiku', email: 'sarah@example.com', password_hash: '$2b$10$sample.hash.for.demo', user_type: 'transcriber', is_online: true, is_available: true, current_job_id: null, transcriber_status: 'active_transcriber', transcriber_user_level: 'transcriber', transcriber_average_rating: 4.5, transcriber_completed_jobs: 15 },
        { full_name: 'John Kipchoge', email: 'john@example.com', password_hash: '$2b$10$sample.hash.for.demo', user_type: 'transcriber', is_online: true, is_available: true, current_job_id: null, transcriber_status: 'active_transcriber', transcriber_user_level: 'transcriber', transcriber_average_rating: 4.2, transcriber_completed_jobs: 10 },
        { full_name: 'Grace Akinyi', email: 'grace@example.com', password_hash: '$2b$10$sample.hash.for.demo', user_type: 'transcriber', is_online: true, is_available: true, current_job_id: null, transcriber_status: 'active_transcriber', transcriber_user_level: 'transcriber', transcriber_average_rating: 4.8, transcriber_completed_jobs: 20 }
      ];

      // Insert sample users (these will go into the 'users' table directly now)
      const { data: insertedUsers, error: insertUserError } = await supabase
        .from('users')
        .insert(sampleUsers.map(u => ({
            ...u,
            is_active: true, // Assuming active by default for sample users
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })))
        .select('*');

      if (insertUserError) {
        console.error('Error creating sample users for transcribers:', insertUserError);
      } else {
        // Create corresponding transcriber marker profiles in the 'transcribers' table
        const sampleTranscriberMarkers = insertedUsers.map(user => ({ id: user.id }));
        const { error: insertProfileError } = await supabase
            .from('transcribers')
            .insert(sampleTranscriberMarkers);

        if (insertProfileError) {
          console.error('Error creating sample transcriber marker profiles:', insertProfileError);
        } else {
          // Re-fetch and format the newly created sample data from the 'users' table
          availableTranscribers = insertedUsers.map(user => ({
            id: user.id,
            status: user.transcriber_status,
            user_level: user.transcriber_user_level,
            is_online: user.is_online,
            is_available: user.is_available,
            average_rating: user.transcriber_average_rating,
            completed_jobs: user.transcriber_completed_jobs,
            mpesa_number: user.mpesa_number,
            paypal_email: user.paypal_email,
            users: {
              id: user.id,
              full_name: user.full_name,
              email: user.email,
              created_at: user.created_at
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
    // FIX: Corrected syntax error here
    console.error('Get available transcribers error:', error);
    res.status(500).json({ error: error.message });
  }
};

// NEW: Endpoint for temporary file upload
const tempUploadNegotiationFile = async (req, res) => {
    // This function will be called by the `uploadTempNegotiationFile` multer middleware
    // The file will be available in req.file if upload is successful
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded or file type not allowed.' });
    }

    // Return the URL or filename of the temporarily stored file
    const fileUrl = `/uploads/temp_negotiation_files/${req.file.filename}`; // Construct a URL for the frontend
    res.status(200).json({ message: 'File uploaded temporarily.', fileUrl: req.file.filename }); // Send back filename, frontend will construct full path
};


const createNegotiation = async (req, res, next, io) => {
  try {
    const { transcriber_id, requirements, proposed_price_usd, deadline_hours, negotiation_file_url } = req.body;
    const clientId = req.user.userId;

    // Basic validation for required fields
    if (!transcriber_id || !requirements || !proposed_price_usd || !deadline_hours || !negotiation_file_url) {
      return res.status(400).json({ error: 'All fields (transcriber_id, requirements, proposed_price_usd, deadline_hours, and negotiation_file_url) are required.' });
    }

    // Check if the temporary file exists on the server
    const tempFilePath = path.join('uploads/temp_negotiation_files', negotiation_file_url);
    if (!fs.existsSync(tempFilePath)) {
        return res.status(400).json({ error: 'Uploaded file not found on server. Please re-upload the file.' });
    }

    // FIX: Check transcriber's availability and status directly from the 'users' table
    const { data: transcriberUser, error: transcriberError } = await supabase
      .from('users')
      .select(`
        id,
        full_name,
        email,
        is_online,
        is_available,
        current_job_id,
        transcriber_status,
        transcriber_user_level
      `)
      .eq('id', transcriber_id)
      .eq('user_type', 'transcriber')
      .eq('is_online', true)
      .eq('is_available', true)
      .is('current_job_id', null)
      .eq('transcriber_status', 'active_transcriber') // Check transcriber_status from 'users'
      .single();

    if (transcriberError || !transcriberUser) {
      // Clean up the temporary file if the transcriber is not found or not available
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
      console.error('createNegotiation: Transcriber not found or not available. Supabase Error:', transcriberError);
      return res.status(404).json({ error: 'Transcriber not found, not online, or not available for new jobs.' });
    }
    // Additional checks based on transcriber status
    if (!transcriberUser.is_available) {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      return res.status(400).json({ error: 'Transcriber is currently busy with another job or manually set to unavailable.' });
    }
    if (transcriberUser.current_job_id) {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
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
        if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
        return res.status(500).json({ error: existingNegError.message });
    }
    if (existingNegotiation) {
      // Clean up file if a pending negotiation already exists
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      return res.status(400).json({ error: 'You already have a pending negotiation with this transcriber. Please wait for their response or cancel the existing one.' });
    }

    // Move the temporary file to its permanent location
    const permanentUploadDir = 'uploads/negotiation_files';
    if (!fs.existsSync(permanentUploadDir)) {
      fs.mkdirSync(permanentUploadDir, { recursive: true });
    }
    const permanentFilePath = path.join(permanentUploadDir, negotiation_file_url);
    fs.renameSync(tempFilePath, permanentFilePath); // Atomically move the file

    // Calculate due_date
    const createdAt = new Date();
    const dueDate = new Date(createdAt.getTime() + deadline_hours * 60 * 60 * 1000); // Add hours to current time

    // Insert the new negotiation request
    const { data, error: insertError } = await supabase
      .from('negotiations')
      .insert([
        {
          client_id: clientId,
          transcriber_id: transcriber_id,
          requirements: requirements,
          agreed_price_usd: proposed_price_usd,
          deadline_hours: deadline_hours,
          due_date: dueDate.toISOString(),
          client_message: `Budget: USD ${proposed_price_usd}, Deadline: ${deadline_hours} hours`,
          negotiation_files: negotiation_file_url,
          status: 'pending'
        }
      ])
      .select()
      .single();

    if (insertError) {
      console.error('createNegotiation: Supabase error inserting new negotiation:', insertError);
      // Clean up the moved file if insertion fails
      if (fs.existsSync(permanentFilePath)) {
        fs.unlinkSync(permanentFilePath);
      }
      throw insertError;
    }

    const newNegotiation = data;

    // Emit a real-time event to the transcriber
    if (io) {
      io.to(transcriber_id).emit('new_negotiation_request', {
        negotiationId: newNegotiation.id,
        clientId: clientId,
        clientName: req.user.full_name,
        message: `You have a new negotiation request from ${req.user.full_name}.`,
        newStatus: 'pending'
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
      transcriber_name: transcriberUser.full_name
    });

  } catch (error) {
    console.error('createNegotiation: UNCAUGHT EXCEPTION:', error);
    res.status(500).json({ error: error.message || 'Failed to create negotiation due to server error.' });
  }
};

const getClientNegotiations = async (req, res) => {
  try {
    const clientId = req.user.userId;
    console.log(`Fetching client negotiations for client ID: ${clientId}`);

    // FIX: Fetch negotiations for the client, joining with transcriber details from 'users' table
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
        completed_at,           // NEW: Select completed_at
        client_feedback_comment, // NEW: Select client_feedback_comment
        client_feedback_rating,  // NEW: Select client_feedback_rating
        transcriber_id,
        transcriber:users!transcriber_id (
            id,
            full_name,
            email,
            transcriber_average_rating,
            transcriber_completed_jobs
        )
      `)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

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
        const { transcriber, ...rest } = negotiation;

        // Safely access transcriber profile data from the 'users' table
        const transcriberProfileData = transcriber || {}; // Transcriber object is directly from 'users' now
        console.log(`[getClientNegotiations] Processing negotiation ${negotiation.id}: Transcriber profile data:`, transcriberProfileData);

        return {
            ...rest,
            users: transcriber ? { // This 'users' key is for frontend consistency
                id: transcriber.id,
                full_name: transcriber.full_name,
                email: transcriber.email,
                // Use new column names from 'users' table
                average_rating: transcriberProfileData.transcriber_average_rating || 0.0,
                completed_jobs: transcriberProfileData.transcriber_completed_jobs || 0,
            } : {
                id: negotiation.transcriber_id,
                full_name: 'Unknown Transcriber',
                average_rating: 0.0,
                completed_jobs: 0
            }
        };
    });

    console.log('[getClientNegotiations] Formatted negotiations sent to frontend:', negotiationsWithTranscribers.map(n => ({ id: n.id, transcriberRating: n.users.average_rating, transcriberJobs: n.users.completed_jobs, dueDate: n.due_date })));
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

    // FIX: Fetch negotiations associated with the transcriber, joining with client details from the 'users' table
    // Also, ensure transcriber's own profile data is available (from 'users' table)
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
        completed_at,           // NEW: Select completed_at
        client_feedback_comment, // NEW: Select client_feedback_comment
        client_feedback_rating,  // NEW: Select client_feedback_rating
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

    // Process negotiations to format client and transcriber data cleanly
    const negotiationsWithClients = negotiations.map(negotiation => {
        const { client, transcriber, ...rest } = negotiation; // Destructure client and transcriber data from join

        return {
            ...rest, // All negotiation details
            client_info: client ? { // Client data from 'users' table
                id: client.id,
                full_name: client.full_name,
                email: client.email,
                phone: client.phone,
                client_rating: client.client_average_rating || 5.0, // Use client_average_rating
                client_completed_jobs: client.client_completed_jobs || 0, // Use client_completed_jobs
                client_comment: client.client_comment || null, // Use client_comment
            } : { // Fallback if client data is missing
                id: negotiation.client_id,
                full_name: 'Unknown Client',
                email: 'unknown@example.com',
                client_rating: 5.0,
                client_completed_jobs: 0,
                client_comment: null,
            },
            transcriber_info: transcriber ? { // Transcriber data from 'users' table
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
            } : null // Should not be null if query is correct for transcriber's own list
        };
    });

    console.log('[getTranscriberNegotiations] Formatted negotiations sent to frontend:', negotiationsWithClients.map(n => ({ id: n.id, clientRating: n.client_info.client_rating, dueDate: n.due_date })));
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
    const userId = req.user.userId;
    const userType = req.user.userType;

    // Fetch negotiation details to verify ownership and status
    const { data: negotiation, error: fetchError } = await supabase
      .from('negotiations')
      .select('status, client_id, negotiation_files, transcriber_id')
      .eq('id', negotiationId)
      .single();

    if (fetchError || !negotiation) {
      return res.status(404).json({ error: 'Negotiation not found.' });
    }

    // Admin bypasses all ownership and status checks for deletion
    if (userType !== 'admin') {
        // Ensure the user attempting deletion is the client
        if (negotiation.client_id !== userId) {
          return res.status(403).json({ error: 'You are not authorized to delete this negotiation.' });
        }

        // Define allowed statuses for deletion by clients
        const deletableStatuses = ['pending', 'accepted_awaiting_payment', 'rejected', 'cancelled', 'transcriber_counter', 'client_counter', 'completed'];
        if (!deletableStatuses.includes(negotiation.status)) {
          return res.status(400).json({ error: `Negotiations with status '${negotiation.status}' cannot be deleted. Only ${deletableStatuses.join(', ')} can be deleted by a client.` });
        }
    }

    // NEW: Always clear transcriber's current_job_id and set available to true if transcriber_id exists and the job was 'hired' or 'completed'
    if (negotiation.transcriber_id && (negotiation.status === 'hired' || negotiation.status === 'completed')) {
        console.log(`Attempting to free up transcriber ${negotiation.transcriber_id} for negotiation ${negotiationId}.`);
        await syncAvailabilityStatus(negotiation.transcriber_id, true, null);
        console.log(`Transcriber ${negotiation.transcriber_id} availability status updated.`);
    }

    // CRITICAL FIX: Delete associated messages first to satisfy FK constraint
    const { error: deleteMessagesError } = await supabase
        .from('messages')
        .delete()
        .eq('negotiation_id', negotiationId);

    if (deleteMessagesError) {
        console.error(`Error deleting messages for negotiation ${negotiationId}:`, deleteMessagesError);
        throw deleteMessagesError;
    }
    console.log(`Deleted messages for negotiation ${negotiationId}.`);


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
        newStatus: 'cancelled'
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
            .select('status, transcriber_id, client_id, agreed_price_usd, deadline_hours')
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
            return res.status(400).json({ error: 'Negotiation is not in a state that can be accepted. Current status: ' + negotiation.status });
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
                newStatus: 'accepted_awaiting_payment'
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
        const { proposed_price_usd, deadline_hours, transcriber_response } = req.body;
        const transcriberId = req.user.userId;

        // Validate input fields
        if (!proposed_price_usd || !deadline_hours || !transcriber_response) {
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
            return res.status(400).json({ error: 'Negotiation is not in a state that allows for a counter-offer. Current status: ' + negotiation.status });
        }

        // Update negotiation with counter-offer details
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({
                status: 'transcriber_counter',
                agreed_price_usd: proposed_price_usd,
                deadline_hours: deadline_hours,
                transcriber_response: transcriber_response,
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
                message: `Client ${req.user.full_name} sent a counter offer!`,
                newStatus: 'transcriber_counter'
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
        const { reason } = req.body;
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
            return res.status(400).json({ error: 'Negotiation is not in a state that can be rejected. Current status: ' + negotiation.status });
        }

        // Update negotiation status to 'rejected' and store the rejection reason
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'rejected', transcriber_response: reason, updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // Emit a real-time event to the client
        if (io) {
            io.to(negotiation.client_id).emit('negotiation_rejected', {
                negotiationId: updatedNegotiation.id,
                message: `Transcriber ${req.user.full_name} rejected your negotiation.`,
                newStatus: 'rejected'
            });
            console.log(`Emitted 'negotiation_rejected' to client ${negotiation.client_id}`);
        }

        // Send an email notification to the client
        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.client_id).single();
        if (clientError) console.error('Error fetching client for negotiation rejected email:', clientError);

        if (clientUser) {
            await emailService.sendNegotiationRejectedEmail(clientUser, req.user, updatedNegotiation);
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
            .select('status, transcriber_id, client_id, agreed_price_usd, deadline_hours')
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
            return res.status(400).json({ error: 'Negotiation is not in a state to accept a counter-offer. Current status: ' + negotiation.status });
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
                newStatus: 'accepted_awaitas_payment'
            });
            console.log(`Emitted 'negotiation_accepted' to transcriber ${negotiation.transcriber_id}`);
        }

        // Send an email notification to the transcriber
        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.transcriber_id).single();
        if (transcriberError) console.error('Error fetching transcriber for client accept counter email:', transcriberError);

        if (transcriberUser) {
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
        const { client_response } = req.body;
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
            return res.status(400).json({ error: 'Negotiation is not in a state that allows for a counter-offer. Current status: ' + negotiation.status });
        }

        // Update negotiation status to 'rejected' and store the client's response
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'rejected', client_response: client_response, updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw error;

        // Emit a real-time event to the transcriber
        if (io) {
            io.to(negotiation.transcriber_id).emit('negotiation_rejected', {
                negotiationId: updatedNegotiation.id,
                message: `Client ${req.user.full_name} rejected your counter-offer.`,
                newStatus: 'rejected'
            });
            console.log(`Emitted 'negotiation_rejected' to transcriber ${negotiation.transcriber_id}`);
        }

        // Send an email notification to the transcriber
        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.transcriber_id).single();
        if (transcriberError) console.error('Error fetching transcriber for client reject counter email:', transcriberError);

        if (transcriberUser) {
            await emailService.sendNegotiationRejectedEmail(transcriberUser, updatedNegotiation, client_response);
        }

        res.json({ message: 'Counter-offer rejected successfully.', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Client reject counter-offer error:', error);
        res.status(500).json({ error: error.message });
    }
};

const clientCounterBack = async (req, res, io) => {
    let negotiationFile = req.file;
    try {
        const { negotiationId } = req.params;
        const { proposed_price_usd, deadline_hours, client_response } = req.body;
        const clientId = req.user.userId;

        // Basic validation for required fields
        if (!proposed_price_usd || !deadline_hours || !client_response) {
            // Clean up the uploaded file if any required field is missing
            if (negotiationFile && fs.existsSync(negotiationFile.path)) {
                fs.unlinkSync(negotiationFile.path);
            }
            return res.status(400).json({ error: 'Proposed price, deadline, and message are required for a counter-offer back.' });
        }

        let negotiationFileName = null;
        if (negotiationFile) {
            negotiationFileName = negotiationFile.filename;
            const filePath = path.join('uploads/negotiation_files', negotiationFileName);
            if (!fs.existsSync(filePath)) {
                console.error(`CRITICAL WARNING: Uploaded file NOT found at expected path: ${filePath}`);
                if (negotiationFile && fs.existsSync(negotiationFile.path)) {
                    fs.unlinkSync(negotiationFile.path);
                }
                return res.status(500).json({ error: 'Uploaded file not found on server after processing. Please try again.' });
            }
        }

        // Fetch negotiation details to verify status and authorization
        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id, negotiation_files')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            // Clean up file if negotiation not found
            if (negotiationFile && fs.existsSync(negotiationFile.path)) {
                fs.unlinkSync(negotiationFile.path);
            }
            return res.status(404).json({ error: 'Negotiation not found.' });
        }

        // Authorize the user (must be the client)
        if (negotiation.client_id !== clientId) {
            // Clean up file if unauthorized
            if (negotiationFile && fs.existsSync(negotiationFile.path)) {
                fs.unlinkSync(negotiationFile.path);
            }
            return res.status(403).json({ error: 'You are not authorized to counter back on this negotiation.' });
        }

        // Check if the negotiation is in the 'transcriber_counter' state
        if (negotiation.status !== 'transcriber_counter') {
            // Clean up file if status is incorrect
            if (negotiationFile && fs.existsSync(negotiationFile.path)) {
                fs.unlinkSync(negotiationFile.path);
            }
            return res.status(400).json({ error: 'Negotiation is not in a state that allows for a counter-offer back. Current status: ' + negotiation.status });
        }

        // Determine the file name to use for the update
        const fileToUpdate = negotiationFileName || negotiation.negotiation_files;

        // Update negotiation with the client's counter-offer
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({
                status: 'client_counter',
                agreed_price_usd: proposed_price_usd,
                deadline_hours: deadline_hours,
                client_message: client_response,
                negotiation_files: fileToUpdate,
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) {
            console.error('Client counter back: Supabase error updating negotiation:', updateError);
            if (negotiationFile && fs.existsSync(negotiationFile.path)) {
                fs.unlinkSync(negotiationFile.path);
            }
            throw updateError;
        }

        // Emit a real-time event to the transcriber
        if (io) {
            io.to(negotiation.transcriber_id).emit('negotiation_countered', {
                negotiationId: updatedNegotiation.id,
                message: `Client ${req.user.full_name} sent a counter-offer back!`,
                newStatus: 'client_counter'
            });
            console.log(`Emitted 'negotiation_countered' to transcriber ${negotiation.transcriber_id}`);
        }

        // Send an email notification to the transcriber
        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.transcriber_id).single();
        if (transcriberError) console.error('Error fetching transcriber for client counter back email:', transcriberError);

        if (transcriberUser) {
            await emailService.sendCounterOfferEmail(transcriberUser, req.user, updatedNegotiation);
        }

        res.json({ message: 'Counter-offer sent successfully.', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Client counter back error: UNCAUGHT EXCEPTION:', error);
        if (negotiationFile && fs.existsSync(negotiationFile.path)) {
            try {
                fs.unlinkSync(negotiationFile.path);
                console.log(`Cleaned up uploaded file due to UNCAUGHT EXCEPTION: ${negotiationFile.path}`);
            } catch (unlinkError) {
                console.error(`Error deleting uploaded file after UNCAUGHT EXCEPTION in clientCounterBack: ${unlinkError}`);
            }
        }
        res.status(500).json({ error: error.message || 'Failed to send counter-offer due to server error.' });
    }
};

// NEW: Function to allow a client to mark a job as complete
const markJobCompleteByClient = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        // NEW: Extract clientFeedbackComment and clientFeedbackRating from the request body
        const { clientFeedbackComment, clientFeedbackRating } = req.body; 
        const clientId = req.user.userId;
        const userType = req.user.userType;

        // 1. Authorization: Only clients can mark a job as complete
        if (userType !== 'client') {
            return res.status(403).json({ error: 'Only clients are authorized to mark jobs as complete.' });
        }

        // 2. Fetch negotiation details to verify ownership and status
        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, client_id, transcriber_id, agreed_price_usd, deadline_hours')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.' });
        }

        // 3. Ownership check: Ensure the client owns this negotiation
        if (negotiation.client_id !== clientId) {
            return res.status(403).json({ error: 'You are not authorized to mark this job as complete.' });
        }

        // 4. Status check: Ensure the job is currently 'hired'
        if (negotiation.status !== 'hired') {
            return res.status(400).json({ error: `Job must be in 'hired' status to be marked as complete. Current status: ${negotiation.status}` });
        }

        // 5. Update negotiation status to 'completed' and store feedback
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ 
                status: 'completed', 
                completed_at: new Date().toISOString(), 
                client_feedback_comment: clientFeedbackComment, // NEW: Store client feedback comment
                client_feedback_rating: clientFeedbackRating,   // NEW: Store client feedback rating
                updated_at: new Date().toISOString() 
            })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // 6. Update transcriber's availability (set current_job_id to null and is_available to true)
        if (negotiation.transcriber_id) {
            await syncAvailabilityStatus(negotiation.transcriber_id, true, null);
            console.log(`Transcriber ${negotiation.transcriber_id} freed up after client marked job ${negotiationId} as complete.`);
        }

        // 7. Increment transcriber's completed_jobs count (now in 'users' table)
        const { data: updatedUser, error: incrementError } = await supabase
            .from('users')
            .select('transcriber_completed_jobs') // Select the current count
            .eq('id', negotiation.transcriber_id)
            .single();

        if (incrementError || !updatedUser) {
            console.warn(`Could not fetch transcriber profile for ID ${negotiation.transcriber_id} to increment completed jobs. Error:`, incrementError);
        } else {
            const newCompletedJobs = (updatedUser.transcriber_completed_jobs || 0) + 1;
            const { error: updateCountError } = await supabase
                .from('users')
                .update({ transcriber_completed_jobs: newCompletedJobs })
                .eq('id', negotiation.transcriber_id);

            if (updateCountError) {
                console.error(`Failed to increment transcriber_completed_jobs for transcriber ${negotiation.transcriber_id}:`, updateCountError);
            } else {
                console.log(`Incremented transcriber_completed_jobs for transcriber ${negotiation.transcriber_id} to ${newCompletedJobs}.`);
            }
        }

        // NEW: Increment client's completed_jobs count (now in 'users' table)
        const { data: updatedClientUser, error: fetchClientError } = await supabase
            .from('users')
            .select('client_completed_jobs') // Select the current count
            .eq('id', clientId)
            .single();

        if (fetchClientError || !updatedClientUser) {
            console.warn(`Could not fetch client profile for ID ${clientId} to increment completed jobs. Error:`, fetchClientError);
        } else {
            const newClientCompletedJobs = (updatedClientUser.client_completed_jobs || 0) + 1;
            const { error: updateClientCountError } = await supabase
                .from('users')
                .update({ client_completed_jobs: newClientCompletedJobs })
                .eq('id', clientId);

            if (updateClientCountError) {
                console.error(`Failed to increment client_completed_jobs for client ${clientId}:`, updateClientCountError);
            } else {
                console.log(`Incremented client_completed_jobs for client ${clientId} to ${newClientCompletedJobs}.`);
            }
        }


        // 8. Emit a real-time event to both client and transcriber
        if (io) {
            io.to(negotiation.client_id).emit('job_completed', {
                negotiationId: updatedNegotiation.id,
                message: `You marked job ${updatedNegotiation.id?.substring(0, 8)} as complete!`,
                newStatus: 'completed'
            });
            if (negotiation.transcriber_id) {
                io.to(negotiation.transcriber_id).emit('job_completed', {
                    negotiationId: updatedNegotiation.id,
                    message: `Client ${req.user.full_name} marked job ${updatedNegotiation.id?.substring(0, 8)} as complete.`,
                    newStatus: 'completed'
                });
                console.log(`Emitted 'job_completed' to transcriber ${negotiation.transcriber_id} and client ${negotiation.client_id}`);
            }
        }

        // 9. Send email notifications
        const { data: transcriberUser, error: transcriberUserError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.transcriber_id).single();
        if (transcriberUserError) console.error('Error fetching transcriber for job completed email:', transcriberUserError); // FIX: Removed extra comma

        if (transcriberUser) {
            await emailService.sendJobCompletedEmailToTranscriber(transcriberUser, req.user, updatedNegotiation);
            await emailService.sendJobCompletedEmailToClient(req.user, transcriberUser, updatedNegotiation);
        }

        res.json({ message: 'Job marked as complete successfully.', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Error marking job as complete by client:', error);
        res.status(500).json({ error: error.message || 'Failed to mark job as complete due to server error.' });
    }
};


module.exports = {
    uploadNegotiationFiles,
    uploadTempNegotiationFile,
    tempUploadNegotiationFile,
    getAvailableTranscribers,
    createNegotiation,
    getClientNegotiations,
    getTranscriberNegotiations, // FIX: Export getTranscriberNegotiations
    deleteNegotiation,
    syncAvailabilityStatus,
    acceptNegotiation,
    counterNegotiation,
    rejectNegotiation,
    clientAcceptCounter,
    clientRejectCounter,
    clientCounterBack,
    markJobCompleteByClient // NEW: Export the client-side job completion function
};
