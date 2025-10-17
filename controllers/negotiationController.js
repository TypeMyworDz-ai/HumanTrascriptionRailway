// backend/controllers/negotiationController.js - UPDATED for negotiation workflow logic

const supabase = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const emailService = require('../emailService');
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

    if (userError) {
        console.error(`Supabase error updating user availability for ${userId}:`, userError);
        throw userError;
    }
    if (transcriberError) {
        console.warn(`Transcribers table sync warning for ${userId}:`, transcriberError);
    }
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
      .eq('is_available', true)
      .is('current_job_id', null)
      .eq('transcribers.status', 'active_transcriber');

    if (error) {
        console.error('Supabase error fetching available transcribers::', error);
        throw error;
    }

    console.log('Raw transcribers data from Supabase:', transcribers);

    let availableTranscribers = (transcribers || []).filter(user =>
      user.transcribers &&
      user.transcribers.status === 'active_transcriber' &&
      user.is_online === true &&
      user.is_available === true &&
      user.current_job_id === null
    );

    availableTranscribers = availableTranscribers.map(user => ({
      id: user.id,
      status: user.transcribers.status,
      user_level: user.transcribers.user_level,
      is_online: user.is_online,
      is_available: user.is_available,
      average_rating: user.transcribers.average_rating || 5.0,
      completed_jobs: user.transcribers.completed_jobs || 0,
      badges: user.transcribers.badges,
      users: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        created_at: user.created_at
      }
    }));

    availableTranscribers.sort((a, b) => b.average_rating - a.average_rating);

    console.log('Processed available transcribers (after JS filter and sort):', availableTranscribers);

    if (availableTranscribers.length === 0 && process.env.NODE_ENV === 'development') {
      console.log('No transcribers found, creating sample data... (NOTE: This will create online/available users for testing)');

      const sampleUsers = [
        {
          full_name: 'Sarah Wanjiku',
          email: 'sarah@example.com',
          password_hash: '$2b$10$sample.hash.for.demo',
          user_type: 'transcriber',
          is_online: true,
          is_available: true,
          current_job_id: null
        },
        {
          full_name: 'John Kipchoge',
          email: 'john@example.com',
          password_hash: '$2b$10$sample.hash.for.demo',
          user_type: 'transcriber',
          is_online: true,
          is_available: true,
          current_job_id: null
        },
        {
          full_name: 'Grace Akinyi',
          email: 'grace@example.com',
          password_hash: '$2b$10$sample.hash.for.demo',
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
            id: user.id,
            status: 'active_transcriber',
            user_level: 'transcriber',
            average_rating: parseFloat((Math.random() * (5.0 - 4.0) + 4.0).toFixed(1)),
            completed_jobs: Math.floor(Math.random() * 50) + 10,
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
          availableTranscribers = insertedUsers.map((user, index) => ({
            id: user.id,
            status: 'active_transcriber',
            user_level: 'transcriber',
            is_online: true,
            is_available: true,
            average_rating: insertedProfiles[index].average_rating,
            completed_jobs: insertedProfiles[index].completed_jobs,
            badges: insertedProfiles[index].badges,
            users: {
              id: user.id,
              full_name: user.full_name,
              email: user.email,
              created_at: new Date().toISOString()
            }
          }));

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

// Create negotiation request (for clients)
const createNegotiation = async (req, res, next, io) => {
  try {
    const { transcriber_id, requirements, proposed_price_kes, deadline_hours } = req.body;
    const clientId = req.user.userId;

    const negotiationFile = req.file;
    let negotiationFileName = '';
    if (negotiationFile) {
      negotiationFileName = negotiationFile.filename;
      console.log(`createNegotiation: File uploaded. Filename: ${negotiationFileName}, Path: ${negotiationFile.path}`);
      // VERIFY: Check if this file path exists on the server after upload
      if (!fs.existsSync(negotiationFile.path)) {
          console.error(`createNegotiation: !!! WARNING !!! Uploaded file NOT found at expected path: ${negotiationFile.path}`);
          // You might want to return an error here if the file is genuinely missing
      } else {
          console.log(`createNegotiation: Confirmed file exists at: ${negotiationFile.path}`);
      }
    } else {
      return res.status(400).json({ error: 'Audio/video file is required for negotiation' });
    }

    if (!transcriber_id || !requirements || !proposed_price_kes || !deadline_hours) {
      if (negotiationFile) fs.unlinkSync(negotiationFile.path);
      return res.status(400).json({ error: 'All fields are required' });
    }

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
      if (negotiationFile) fs.unlinkSync(negotiationFile.path);
      return res.status(404).json({ error: 'Transcriber not found or not available' });
    }

    if (!transcriberUser.is_available) {
      if (negotiationFile) fs.unlinkSync(negotiationFile.path);
      return res.status(400).json({ error: 'Transcriber is currently busy with another job or manually set to busy' });
    }
    if (transcriberUser.current_job_id) {
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
          status: 'pending' // Initial status: pending
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
    console.error('Create negotiation error:', error);
    res.status(500).json({ error: error.message });
  }
};

// UPDATED: Get client's negotiations - FIXED FOR NEW DATA MODEL AND SUPABASE BEHAVIOR
const getClientNegotiations = async (req, res) => {
  try {
    const clientId = req.user.userId;
    console.log(`Fetching client negotiations for client ID: \${clientId}`);

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

    const negotiationsWithTranscribers = negotiations.map(negotiation => {
        const { transcriber, ...rest } = negotiation;

        const transcriberProfileData = transcriber?.transcribers?.[0] || {};

        return {
            ...rest,
            users: transcriber ? {
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
const deleteNegotiation = async (req, res, io) => { // Added io to parameters
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

    if (negotiation.status !== 'pending' && negotiation.status !== 'accepted_awaiting_payment') { // Allow deletion if awaiting payment
      return res.status(400).json({ error: 'Only pending or awaiting payment negotiations can be deleted' });
    }

    if (negotiation.negotiation_files) {
      const filePath = path.join('uploads/negotiation_files', negotiation.negotiation_files);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Deleted negotiation file: ${filePath}`);
      } else {
        console.warn(`Negotiation file not found on disk for deletion: ${filePath}`);
      }
    }

    const { error: deleteError } = await supabase
      .from('negotiations')
      .delete()
      .eq('id', negotiationId);

    if (deleteError) throw deleteError;

    // Emit real-time notification to the transcriber that the negotiation was deleted
    if (io && negotiation.transcriber_id) {
      io.to(negotiation.transcriber_id).emit('negotiation_cancelled', {
        negotiationId: negotiation.id,
        message: `A negotiation request from ${req.user.full_name} was cancelled.`
      });
      console.log(`Emitted 'negotiation_cancelled' to transcriber ${negotiation.transcriber_id}`);
    }

    res.json({ message: 'Negotiation deleted successfully' });

  } catch (error) {
    console.error('Delete negotiation error:', error);
    res.status(500).json({ error: error.message });
  }
};

// NEW: Transcriber accepts a negotiation
const acceptNegotiation = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const transcriberId = req.user.userId;

        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id, agreed_price_kes, deadline_hours')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.' });
        }

        if (negotiation.transcriber_id !== transcriberId) {
            return res.status(403).json({ error: 'You are not authorized to accept this negotiation.' });
        }

        if (negotiation.status !== 'pending' && negotiation.status !== 'client_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state to be accepted.' });
        }

        // Update negotiation status to 'accepted_awaiting_payment'
        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'accepted_awaiting_payment', updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // Notify client (real-time)
        if (io) {
            io.to(negotiation.client_id).emit('negotiation_accepted', {
                negotiationId: updatedNegotiation.id,
                message: `Your negotiation with ${req.user.full_name} has been accepted!`,
                newStatus: 'accepted_awaiting_payment'
            });
            console.log(`Emitted 'negotiation_accepted' to client ${negotiation.client_id}`);
        }

        // Send email to client
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

// NEW: Transcriber counters a negotiation
const counterNegotiation = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const { proposed_price_kes, deadline_hours, transcriber_response } = req.body;
        const transcriberId = req.user.userId;

        if (!proposed_price_kes || !deadline_hours || !transcriber_response) {
            return res.status(400).json({ error: 'Proposed price, deadline, and response are required.' });
        }

        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.' });
        }

        if (negotiation.transcriber_id !== transcriberId) {
            return res.status(403).json({ error: 'You are not authorized to counter this negotiation.' });
        }

        if (negotiation.status !== 'pending' && negotiation.status !== 'client_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state to be countered.' });
        }

        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({
                status: 'transcriber_counter',
                agreed_price_kes: proposed_price_kes,
                deadline_hours: deadline_hours,
                transcriber_response: transcriber_response,
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // Notify client (real-time)
        if (io) {
            io.to(negotiation.client_id).emit('negotiation_countered', {
                negotiationId: updatedNegotiation.id,
                message: `Transcriber ${req.user.full_name} sent a counter offer!`,
                newStatus: 'transcriber_counter'
            });
            console.log(`Emitted 'negotiation_countered' to client ${negotiation.client_id}`);
        }

        // Send email to client
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

// NEW: Transcriber rejects a negotiation
const rejectNegotiation = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const { reason } = req.body;
        const transcriberId = req.user.userId;

        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.' });
        }

        if (negotiation.transcriber_id !== transcriberId) {
            return res.status(403).json({ error: 'You are not authorized to reject this negotiation.' });
        }

        if (negotiation.status !== 'pending' && negotiation.status !== 'client_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state to be rejected.' });
        }

        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'rejected', transcriber_response: reason, updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // Notify client (real-time)
        if (io) {
            io.to(negotiation.client_id).emit('negotiation_rejected', {
                negotiationId: updatedNegotiation.id,
                message: `Transcriber ${req.user.full_name} rejected your negotiation.`,
                newStatus: 'rejected'
            });
            console.log(`Emitted 'negotiation_rejected' to client ${negotiation.client_id}`);
        }

        // Send email to client
        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.client_id).single();
        if (clientError) console.error('Error fetching client for negotiation rejected email:', clientError);

        if (clientUser) {
            await emailService.sendNegotiationRejectedEmail(clientUser, updatedNegotiation, reason);
        }

        res.json({ message: 'Negotiation rejected successfully.', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Reject negotiation error:', error);
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
  acceptNegotiation, // NEW: Export
  counterNegotiation, // NEW: Export
  rejectNegotiation // NEW: Export
};
