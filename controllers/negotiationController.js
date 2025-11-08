const supabase = require('..//database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
    sendNewNegotiationRequestEmail,
    sendTranscriberCounterOfferEmail,
    sendClientCounterBackEmail,
    sendNegotiationAcceptedEmail,
    sendPaymentConfirmationEmail,
    sendNegotiationRejectedEmail,
    sendJobCompletedEmailToTranscriber,
    sendJobCompletedEmailToClient
} = require('..//emailService');

const axios = require('axios');
const { calculateTranscriberEarning, convertUsdToKes, EXCHANGE_RATE_USD_TO_KES } = require('..//utils/paymentUtils');
const http = require('http');
const https = require('https');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const CLIENT_URL = process.env.CLIENT_URL || 'http:--localhost:3000';
const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY;
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY;
const KORAPAY_BASE_URL = process.env.KORAPAY_BASE_URL || 'https:--api-sandbox.korapay.com-v1';
const KORAPAY_WEBHOOK_URL = process.env.KORAPAY_WEBHOOK_URL || 'http:--localhost:5000-api-payment-korapay-webhook';

const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

const { syncAvailabilityStatus } = require('./transcriberController');

const MAX_FILE_SIZE = 500 * 1024 * 1024;

const getNextFriday = () => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
    const nextFriday = new Date(today);
    nextFriday.setDate(today.getDate() + daysUntilFriday);
    nextFriday.setHours(23, 59, 59, 999);
    return nextFriday.toISOString();
};

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
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif'
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only audio, video, PDF, DOC, DOCX, TXT, and image files are allowed for negotiation attachments!'), false);
  }
};

const uploadNegotiationFiles = multer({
  storage: negotiationFileStorage,
  fileFilter: negotiationFileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE
  }
}).single('negotiationFile');

const tempNegotiationFileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/temp_negotiation_files';
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
  fileFilter: negotiationFileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE
  }
}).single('negotiationFile');


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
        current_job_id,
        transcriber_status,
        transcriber_user_level,
        transcriber_average_rating,
        transcriber_completed_jobs,
        transcriber_mpesa_number,
        transcriber_paypal_email
      `)
      .eq('user_type', 'transcriber')
      .eq('is_online', true)
      .is('current_job_id', null)
      .eq('transcriber_status', 'active_transcriber');

    if (error) {
        console.error('Supabase error fetching available transcribers:', error);
        throw error;
    }

    const filteredTranscribers = (transcribers || []).filter(
      (user) => user.transcriber_user_level !== 'trainee'
    );

    let availableTranscribers = filteredTranscribers
      .map(user => ({
        id: user.id,
        status: user.transcriber_status,
        user_level: user.transcriber_user_level,
        is_online: user.is_online,
        average_rating: user.transcriber_average_rating || 0.0,
        completed_jobs: user.transcriber_completed_jobs || 0,
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

    if (availableTranscribers.length === 0 && process.env.NODE_ENV === 'development') {
      console.log('No transcribers found, creating sample data...');

      const sampleUsers = [
        { full_name: 'Sarah Wanjiku', email: 'sarah@example.com', password_hash: '$2b$10$sample.hash.for.demo', user_type: 'transcriber', is_online: true, current_job_id: null, transcriber_status: 'active_transcriber', transcriber_user_level: 'transcriber', transcriber_average_rating: 4.5, transcriber_completed_jobs: 15 },
        { full_name: 'John Kipchoge', email: 'john@example.com', password_hash: '$2b$10$sample.hash.for.demo', user_type: 'transcriber', is_online: true, current_job_id: null, transcriber_status: 'active_transcriber', transcriber_user_level: 'transcriber', transcriber_average_rating: 4.2, transcriber_completed_jobs: 10 },
        { full_name: 'Grace Akinyi', email: 'grace@example.com', password_hash: '$2b$10$sample.hash.for.demo', user_type: 'transcriber', is_online: true, current_job_id: null, transcriber_status: 'active_transcriber', transcriber_user_level: 'transcriber', transcriber_average_rating: 4.8, transcriber_completed_jobs: 20 }
      ];

      const { data: insertedUsers, error: insertUserError } = await supabase
        .from('users')
        .insert(sampleUsers.map(u => ({
            ...u,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })))
        .select('*');

      if (insertUserError) {
        console.error('Error creating sample users for transcribers:', insertUserError);
      } else {
        const sampleTranscriberMarkers = insertedUsers.map(user => ({ id: user.id }));
        const { error: insertProfileError } = await supabase
            .from('transcribers')
            .insert(sampleTranscriberMarkers);

        if (insertProfileError) {
          console.error('Error creating sample transcriber marker profiles:', insertProfileError);
        } else {
          availableTranscribers = insertedUsers.map(user => ({
            id: user.id,
            status: user.transcriber_status,
            user_level: user.transcriber_user_level,
            is_online: user.is_online,
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
    console.error('Get available transcribers error:', error);
    res.status(500).json({ error: error.message });
  }
};

const tempUploadNegotiationFile = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded or file type not allowed.ᐟ' });
    }

    const fileUrl = `/uploads/temp_negotiation_files/${req.file.filename}`;
    res.status(200).json({ message: 'File uploaded temporarily.ᐟ', fileUrl: req.file.filename });
};


const createNegotiation = async (req, res, next, io) => {
  try {
    const { transcriber_id, requirements, proposed_price_usd, deadline_hours, negotiation_file_url } = req.body;
    const clientId = req.user.userId;

    if (!transcriber_id || !requirements || !proposed_price_usd || !deadline_hours || !negotiation_file_url) {
      return res.status(400).json({ error: 'All fields (transcriber_id, requirements, proposed_price_usd, deadline_hours, and negotiation_file_url) are required.ᐟ' });
    }

    const tempFilePath = path.join('uploads/temp_negotiation_files', negotiation_file_url);
    if (!fs.existsSync(tempFilePath)) {
        return res.status(400).json({ error: 'Uploaded file not found on server. Please re-upload the file.ᐟ' });
    }

    const { data: transcriberUser, error: transcriberError } = await supabase
      .from('users')
      .select(`
        id,
        full_name,
        email,
        is_online,
        current_job_id,
        transcriber_status,
        transcriber_user_level
      `)
      .eq('id', transcriber_id)
      .eq('user_type', 'transcriber')
      .eq('is_online', true)
      .is('current_job_id', null)
      .eq('transcriber_status', 'active_transcriber')
      .single();

    if (transcriberError || !transcriberUser) {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
      console.error('createNegotiation: Transcriber not found or not available. Supabase Error:', transcriberError);
      return res.status(404).json({ error: 'Transcriber not found, not online, or not available for new jobs.ᐟ' });
    }
    if (transcriberUser.current_job_id) {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        return res.status(400).json({ error: 'Transcriber is currently busy with an active job.ᐟ' });
    }

    const { data: existingNegotiation, error: existingNegError } = await supabase
      .from('negotiations')
      .select('id')
      .eq('client_id', clientId)
      .eq('transcriber_id', transcriber_id)
      .eq('status', 'pending')
      .single();

    if (existingNegError && existingNegError.code !== 'PGRST116') {
        console.error('createNegotiation: Supabase error checking existing negotiation:', existingNegError);
        if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
        return res.status(500).json({ error: existingNegError.message });
    }
    if (existingNegotiation) {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      return res.status(400).json({ error: 'You already have a pending negotiation with this transcriber. Please wait for their response or cancel the existing one.ᐟ' });
    }

    const permanentUploadDir = 'uploads/negotiation_files';
    if (!fs.existsSync(permanentUploadDir)) {
      fs.mkdirSync(permanentUploadDir, { recursive: true });
    }
    const permanentFilePath = path.join(permanentUploadDir, negotiation_file_url);
    fs.renameSync(tempFilePath, permanentFilePath);

    const createdAt = new Date();
    const dueDate = new Date(createdAt.getTime() + deadline_hours * 60 * 60 * 1000);

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
      if (fs.existsSync(permanentFilePath)) {
        fs.unlinkSync(permanentFilePath);
      }
      throw insertError;
    }

    const newNegotiation = data;

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

    const clientDetailsForEmail = {
        full_name: req.user.full_name,
        email: req.user.email
    };
    const transcriberDetailsForEmail = {
        full_name: transcriberUser.full_name,
        email: transcriberUser.email
    };

    if (transcriberDetailsForEmail && transcriberDetailsForEmail.email && clientDetailsForEmail && clientDetailsForEmail.email) {
        await sendNewNegotiationRequestEmail(transcriberDetailsForEmail, clientDetailsForEmail);
    }

    res.status(201).json({
      message: 'Negotiation request sent successfully',
      negotiation: newNegotiation,
      transcriber_name: transcriberUser.full_name
    });

  } catch (error) {
    console.error('createNegotiation: UNCAUGHT EXCEPTION:', error);
    res.status(500).json({ error: error.message || 'Failed to create negotiation due to server error.ᐟ' });
  }
};

const getClientNegotiations = async (req, res) => {
  try {
    const clientId = req.user.userId;
    console.log(`Fetching client negotiations for client ID: ${clientId}`);

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
        completed_at,           
        client_feedback_comment, 
        client_feedback_rating,  
        client_id,
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
      console.error('Negotiations query error:ᐟ', negotiationsError);
      throw negotiationsError;
    }

    if (!negotiations || negotiations.length === 0) {
      return res.json({
        message: 'No negotiations found',
        negotiations: []
      });
    }

    const negotiationsWithTranscribers = negotiations.map(negotiation => {
        const { transcriber, ...rest } = negotiation;

        const transcriberProfileData = transcriber || {};
        console.log(`[getClientNegotiations] Processing negotiation ${negotiation.id}: Transcriber profile data:`, transcriberProfileData);

        return {
            ...rest,
            transcriber_info: transcriber ? {
                id: transcriber.id,
                full_name: transcriber.full_name,
                email: transcriber.email,
                transcriber_average_rating: transcriberProfileData.transcriber_average_rating || 0.0,
                transcriber_completed_jobs: transcriberProfileData.transcriber_completed_jobs || 0,
            } : {
                id: rest.transcriber_id,
                full_name: 'Unknown Transcriber',
                email: 'unknown@example.com',
                transcriber_average_rating: 0.0,
                transcriber_completed_jobs: 0
            }
        };
    });

    console.log('[getClientNegotiations] Formatted negotiations sent to frontend:ᐟ', negotiationsWithTranscribers.map(n => ({ id: n.id, transcriberRating: n.transcriber_info.transcriber_average_rating, transcriberJobs: n.transcriber_info.transcriber_completed_jobs, dueDate: n.due_date, status: n.status })));
    res.json({
      message: 'Negotiations retrieved successfully',
      negotiations: negotiationsWithTranscribers
    });

  } catch (error) {
    console.error('Get client negotiations error:ᐟ', error);
    res.status(500).json({ error: error.message });
  }
};

const getTranscriberNegotiations = async (req, res) => {
  try {
    const transcriberId = req.user.userId;

    console.log('Get transcriber negotiations for:ᐟ', transcriberId);

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
        completed_at,           
        client_feedback_comment, 
        client_feedback_rating,  
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
      console.error('Transcriber negotiations query error:ᐟ', negotiationsError);
      throw negotiationsError;
    }

    if (!negotiations || negotiations.length === 0) {
      return res.json({
        message: 'No negotiations found',
        negotiations: []
      });
    }

    const negotiationsWithClients = negotiations.map(negotiation => {
        const { client, transcriber, ...rest } = negotiation;

        return {
            ...rest,
            jobType: 'negotiation', // Explicitly set jobType
            client_info: client ? {
                id: client.id,
                full_name: client.full_name,
                email: client.email,
                phone: client.phone,
                client_average_rating: client.client_average_rating || 0.0,
                client_completed_jobs: client.client_completed_jobs || 0,
                client_comment: client.client_comment || null,
            } : {
                id: negotiation.client_id,
                full_name: 'Unknown Client',
                email: 'unknown@example.com',
                client_average_rating: 0.0,
                client_completed_jobs: 0,
                client_comment: null,
            },
            transcriber_info: transcriber ? {
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
            } : null
        };
    });

    console.log('[getTranscriberNegotiations] Formatted negotiations sent to frontend:ᐟ', negotiationsWithClients.map(n => ({ id: n.id, clientRating: n.client_info.client_average_rating, clientJobs: n.client_info.client_completed_jobs, dueDate: n.due_date, status: n.status })));
    res.json({
      message: 'Transcriber negotiations retrieved successfully',
      negotiations: negotiationsWithClients
    });

  } catch (error) {
    console.error('Get transcriber negotiations error:ᐟ', error);
    res.status(500).json({ error: error.message });
  }
};

const deleteNegotiation = async (req, res, io) => {
  try {
    const { negotiationId } = req.params;
    const userId = req.user.userId;
    const userType = req.user.userType;

    const { data: negotiation, error: fetchError } = await supabase
      .from('negotiations')
      .select('status, client_id, negotiation_files, transcriber_id')
      .eq('id', negotiationId)
      .single();

    if (fetchError || !negotiation) {
      return res.status(404).json({ error: 'Negotiation not found.ᐟ' });
    }

    if (userType !== 'admin') {
        if (negotiation.client_id !== userId) {
          return res.status(403).json({ error: 'You are not authorized to delete this negotiation.ᐟ' });
        }

        const deletableStatuses = ['pending', 'accepted_awaiting_payment', 'rejected', 'cancelled', 'transcriber_counter', 'client_counter', 'completed'];
        if (!deletableStatuses.includes(negotiation.status)) {
          return res.status(400).json({ error: `Negotiations with status '${negotiation.status}' cannot be deleted. Only ${deletableStatuses.join(', ')} can be deleted by a client.ᐟ` });
        }
    }

    if (negotiation.transcriber_id && (negotiation.status === 'hired' || negotiation.status === 'completed')) {
        console.log(`Attempting to free up transcriber ${negotiation.transcriber_id} for negotiation ${negotiationId}.`);
        await syncAvailabilityStatus(negotiation.transcriber_id, null);
        console.log(`Transcriber ${negotiation.transcriber_id} availability status updated.`);
    }

    const { error: deleteMessagesError } = await supabase
        .from('messages')
        .delete()
        .eq('negotiation_id', negotiationId);

    if (deleteMessagesError) {
        console.error(`Error deleting messages for negotiation ${negotiationId}:`, deleteMessagesError);
        throw deleteMessagesError;
    }
    console.log(`Deleted messages for negotiation ${negotiationId}.`);


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
    console.error('Delete negotiation error:ᐟ', error);
    res.status(500).json({ error: error.message });
  }
};

const acceptNegotiation = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const transcriberId = req.user.userId;

        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id, agreed_price_usd, deadline_hours')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.ᐟ' });
        }

        if (negotiation.transcriber_id !== transcriberId) {
            return res.status(403).json({ error: 'You are not authorized to accept this negotiation.ᐟ' });
        }

        if (negotiation.status !== 'pending' && negotiation.status !== 'client_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state that can be accepted. Current status: ' + negotiation.status });
        }

        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'accepted_awaiting_payment', updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        if (io) {
            io.to(negotiation.client_id).emit('negotiation_accepted', {
                negotiationId: updatedNegotiation.id,
                message: `Your negotiation with ${req.user.full_name} has been accepted!`,
                newStatus: 'accepted_awaiting_payment'
            });
            console.log(`Emitted 'negotiation_accepted' to client ${negotiation.client_id}`);
        }

        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.client_id).single();
        if (clientError) console.error('Error fetching client for negotiation accepted email:ᐟ', clientError);

        if (clientUser) {
            await sendNegotiationAcceptedEmail(clientUser, req.user, updatedNegotiation);
        }

        res.json({ message: 'Negotiation accepted. Awaiting client payment.ᐟ', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Accept negotiation error:ᐟ', error);
        res.status(500).json({ error: error.message });
    }
};

const counterNegotiation = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const { proposed_price_usd, transcriber_response } = req.body;
        const transcriberId = req.user.userId;

        if (!proposed_price_usd) {
            return res.status(400).json({ error: 'Proposed price is required for a counter-offer.ᐟ' });
        }

        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id, deadline_hours')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.ᐟ' });
        }

        if (negotiation.transcriber_id !== transcriberId) {
            return res.status(403).json({ error: 'You are not authorized to make a counter-offer on this negotiation.ᐟ' });
        }

        if (negotiation.status !== 'pending' && negotiation.status !== 'client_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state that allows for a counter-offer. Current status: ' + negotiation.status });
        }

        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({
                status: 'transcriber_counter',
                agreed_price_usd: proposed_price_usd,
                deadline_hours: negotiation.deadline_hours,
                transcriber_response: transcriber_response,
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        if (io) {
            io.to(negotiation.client_id).emit('negotiation_countered', {
                negotiationId: updatedNegotiation.id,
                message: `Transcriber ${req.user.full_name} sent a counter offer!`,
                newStatus: 'transcriber_counter'
            });
            console.log(`Emitted 'negotiation_countered' to client ${negotiation.client_id}`);
        }

        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.client_id).single();
        if (clientError) console.error('Error fetching client for counter offer email:ᐟ', clientError);

        if (clientUser) {
            await sendTranscriberCounterOfferEmail(clientUser, req.user, updatedNegotiation);
        }

        res.json({ message: 'Counter offer sent successfully.ᐟ', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Counter negotiation error:ᐟ', error);
        res.status(500).json({ error: error.message });
    }
};

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
            return res.status(404).json({ error: 'Negotiation not found.ᐟ' });
        }

        if (negotiation.transcriber_id !== transcriberId) {
            return res.status(403).json({ error: 'You are not authorized to reject this negotiation.ᐟ' });
        }

        if (negotiation.status !== 'pending' && negotiation.status !== 'client_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state that can be rejected. Current status: ' + negotiation.status });
        }

        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'rejected', transcriber_response: reason, updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        if (io) {
            io.to(negotiation.client_id).emit('negotiation_rejected', {
                negotiationId: updatedNegotiation.id,
                message: `Transcriber ${req.user.full_name} rejected your negotiation.`,
                newStatus: 'rejected'
            });
            console.log(`Emitted 'negotiation_rejected' to client ${negotiation.client_id}`);
        }

        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.client_id).single();
        if (clientError) console.error('Error fetching client for negotiation rejected email:ᐟ', clientError);

        if (clientUser) {
            await sendNegotiationRejectedEmail(clientUser, updatedNegotiation, reason);
        }

        res.json({ message: 'Negotiation rejected successfully.ᐟ', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Reject negotiation error:ᐟ', error);
        res.status(500).json({ error: error.message });
    }
};

const clientAcceptCounter = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const clientId = req.user.userId;

        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id, agreed_price_usd, deadline_hours')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.ᐟ' });
        }

        if (negotiation.client_id !== clientId) {
            return res.status(403).json({ error: 'You are not authorized to accept this counter-offer.ᐟ' });
        }

        if (negotiation.status !== 'transcriber_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state to accept a counter-offer. Current status: ' + negotiation.status });
        }

        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'accepted_awaiting_payment', updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        if (io) {
            io.to(negotiation.transcriber_id).emit('negotiation_accepted', {
                negotiationId: updatedNegotiation.id,
                message: `Client ${req.user.full_name} accepted your counter-offer!`,
                newStatus: 'accepted_awaiting_payment'
            });
            console.log(`Emitted 'negotiation_accepted' to transcriber ${negotiation.transcriber_id}`);
        }

        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.transcriber_id).single();
        if (transcriberError) console.error('Error fetching transcriber for client accept counter email:ᐟ', transcriberError);

        if (transcriberUser) {
            await sendNegotiationAcceptedEmail(req.user, transcriberUser, updatedNegotiation);
        }

        res.json({ message: 'Counter-offer accepted. Proceed to payment.ᐟ', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Client accept counter-offer error:ᐟ', error);
        res.status(500).json({ error: error.message });
    }
};

const clientRejectCounter = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const { client_response } = req.body;
        const clientId = req.user.userId;

        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.ᐟ' });
        }

        if (negotiation.client_id !== clientId) {
            return res.status(403).json({ error: 'You are not authorized to reject this counter-offer.ᐟ' });
        }

        if (negotiation.status !== 'transcriber_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state that allows for a counter-offer. Current status: ' + negotiation.status });
        }

        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ status: 'rejected', client_response: client_response, updated_at: new Date().toISOString() })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw error;

        if (io) {
            io.to(negotiation.transcriber_id).emit('negotiation_rejected', {
                negotiationId: updatedNegotiation.id,
                message: `Client ${req.user.full_name} rejected your counter-offer.`,
                newStatus: 'rejected'
            });
            console.log(`Emitted 'negotiation_rejected' to transcriber ${negotiation.transcriber_id}`);
        }

        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.transcriber_id).single();
        if (transcriberError) console.error('Error fetching transcriber for client reject counter email:ᐟ', transcriberError);

        if (transcriberUser) {
            await sendNegotiationRejectedEmail(transcriberUser, updatedNegotiation, client_response);
        }

        res.json({ message: 'Counter-offer rejected successfully.ᐟ', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Client reject counter-offer error:ᐟ', error);
        res.status(500).json({ error: error.message });
    }
};

const clientCounterBack = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const { proposed_price_usd, client_response } = req.body;
        const clientId = req.user.userId;

        if (!proposed_price_usd) {
            return res.status(400).json({ error: 'Proposed price is required for a counter-offer back.ᐟ' });
        }

        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, transcriber_id, client_id, negotiation_files, deadline_hours')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.ᐟ' });
        }

        if (negotiation.client_id !== clientId) {
            return res.status(403).json({ error: 'You are not authorized to counter back on this negotiation.ᐟ' });
        }

        if (negotiation.status !== 'transcriber_counter') {
            return res.status(400).json({ error: 'Negotiation is not in a state that allows for a counter-offer back. Current status: ' + negotiation.status });
        }

        const fileToUpdate = negotiation.negotiation_files;
        const retainedDeadlineHours = negotiation.deadline_hours;

        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({
                status: 'client_counter',
                agreed_price_usd: proposed_price_usd,
                deadline_hours: retainedDeadlineHours,
                client_message: client_response,
                negotiation_files: fileToUpdate,
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) {
            console.error('Client counter back: Supabase error updating negotiation:', updateError);
            throw updateError;
        }

        if (io) {
            io.to(negotiation.transcriber_id).emit('negotiation_countered', {
                negotiationId: updatedNegotiation.id,
                message: `Client ${req.user.full_name} sent a counter-offer back!`,
                newStatus: 'client_counter'
            });
            console.log(`Emitted 'negotiation_countered' to transcriber ${negotiation.transcriber_id}`);
        }

        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.transcriber_id).single();
        if (transcriberError) console.error('Error fetching transcriber for client counter back email:ᐟ', transcriberError);

        if (transcriberUser) {
            await sendClientCounterBackEmail(transcriberUser, req.user, updatedNegotiation);
        }

        res.json({ message: 'Counter-offer sent successfully.ᐟ', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Client counter back error: UNCAUGHT EXCEPTION:ᐟ', error);
        res.status(500).json({ error: error.message || 'Failed to send counter-offer due to server error.ᐟ' });
    }
};

const markJobCompleteByClient = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const { clientFeedbackComment, clientFeedbackRating } = req.body;
        const clientId = req.user.userId;
        const userType = req.user.userType;

        if (userType !== 'client') {
            return res.status(403).json({ error: 'Only clients are authorized to mark jobs as complete.ᐟ' });
        }

        const { data: negotiation, error: fetchError } = await supabase
            .from('negotiations')
            .select('status, client_id, transcriber_id, agreed_price_usd, deadline_hours')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found.ᐟ' });
        }

        if (negotiation.client_id !== clientId) {
            return res.status(403).json({ error: 'You are not authorized to mark this job as complete.ᐟ' });
        }

        if (negotiation.status !== 'hired') {
            return res.status(400).json({ error: `Job must be in 'hired' status to be marked as complete. Current status: ${negotiation.status}` });
        }

        const { data: updatedNegotiation, error: updateError } = await supabase
            .from('negotiations')
            .update({ 
                status: 'completed', 
                completed_at: new Date().toISOString(), 
                client_feedback_comment: clientFeedbackComment,
                client_feedback_rating: clientFeedbackRating,
                updated_at: new Date().toISOString() 
            })
            .eq('id', negotiationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // UPDATED: Update payment payout_status to 'pending' when client completes negotiation job
        const { error: paymentUpdateError } = await supabase
            .from('payments')
            .update({ payout_status: 'pending', updated_at: new Date().toISOString() })
            .eq('negotiation_id', negotiationId)
            .eq('transcriber_id', negotiation.transcriber_id) // Ensure we target the correct transcriber's payment
            .eq('payout_status', 'awaiting_completion'); // Only update if it's awaiting completion

        if (paymentUpdateError) {
            console.error(`[markJobCompleteByClient] Error updating payment record for negotiation ${negotiationId} to 'pending':`, paymentUpdateError);
        } else {
            console.log(`[markJobCompleteByClient] Payment record for negotiation ${negotiationId} updated to 'pending' payout status.`);
        }


        if (negotiation.transcriber_id) {
            await syncAvailabilityStatus(negotiation.transcriber_id, null);
            console.log(`Transcriber ${negotiation.transcriber_id} freed up after client marked job ${negotiationId} as complete.`);
        }

        const { data: updatedUser, error: incrementError } = await supabase
            .from('users')
            .select('transcriber_completed_jobs')
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

        const { data: updatedClientUser, error: fetchClientError } = await supabase
            .from('users')
            .select('client_completed_jobs')
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

        const { data: transcriberUser, error: transcriberUserError } = await supabase.from('users').select('full_name, email').eq('id', negotiation.transcriber_id).single();
        if (transcriberUserError) console.error('Error fetching transcriber for job completed email:ᐟ', transcriberUserError);

        if (transcriberUser) {
            await sendJobCompletedEmailToTranscriber(transcriberUser, req.user, updatedNegotiation);
            await sendJobCompletedEmailToClient(req.user, transcriberUser, updatedNegotiation);
        }

        res.json({ message: 'Job marked as complete successfully.ᐟ', negotiation: updatedNegotiation });

    } catch (error) {
        console.error('Error marking job as complete by client:ᐟ', error);
        res.status(500).json({ error: error.message || 'Failed to mark job as complete due to server error.ᐟ' });
    }
};

const initializeNegotiationPayment = async (req, res, io) => {
    console.log('[initializeNegotiationPayment] Received request body:', req.body);

    const { negotiationId, amount, email, paymentMethod = 'paystack', mobileNumber } = req.body;
    const clientId = req.user.userId;

    const finalJobId = negotiationId;
    const finalClientEmail = email;

    console.log(`[initializeNegotiationPayment] Destructured parameters - negotiationId: ${finalJobId}, amount: ${amount}, clientEmail: ${finalClientEmail}, clientId: ${clientId}, paymentMethod: ${paymentMethod}, mobileNumber: ${mobileNumber}`);

    if (!finalJobId || !amount || !finalClientEmail) {
        console.error('[initializeNegotiationPayment] Validation failed: Missing required parameters.ᐟ');
        return res.status(400).json({ error: 'Negotiation ID, amount, and client email are required.ᐟ' });
    }
    if (!['paystack', 'korapay'].includes(paymentMethod)) {
        console.error(`[initializeNegotiationPayment] Validation failed: Invalid payment method provided: ${paymentMethod}`);
        return res.status(400).json({ error: 'Invalid payment method provided.ᐟ' });
    }

    if (paymentMethod === 'paystack' && !PAYSTACK_SECRET_KEY) {
        console.error('[initializeNegotiationPayment] PAYSTACK_SECRET_KEY is not set.ᐟ');
        return res.status(500).json({ error: 'Paystack service not configured.ᐟ' });
    }
    if (paymentMethod === 'korapay' && !KORAPAY_SECRET_KEY) {
        console.error('[initializeNegotiationPayment] KORAPAY_SECRET_KEY is not set.ᐟ');
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
            .from('negotiations')
            .select('id, client_id, transcriber_id, agreed_price_usd, status')
            .eq('id', finalJobId)
            .eq('client_id', clientId)
            .single();
        if (error || !data) {
            console.error(`[initializeNegotiationPayment] Error fetching negotiation ${finalJobId} for payment:`, error);
            return res.status(404).json({ error: 'Negotiation not found or not accessible.ᐟ' });
        }
        jobDetails = data;
        transcriberId = data.transcriber_id;
        agreedPriceUsd = data.agreed_price_usd;
        jobStatus = data.status;
        if (jobStatus !== 'accepted_awaiting_payment') {
            console.error(`[initializeNegotiationPayment] Negotiation ${finalJobId} status is ${jobStatus}, not 'accepted_awaiting_payment'.`);
            return res.status(400).json({ error: `Payment can only be initiated for accepted negotiations (status: accepted_awaiting_payment). Current status: ${jobStatus}` });
        }

        if (Math.round(parsedAmountUsd * 100) !== Math.round(agreedPriceUsd * 100)) {
            console.error('[initializeNegotiationPayment] Payment amount mismatch. Provided USD:', parsedAmountUsd, 'Agreed USD:', agreedPriceUsd);
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
                    callback_url: `${CLIENT_URL}/payment-callback?relatedJobId=${finalJobId}&jobType=negotiation`,
                    currency: 'KES',
                    channels: ['mobile_money', 'card', 'bank_transfer', 'pesalink'],
                    metadata: {
                        related_job_id: finalJobId,
                        related_job_type: 'negotiation',
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
                console.error('[initializeNegotiationPayment] Paystack initialization failed:ᐟ', paystackResponse.data.message);
                return res.status(500).json({ error: paystackResponse.data.message || 'Failed to initialize payment with Paystack.ᐟ' });
            }

            res.status(200).json({
                message: 'Payment initialization successful',
                data: paystackResponse.data.data
            });
        } else if (paymentMethod === 'korapay') {
            if (!KORAPAY_PUBLIC_KEY) {
                console.error('[initializeNegotiationPayment] KORAPAY_PUBLIC_KEY is not set for KoraPay frontend integration.ᐟ');
                return res.status(500).json({ error: 'KoraPay public key not configured.ᐟ' });
            }

            const reference = `JOB-${finalJobId.substring(0, 8)}-${Date.now().toString(36)}`;
            
            const amountKes = convertUsdToKes(parsedAmountUsd);
            const amountForKorapay = Math.round(amountKes);

            const korapayCustomer = {
                name: req.user.full_name || 'Customer',
                email: finalClientEmail,
            };
            // Removed explicit channels array to let KoraPay determine defaults for KES.
            // No mobileNumber field for negotiation payments from client side currently.
            
            const korapayData = {
                key: KORAPAY_PUBLIC_KEY,
                reference: reference,
                amount: amountForKorapay, 
                currency: 'KES',
                customer: korapayCustomer,
                notification_url: KORAPAY_WEBHOOK_URL,
                metadata: {
                    related_job_id: finalJobId,
                    related_job_type: 'negotiation',
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
        console.error(`[initializeNegotiationPayment] Error initializing ${paymentMethod} payment:`, error.response ? error.response.data : error.message);
        res.status(500).json({ error: `Server error during ${paymentMethod} payment initialization.ᐟ` });
    }
};

const verifyNegotiationPayment = async (req, res, io) => {
    console.log('[verifyNegotiationPayment] Received req.params:', req.params);
    console.log('[verifyNegotiationPayment] Received req.query:', req.query);

    const { negotiationId, reference } = req.params; 
    const { paymentMethod = 'paystack' } = req.query;

    const relatedJobId = negotiationId; 

    if (!reference || !relatedJobId) {
        console.error('[verifyNegotiationPayment] Validation failed: Missing reference or relatedJobId. Reference:', reference, 'relatedJobId:', relatedJobId);
        return res.status(400).json({ error: 'Payment reference and negotiation ID are required for verification.ᐟ' });
    }
    if (!['paystack', 'korapay'].includes(paymentMethod)) {
        console.error(`Invalid payment method provided: ${paymentMethod}`);
        return res.status(400).json({ error: 'Invalid payment method provided.ᐟ' });
    }
    if (paymentMethod === 'paystack' && !PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not set.ᐟ');
        return res.status(500).json({ error: 'Paystack service not configured.ᐟ' });
    }
    if (paymentMethod === 'korapay' && !KORAPAY_SECRET_KEY) {
        console.error('KORAPAY_SECRET_KEY is not set.ᐟ');
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
            if (transaction.currency === 'KES') {
                actualAmountPaidUsd = parseFloat((transaction.amount / EXCHANGE_RATE_USD_TO_KES).toFixed(2));
            } else {
                actualAmountPaidUsd = parseFloat((transaction.amount).toFixed(2));
            }
            metadataCurrencyPaid = transaction.currency;
            metadataExchangeRate = (metadataCurrencyPaid === 'USD') ? 1 : EXCHANGE_RATE_USD_TO_KES;
            
            transaction.metadata = {
                related_job_id: relatedJobId,
                related_job_type: 'negotiation',
                client_id: req.user.userId,
                transcriber_id: transaction.metadata?.transcriber_id || null,
                agreed_price_usd: actualAmountPaidUsd,
                currency_paid: metadataCurrencyPaid,
                exchange_rate_usd_to_kes: metadataExchangeRate,
                amount_paid_usd: actualAmountPaidUsd
            };
            // UPDATED: Safely parse transaction.paid_at to handle potential 'Invalid time value'
            const parsedCreatedAt = new Date(transaction.createdAt);
            transaction.paid_at = !isNaN(parsedCreatedAt.getTime()) ? parsedCreatedAt.toISOString() : new Date().toISOString();
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

        if (metadataRelatedJobId !== relatedJobId || metadataRelatedJobType !== 'negotiation') {
            console.error('Metadata job ID or type mismatch:ᐟ', metadataRelatedJobId, relatedJobId, metadataRelatedJobType);
            return res.status(400).json({ error: 'Invalid transaction metadata (job ID or type mismatch).ᐟ' });
        }

        if (Math.round(actualAmountPaidUsd * 100) !== Math.round(metadataAgreedPrice * 100)) {
            console.error('Payment verification amount mismatch. Transaction amount (USD):ᐟ', actualAmountPaidUsd, 'Expected USD:', metadataAgreedPrice);
            return res.status(400).json({ error: 'Invalid transaction metadata (amount mismatch). Payment charged a different amount than expected.ᐟ' });
        }
        
        let currentJob;
        let updateTable = 'negotiations';
        let updateStatusColumn = 'status';
        let newJobStatus = 'hired';

        const { data, error } = await supabase
            .from('negotiations')
            .select('id, client_id, transcriber_id, agreed_price_usd, status')
            .eq('id', relatedJobId)
            .single();
        if (error || !data) {
            console.error(`Error fetching negotiation ${relatedJobId} during payment verification: `, error);
            return res.status(404).json({ error: 'Negotiation not found for verification.ᐟ' });
        }
        currentJob = data;
        if (currentJob.status === 'hired') {
            return res.status(200).json({ message: 'Payment already processed and job already hired.ᐟ' });
        }
        
        const transcriberPayAmount = calculateTranscriberEarning(actualAmountPaidUsd);
        
        const paymentData = {
            related_job_type: 'negotiation',
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

        paymentData.negotiation_id = relatedJobId;
        paymentData.direct_upload_job_id = null;

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
            console.error(`Error updating job status to ${newJobStatus} for negotiation ${relatedJobId}: `, jobUpdateError);
            throw jobUpdateError;
        }

        if (finalTranscriberId) {
            await syncAvailabilityStatus(finalTranscriberId, relatedJobId); 
        }

        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', metadataClientId).single();
        const transcriberUser = (finalTranscriberId)
            ? (await supabase.from('users').select('full_name, email').eq('id', finalTranscriberId).single()).data
            : null;

        if (clientError) console.error('Error fetching client for payment email: ', clientError);
        if (transcriberUser === null) console.error('Error fetching transcriber for payment email: ', clientError);

        if (clientUser) {
            await sendPaymentConfirmationEmail(clientUser, transcriberUser, currentJob, paymentRecord);
        }

        if (io) {
            io.to(metadataClientId).emit('payment_successful', {
                relatedJobId: relatedJobId,
                jobType: 'negotiation',
                message: 'Your payment was successful and the job is now active!ᐟ',
                newStatus: newJobStatus
            });
            if (finalTranscriberId) {
                io.to(finalTranscriberId).emit('job_hired', {
                    relatedJobId: relatedJobId,
                    jobType: 'negotiation',
                    message: 'A client has paid for your accepted job. The job is now active!ᐟ',
                    newStatus: newJobStatus
                });
                console.log(`Emitted 'payment_successful' to client ${metadataClientId} and 'job_hired' to transcriber ${finalTranscriberId}`);
            }
        }

        res.status(200).json({
            message: 'Payment verified successfully and job is now active.ᐟ',
            transaction: transaction
        });

    } catch (error) {
        console.error(`[verifyNegotiationPayment] Error verifying ${paymentMethod} payment:`, error.response ? error.response.data : error.message);
        res.status(500).json({ error: `Server error during ${paymentMethod} payment verification.ᐟ` + (error.message || '') });
    }
};


module.exports = {
    uploadNegotiationFiles,
    uploadTempNegotiationFile,
    tempUploadNegotiationFile,
    getAvailableTranscribers,
    createNegotiation,
    getClientNegotiations,
    getTranscriberNegotiations,
    deleteNegotiation,
    syncAvailabilityStatus,
    acceptNegotiation,
    counterNegotiation,
    rejectNegotiation,
    clientAcceptCounter,
    clientRejectCounter,
    clientCounterBack,
    markJobCompleteByClient,
    initializeNegotiationPayment,
    verifyNegotiationPayment
};
