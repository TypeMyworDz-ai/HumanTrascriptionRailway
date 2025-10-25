const supabase = require('..//database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for chat attachment files (text, PDF, images, AUDIO, VIDEO)
const chatAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/chat_attachments'; // Dedicated directory for chat attachments
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

const chatAttachmentFilter = (req, file, cb) => {
  const allowedTypes = [
    'application/pdf',
    'application/msword', // .doc
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'text/plain',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/mp4', 'audio/m4a', 'audio/ogg', // Added audio types
    'video/mp4', 'video/webm', 'video/ogg' // Added video types
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    // Pass a MulterError with a specific code for easier handling in the route
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only text, PDF, DOC, DOCX, images, audio, and video files are allowed as chat attachments!'), false);
  }
};

const uploadChatAttachment = multer({
  storage: chatAttachmentStorage,
  fileFilter: chatAttachmentFilter,
  limits: {
    fileSize: 500 * 1024 * 1024 // Increased to 500MB limit for chat attachments
  }
}).single('chatAttachment'); // 'chatAttachment' is the field name expected from the frontend

const handleChatAttachmentUpload = async (req, res) => {
    try {
        // This function is reached if Multer successfully processed the file.
        // If Multer itself caught an error (e.g., file size/type), it would be handled
        // by the error-handling middleware in routes/generalApiRoutes.js
        if (!req.file) {
            console.warn('[handleChatAttachmentUpload] No file received, but no Multer error caught upstream. This should not happen.');
            return res.status(400).json({ error: 'No file uploaded, or an unexpected file processing error occurred.' });
        }

        const fileUrl = `/uploads/chat_attachments/${req.file.filename}`;
        
        res.status(200).json({ 
            message: 'Attachment uploaded successfully', 
            fileUrl: fileUrl, // Changed to fileUrl for consistency with frontend expectation
            fileName: req.file.originalname // Changed to fileName for consistency with frontend expectation
        });

    } catch (error) {
        console.error('[handleChatAttachmentUpload] Unexpected error in controller:', error);
        // Clean up the partially uploaded file if an error occurs
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: error.message || 'Failed to upload attachment due to server error.' });
    }
};


const getAdminDirectMessages = async (req, res, io) => {
    try {
        const { userId } = req.params; // This userId is the target user (trainee or client)
        const adminId = req.user.userId; // The current authenticated admin user

        console.log(`[getAdminDirectMessages] Admin ID: ${adminId}, Target User ID: ${userId}`);

        // MODIFIED: This filter needs to cover both direct messages and training room messages
        // if this is the endpoint handling them. The frontend will then differentiate.
        const orFilter = `and(sender_id.eq."${adminId}",receiver_id.eq."${userId}"),and(sender_id.eq."${userId}",receiver_id.eq."${adminId}")`;

        const { data: messages, error } = await supabase
            .from('messages')
            .select('id, sender_id, receiver_id, content, timestamp, is_read, file_url, file_name, negotiation_id, direct_upload_job_id, training_room_id') // NEW: Include direct_upload_job_id
            .or(orFilter)
            // Removed .is('negotiation_id', null) and .is('training_room_id', null)
            // as this endpoint now serves as the general chat history for admin-user conversations,
            // including training rooms. Frontend will filter/display based on context.
            .order('timestamp', { ascending: true });

        if (error) {
            console.error(`[getAdminDirectMessages] Supabase error fetching messages:`, error);
            throw error;
        }
        console.log(`[getAdminDirectMessages] Fetched ${messages?.length || 0} messages. Total: ${messages?.length}`);

        // Mark messages sent by the user to the admin as read
        if (messages && messages.length > 0 && io) {
            const unreadMessagesForAdmin = messages.filter(msg => msg.receiver_id === adminId && !msg.is_read);
            if (unreadMessagesForAdmin.length > 0) {
                const unreadIds = unreadMessagesForAdmin.map(msg => msg.id);
                const { error: updateError } = await supabase
                    .from('messages')
                    .update({ is_read: true, read_at: new Date().toISOString() })
                    .in('id', unreadIds);

                if (updateError) {
                    console.error('[getAdminDirectMessages] Error marking admin messages as read:', updateError);
                } else {
                    console.log(`[getAdminDirectMessages] Marked ${unreadIds.length} messages as read for admin ${adminId}.`);
                    // Emit update for admin's unread count
                    io.to(adminId).emit('unreadMessageCountUpdate', { userId: adminId, change: -unreadIds.length });
                    // Emit to the user that their messages have been read by the admin
                    io.to(userId).emit('messageRead', { senderId: adminId, receiverId: userId, messageIds: unreadIds });
                }
            }
        }

        res.json({ messages });
    } catch (error) {
        console.error('[getAdminDirectMessages] Error fetching admin direct messages:', error);
        res.status(500).json({ error: error.message });
    }
};

const sendAdminDirectMessage = async (req, res, io) => {
    try {
        const { receiverId, messageText, fileUrl, fileName, trainingRoomId } = req.body; // NEW: Added trainingRoomId
        const senderId = req.user.userId;
        const senderFullName = req.user.full_name || 'Admin';

        // --- START DEBUGGING LOGS ---
        console.log(`[sendAdminDirectMessage] Incoming req.body.trainingRoomId: ${trainingRoomId}`);
        // --- END DEBUGGING LOGS ---

        if (!receiverId || (!messageText && !fileUrl)) {
            return res.status(400).json({ error: 'Receiver ID and either message text or a file are required.' });
        }

        const { data: newMessage, error } = await supabase
            .from('messages')
            .insert({
                sender_id: senderId,
                receiver_id: receiverId,
                content: messageText,
                negotiation_id: null,
                direct_upload_job_id: null, // Ensure this is null for direct messages
                training_room_id: trainingRoomId || null, // MODIFIED: Store trainingRoomId if provided
                is_read: false,
                file_url: fileUrl,
                file_name: fileName
            })
            .select('id, sender_id, receiver_id, content, timestamp, is_read, file_url, file_name, negotiation_id, direct_upload_job_id, training_room_id') // NEW: Include direct_upload_job_id in select
            .single();

        if (error) throw error;

        // --- START DEBUGGING LOGS ---
        console.log("[sendAdminDirectMessage] newMessage from Supabase:", newMessage);
        // --- END DEBUGGING LOGS ---

        if (io) {
            const messagePayload = {
                ...newMessage,
                sender_name: senderFullName,
            };

            // --- START DEBUGGING LOG ---
            console.log("[sendAdminDirectMessage] Emitting messagePayload:", messagePayload);
            // --- END DEBUGGING LOG ---

            io.to(receiverId).emit('newChatMessage', messagePayload);
            io.to(senderId).emit('newChatMessage', messagePayload);
            io.to(receiverId).emit('unreadMessageCountUpdate', { userId: receiverId, change: 1 });
            console.log(`[sendAdminDirectMessage] Emitted 'newChatMessage' to ${receiverId} and ${senderId}`);
        }

        res.status(201).json({ message: 'Message sent successfully', messageData: newMessage });
    } catch (error) {
        console.error('Error sending admin direct message:', error);
        res.status(500).json({ error: error.message });
    }
};

const getUserDirectMessages = async (req, res, io) => {
    try {
        const { chatId } = req.params; // This chatId is the partner (admin or other user)
        const userId = req.user.userId; // The current authenticated user

        const orFilter = `and(sender_id.eq."${userId}",receiver_id.eq."${chatId}"),and(sender_id.eq."${chatId}",receiver_id.eq."${userId}")`;

        const { data: messages, error } = await supabase
            .from('messages')
            .select('id, sender_id, receiver_id, content, timestamp, is_read, file_url, file_name, negotiation_id, direct_upload_job_id, training_room_id') // NEW: Include direct_upload_job_id
            .or(orFilter)
            // Removed .is('negotiation_id', null) and .is('training_room_id', null)
            // as this endpoint now serves as the general chat history for user-partner conversations,
            // including training rooms. Frontend will filter/display based on context.
            .order('timestamp', { ascending: true });

        if (error) throw error;

        if (messages && messages.length > 0 && io) {
            const unreadMessagesForUser = messages.filter(msg => msg.receiver_id === userId && !msg.is_read);
            if (unreadMessagesForUser.length > 0) {
                const unreadIds = unreadMessagesForUser.map(msg => msg.id);
                const { error: updateError } = await supabase
                    .from('messages')
                    .update({ is_read: true, read_at: new Date().toISOString() })
                    .in('id', unreadIds);

                if (updateError) {
                    console.error('Error marking user messages as read:', updateError);
                } else {
                    io.to(userId).emit('unreadMessageCountUpdate', { userId: userId, change: -unreadIds.length });
                    io.to(chatId).emit('messageRead', { senderId: userId, receiverId: chatId, messageIds: unreadIds });
                }
            }
        }

        res.json({ messages });
    } catch (error) {
        console.error('Error fetching user direct messages:', error);
        res.status(500).json({ error: error.message });
    }
};

const sendUserDirectMessage = async (req, res, io) => {
    try {
        const { receiverId, messageText, fileUrl, fileName, trainingRoomId } = req.body; // NEW: Added trainingRoomId
        const senderId = req.user.userId;
        
        // FIX: Determine senderFullName based on user type if available
        const senderFullName = req.user.user_type === 'trainee' ? 'Test Trainee' : (req.user.full_name || 'User');

        // --- START DEBUGGING LOGS ---
        console.log(`[sendUserDirectMessage] Incoming req.body.trainingRoomId: ${trainingRoomId}`);
        // --- END DEBUGGING LOGS ---

        console.log(`[sendUserDirectMessage] Attempting to send message. Sender: ${senderId}, Receiver: ${receiverId}`);
        console.log(`[sendUserDirectMessage] Message content: "${messageText}", File: ${fileName || 'None'}`);

        if (!receiverId || (!messageText && !fileUrl)) {
            return res.status(400).json({ error: 'Receiver ID and either message text or a file are required.' });
        }
        const { data: newMessage, error } = await supabase
            .from('messages')
            .insert({
                sender_id: senderId,
                receiver_id: receiverId,
                content: messageText,
                negotiation_id: null,
                direct_upload_job_id: null, // Ensure this is null for direct messages
                training_room_id: trainingRoomId || null, // MODIFIED: Store trainingRoomId if provided
                is_read: false,
                file_url: fileUrl,
                file_name: fileName
            })
            .select('id, sender_id, receiver_id, negotiation_id, direct_upload_job_id, content, timestamp, is_read, file_url, file_name, training_room_id') // NEW: Include direct_upload_job_id in select
            .single();

        if (error) {
            console.error('[sendUserDirectMessage] Supabase insert error:', error);
            throw error;
        }

        // --- START DEBUGGING LOGS ---
        console.log("[sendUserDirectMessage] newMessage from Supabase:", newMessage);
        // --- END DEBUGGING LOGS ---

        if (io) {
            const messagePayload = {
                ...newMessage,
                sender_name: senderFullName,
            };

            // --- START DEBUGGING LOG ---
            console.log("[sendUserDirectMessage] Emitting messagePayload:", messagePayload);
            // --- END DEBUGGING LOG ---

            console.log(`[sendUserDirectMessage] Emitting 'newChatMessage' to receiver room: ${receiverId}`);
            io.to(receiverId).emit('newChatMessage', messagePayload);
            
            console.log(`[sendUserDirectMessage] Emitting 'newChatMessage' to sender room: ${senderId}`);
            io.to(senderId).emit('newChatMessage', messagePayload);
            
            console.log(`[sendUserDirectMessage] Emitting 'unreadMessageCountUpdate' to receiver room: ${receiverId}`);
            io.to(receiverId).emit('unreadMessageCountUpdate', { userId: receiverId, change: 1 });
        }

        res.status(201).json({ message: 'Message sent successfully', messageData: newMessage });
    } catch (error) {
        console.error('[sendUserDirectMessage] Error sending user direct message:', error);
        res.status(500).json({ error: error.message });
    }
};

const getUnreadMessageCount = async (req, res) => {
    try {
        const userId = req.user.userId;

        if (!userId) {
            console.warn('[getUnreadMessageCount] userId is undefined or null.');
            return res.json({ count: 0 });
        }

        // CORRECTED: Filter to exclude messages linked to both negotiation_id and direct_upload_job_id
        const { count, error } = await supabase
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('receiver_id', userId)
            .eq('is_read', false)
            .is('negotiation_id', null) // Exclude negotiation messages
            .is('direct_upload_job_id', null); // Exclude direct upload job messages

        if (error) {
            console.error(`[getUnreadMessageCount] Supabase error fetching unread message count for user ${userId}:`, error);
            return res.status(500).json({ error: error.message || 'Failed to fetch unread message count.', count: 0 });
        }

        res.json({ count });
    } catch (error) {
        console.error('[getUnreadMessageCount] Error fetching unread message count: ', error);
        res.status(500).json({ error: error.message || 'Server error fetching unread message count.' });
    }
};

const getJobMessages = async (req, res, io) => { // Renamed from getNegotiationMessages
    try {
        const { jobId } = req.params; // Generic jobId for either negotiation or direct_upload
        const userId = req.user.userId;

        let job;
        let jobType;
        let jobError;

        // Attempt to fetch from negotiations
        const { data: negotiationData, error: negotiationError } = await supabase
            .from('negotiations')
            .select('client_id, transcriber_id')
            .eq('id', jobId)
            .single();

        if (negotiationData) {
            job = negotiationData;
            jobType = 'negotiation';
        } else {
            // If not found in negotiations, attempt to fetch from direct_upload_jobs
            const { data: directUploadData, error: directUploadError } = await supabase
                .from('direct_upload_jobs')
                .select('client_id, transcriber_id')
                .eq('id', jobId)
                .single();

            if (directUploadData) {
                job = directUploadData;
                jobType = 'direct_upload';
            } else {
                jobError = negotiationError || directUploadError; // Capture the error if neither is found
            }
        }

        if (jobError || !job) {
            console.error(`[getJobMessages]: Job ${jobId} not found or user ${userId} not authorized.`, jobError);
            return res.status(404).json({ error: 'Job not found or access denied.' });
        }

        if (job.client_id !== userId && job.transcriber_id !== userId) {
            console.warn(`[getJobMessages]: User ${userId} attempted unauthorized access to job messages for ${jobId}.`);
            return res.status(403).json({ error: 'Access denied to messages for this job.' });
        }

        const { data: messages, error } = await supabase
            .from('messages')
            .select('id, sender_id, receiver_id, negotiation_id, direct_upload_job_id, content, timestamp, is_read, file_url, file_name, training_room_id') // NEW: Include direct_upload_job_id
            .or(`negotiation_id.eq.${jobId},direct_upload_job_id.eq.${jobId}`) // Filter by either ID
            .order('timestamp', { ascending: true });

        if (error) {
            console.error(`[getJobMessages] Supabase error fetching messages for job ${jobId}:`, error);
            throw error;
        }

        // Mark messages sent by the other party as read
        if (messages && messages.length > 0 && io) {
            const unreadMessagesForUser = messages.filter(msg => msg.receiver_id === userId && !msg.is_read);
            if (unreadMessagesForUser.length > 0) {
                const unreadIds = unreadMessagesForUser.map(msg => msg.id);
                const { error: updateError } = await supabase
                    .from('messages')
                    .update({ is_read: true, read_at: new Date().toISOString() })
                    .in('id', unreadIds);

                if (updateError) {
                    console.error('Error marking job messages as read:', updateError);
                } else {
                    const senderOfUnreadMessages = unreadMessagesForUser[0].sender_id;
                    if (senderOfUnreadMessages !== userId) {
                         io.to(senderOfUnreadMessages).emit('unreadMessageCountUpdate', { userId: senderOfUnreadMessages, change: -unreadIds.length });
                         io.to(senderOfUnreadMessages).emit('messageRead', {
                             senderId: userId,
                             receiverId: senderOfUnreadMessages,
                             jobId: jobId, // Use jobId here
                             messageIds: unreadIds
                         });
                    }
                }
            }
        }

        res.json({ messages });
    } catch (error) {
        console.error('Error fetching job messages:', error);
        res.status(500).json({ error: error.message });
    }
};

const sendJobMessage = async (req, res, io) => { // Renamed from sendNegotiationMessage
    try {
        const { receiverId, jobId, messageText, fileUrl, fileName } = req.body; // Changed negotiationId to jobId
        const senderId = req.user.userId;
        const senderFullName = req.user.full_name || 'User';

        if (!receiverId || !jobId || (!messageText && !fileUrl)) {
            return res.status(400).json({ error: 'Receiver ID, job ID, and either message text or a file are required.' });
        }

        let job;
        let jobType;
        let jobError;

        // Attempt to fetch from negotiations
        const { data: negotiationData, error: negotiationError } = await supabase
            .from('negotiations')
            .select('client_id, transcriber_id')
            .eq('id', jobId)
            .single();

        if (negotiationData) {
            job = negotiationData;
            jobType = 'negotiation';
        } else {
            // If not found in negotiations, attempt to fetch from direct_upload_jobs
            const { data: directUploadData, error: directUploadError } = await supabase
                .from('direct_upload_jobs')
                .select('client_id, transcriber_id')
                .eq('id', jobId)
                .single();

            if (directUploadData) {
                job = directUploadData;
                jobType = 'direct_upload';
            } else {
                jobError = negotiationError || directUploadError; // Capture the error if neither is found
            }
        }

        if (jobError || !job) {
            console.error(`[sendJobMessage]: Job ${jobId} not found or user ${senderId} not authorized.`, jobError);
            return res.status(404).json({ error: 'Job not found or access denied.' });
        }

        if (job.client_id !== senderId && job.transcriber_id !== senderId) {
            console.warn(`[sendJobMessage]: User ${senderId} attempted unauthorized message send for job ${jobId}.`);
            return res.status(403).json({ error: 'Access denied to send messages for this job.' });
        }

        const messageToInsert = {
            sender_id: senderId,
            receiver_id: receiverId,
            content: messageText,
            training_room_id: null, // Ensure this is null for job messages
            is_read: false,
            file_url: fileUrl,
            file_name: fileName
        };

        if (jobType === 'negotiation') {
            messageToInsert.negotiation_id = jobId;
            messageToInsert.direct_upload_job_id = null;
        } else { // direct_upload
            messageToInsert.direct_upload_job_id = jobId;
            messageToInsert.negotiation_id = null;
        }

        const { data: newMessage, error } = await supabase
            .from('messages')
            .insert(messageToInsert)
            .select('id, sender_id, receiver_id, negotiation_id, direct_upload_job_id, content, timestamp, is_read, file_url, file_name, training_room_id') // NEW: Include direct_upload_job_id in select
            .single();

        if (error) throw error;

        if (io) {
            const messagePayload = {
                ...newMessage,
                sender_name: senderFullName,
            };

            console.log(`[sendJobMessage] Attempting to emit 'newChatMessage' for job ${jobId} (Type: ${jobType})`);
            console.log(`[sendJobMessage] Sender ID: ${senderId}, Receiver ID: ${receiverId}`);
            console.log(`[sendJobMessage] Emitting payload:`, messagePayload);

            io.to(receiverId).emit('newChatMessage', messagePayload);
            io.to(senderId).emit('newChatMessage', messagePayload);
            io.to(receiverId).emit('unreadMessageCountUpdate', { userId: receiverId, change: 1 });
        }

        res.status(201).json({ message: 'Message sent successfully', messageData: newMessage });
    } catch (error) {
        console.error('Error sending job message:', error);
        res.status(500).json({ error: error.message });
    }
};

const getAdminChatList = async (req, res) => {
    try {
        const adminId = req.user.userId;

        // Ensure the RPC function 'get_latest_direct_messages' exists and correctly handles the 'training_room_id' filter if needed.
        // For now, we assume it fetches all direct messages (negotiation_id is null).
        // If you need to filter out training room messages from this RPC, you'd update the RPC function itself.
        const { data: latestMessages, error: latestMessagesError } = await supabase.rpc('get_latest_direct_messages', { p_user_id: adminId });

        if (latestMessagesError) {
            console.error('Error in RPC get_latest_direct_messages:', latestMessagesError);
            return res.status(500).json({ error: 'Database function get_latest_direct_messages not found or failed. Please ensure it is created in Supabase.' });
        }

        const chatList = await Promise.all(latestMessages.map(async (msg) => {
            const partnerId = msg.sender_id === adminId ? msg.receiver_id : msg.sender_id;
            
            const { data: partner, error: partnerError } = await supabase
                .from('users')
                .select('id, full_name, email, user_type')
                .eq('id', partnerId)
                .single();

            if (partnerError) console.error(`Error fetching partner ${partnerId}:`, partnerError);

            // MODIFIED: Filter to exclude messages linked to both negotiation_id and direct_upload_job_id
            const { count: unreadCount, error: unreadError } = await supabase
                .from('messages')
                .select('*', { count: 'exact', head: true })
                .eq('sender_id', partnerId)
                .eq('receiver_id', adminId)
                .eq('is_read', false)
                .is('negotiation_id', null) // Exclude negotiation messages
                .is('direct_upload_job_id', null); // Exclude direct upload job messages

            if (unreadError) console.error(`Error fetching unread count for partner ${partnerId}:`, unreadError);

            return {
                partner_id: partnerId,
                partner_name: partner?.full_name || 'Unknown User',
                partner_email: partner?.email || 'unknown@example.com',
                partner_type: partner?.user_type || 'unknown',
                last_message_content: msg.content,
                last_message_timestamp: new Date(msg.timestamp).toLocaleString(),
                file_url: msg.file_url,
                file_name: msg.file_name,
                unread_count: unreadCount || 0
            };
        }));

        res.json({ chatList });
    } catch (error) {
        console.error('Error fetching admin chat list:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getAdminDirectMessages,
    sendAdminDirectMessage,
    getUserDirectMessages,
    sendUserDirectMessage,
    getUnreadMessageCount,
    getAdminChatList,
    getJobMessages, // Renamed export
    sendJobMessage, // Renamed export
    uploadChatAttachment,
    handleChatAttachmentUpload
};
