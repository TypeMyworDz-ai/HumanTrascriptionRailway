const supabase = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for chat attachment files (text, PDF, images)
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
    'image/gif'
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only text, PDF, DOC, DOCX, and image files are allowed as chat attachments!'), false);
  }
};

const uploadChatAttachment = multer({
  storage: chatAttachmentStorage,
  fileFilter: chatAttachmentFilter,
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB limit for chat attachments
  }
}).single('chatAttachment'); // 'chatAttachment' is the field name expected from the frontend

const handleChatAttachmentUpload = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded for chat attachment.' });
        }

        const fileUrl = `/uploads/chat_attachments/${req.file.filename}`;
        
        res.status(200).json({ 
            message: 'Attachment uploaded successfully', 
            file_url: fileUrl,
            file_name: req.file.originalname
        });

    } catch (error) {
        console.error('Error handling chat attachment upload:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: error.message || 'Failed to upload attachment.' });
    }
};


const getAdminDirectMessages = async (req, res, io) => {
    try {
        const { userId } = req.params;
        const adminId = req.user.userId;

        console.log(`[getAdminDirectMessages] Admin ID: ${adminId}, Target User ID: ${userId}`);

        const orFilter = `and(sender_id.eq."${adminId}",receiver_id.eq."${userId}"),and(sender_id.eq."${userId}",receiver_id.eq."${adminId}")`;

        const { data: messages, error } = await supabase
            .from('messages')
            .select('id, sender_id, receiver_id, content, timestamp, is_read, file_url, file_name')
            .or(orFilter)
            .is('negotiation_id', null)
            .order('timestamp', { ascending: true });

        if (error) {
            console.error(`[getAdminDirectMessages] Supabase error fetching messages:`, error);
            throw error;
        }
        console.log(`[getAdminDirectMessages] Fetched ${messages?.length || 0} messages.`);

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
                    io.to(adminId).emit('unreadMessageCountUpdate', { userId: adminId, change: -unreadIds.length });
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
        const { receiverId, messageText, file_url, file_name } = req.body;
        const senderId = req.user.userId;
        const senderFullName = req.user.full_name || 'Admin';

        if (!receiverId || (!messageText && !file_url)) {
            return res.status(400).json({ error: 'Receiver ID and either message text or a file are required.' });
        }

        const { data: newMessage, error } = await supabase
            .from('messages')
            .insert({
                sender_id: senderId,
                receiver_id: receiverId,
                content: messageText,
                negotiation_id: null,
                is_read: false,
                file_url: file_url,
                file_name: file_name
            })
            .select('id, sender_id, receiver_id, content, timestamp, is_read, file_url, file_name')
            .single();

        if (error) throw error;

        if (io) {
            const messagePayload = {
                ...newMessage,
                sender_name: senderFullName,
            };
            io.to(receiverId).emit('receiveMessage', messagePayload);
            io.to(senderId).emit('receiveMessage', messagePayload);
            io.to(receiverId).emit('unreadMessageCountUpdate', { userId: receiverId, change: 1 });
        }

        res.status(201).json({ message: 'Message sent successfully', messageData: newMessage });
    } catch (error) {
        console.error('Error sending admin direct message:', error);
        res.status(500).json({ error: error.message });
    }
};

const getUserDirectMessages = async (req, res, io) => {
    try {
        const { chatId } = req.params;
        const userId = req.user.userId;
        
        const orFilter = `and(sender_id.eq."${userId}",receiver_id.eq."${chatId}"),and(sender_id.eq."${chatId}",receiver_id.eq."${userId}")`;

        const { data: messages, error } = await supabase
            .from('messages')
            .select('id, sender_id, receiver_id, content, timestamp, is_read, file_url, file_name')
            .or(orFilter)
            .is('negotiation_id', null)
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
        const { receiverId, messageText, file_url, file_name } = req.body;
        const senderId = req.user.userId;
        const senderFullName = req.user.full_name || 'User';

        if (!receiverId || (!messageText && !file_url)) {
            return res.status(400).json({ error: 'Receiver ID and either message text or a file are required.' });
        }

        const { data: newMessage, error } = await supabase
            .from('messages')
            .insert({
                sender_id: senderId,
                receiver_id: receiverId,
                content: messageText,
                negotiation_id: null,
                is_read: false,
                file_url: file_url,
                file_name: file_name
            })
            .select('id, sender_id, receiver_id, content, timestamp, is_read, file_url, file_name')
            .single();

        if (error) throw error;

        if (io) {
            const messagePayload = {
                ...newMessage,
                sender_name: senderFullName,
            };
            io.to(receiverId).emit('receiveMessage', messagePayload);
            io.to(senderId).emit('receiveMessage', messagePayload);
            io.to(receiverId).emit('unreadMessageCountUpdate', { userId: receiverId, change: 1 });
        }

        res.status(201).json({ message: 'Message sent successfully', messageData: newMessage });
    } catch (error) {
        console.error('Error sending user direct message:', error);
        res.status(500).json({ error: error.message });
    }
};

const getUnreadMessageCount = async (req, res) => {
    try {
        const userId = req.user.userId;

        const { count, error } = await supabase
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('receiver_id', userId)
            .eq('is_read', false)
            .is('negotiation_id', null);

        if (error) throw error;

        res.json({ count });
    } catch (error) {
        console.error('Error fetching unread message count:', error);
        res.status(500).json({ error: error.message });
    }
};

const getNegotiationMessages = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const userId = req.user.userId;

        const { data: negotiation, error: negotiationError } = await supabase
            .from('negotiations')
            .select('client_id, transcriber_id')
            .eq('id', negotiationId)
            .single();

        if (negotiationError || !negotiation) {
            console.error(`NegotiationMessages: Negotiation ${negotiationId} not found or user ${userId} not authorized.`);
            return res.status(404).json({ error: 'Negotiation not found or access denied.' });
        }

        if (negotiation.client_id !== userId && negotiation.transcriber_id !== userId) {
            console.warn(`NegotiationMessages: User ${userId} attempted unauthorized access to negotiation messages for ${negotiationId}.`);
            return res.status(403).json({ error: 'Access denied to messages for this negotiation.' });
        }

        const { data: messages, error } = await supabase
            .from('messages')
            .select('id, sender_id, receiver_id, content, timestamp, is_read, file_url, file_name')
            .eq('negotiation_id', negotiationId)
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
                    console.error('Error marking negotiation messages as read:', updateError);
                } else {
                    io.to(userId).emit('unreadMessageCountUpdate', { userId: userId, change: -unreadIds.length });
                    const senderOfUnreadMessages = unreadMessagesForUser[0].sender_id;
                    if (senderOfUnreadMessages !== userId) {
                        io.to(senderOfUnreadMessages).emit('messageRead', {
                            senderId: userId,
                            receiverId: senderOfUnreadMessages,
                            negotiationId: negotiationId,
                            messageIds: unreadIds
                        });
                    }
                }
            }
        }

        res.json({ messages });
    } catch (error) {
        console.error('Error fetching negotiation messages:', error);
        res.status(500).json({ error: error.message });
    }
};

const sendNegotiationMessage = async (req, res, io) => {
    try {
        const { receiverId, negotiationId, messageText, file_url, file_name } = req.body;
        const senderId = req.user.userId;
        const senderFullName = req.user.full_name || 'User';

        if (!receiverId || !negotiationId || (!messageText && !file_url)) {
            return res.status(400).json({ error: 'Receiver ID, negotiation ID, and either message text or a file are required.' });
        }

        const { data: negotiation, error: negotiationError } = await supabase
            .from('negotiations')
            .select('client_id, transcriber_id')
            .eq('id', negotiationId)
            .single();

        if (negotiationError || !negotiation) {
            console.error(`SendNegotiationMessage: Negotiation ${negotiationId} not found or user ${senderId} not authorized.`);
            return res.status(404).json({ error: 'Negotiation not found or access denied.' });
        }

        if (negotiation.client_id !== senderId && negotiation.transcriber_id !== senderId) {
            console.warn(`SendNegotiationMessage: User ${senderId} attempted unauthorized message send for negotiation ${negotiationId}.`);
            return res.status(403).json({ error: 'Access denied to send messages for this negotiation.' });
        }

        const { data: newMessage, error } = await supabase
            .from('messages')
            .insert({
                sender_id: senderId,
                receiver_id: receiverId,
                negotiation_id: negotiationId,
                content: messageText,
                is_read: false,
                file_url: file_url,
                file_name: file_name
            })
            .select('id, sender_id, receiver_id, negotiation_id, content, timestamp, is_read, file_url, file_name')
            .single();

        if (error) throw error;

        if (io) {
            const messagePayload = {
                ...newMessage,
                sender_name: senderFullName,
            };
            io.to(receiverId).emit('receiveMessage', messagePayload);
            io.to(senderId).emit('receiveMessage', messagePayload);
            io.to(receiverId).emit('unreadMessageCountUpdate', { userId: receiverId, change: 1 });
        }

        res.status(201).json({ message: 'Message sent successfully', messageData: newMessage });
    } catch (error) {
        console.error('Error sending negotiation message:', error);
        res.status(500).json({ error: error.message });
    }
};

const getAdminChatList = async (req, res) => {
    try {
        const adminId = req.user.userId;

        const { data: latestMessages, error: latestMessagesError } = await supabase.rpc('get_latest_direct_messages', { p_user_id: adminId });

        if (latestMessagesError) {
            console.error('Error in RPC get_latest_direct_messages:', latestMessagesError);
            return res.status(500).json({ error: 'Database function get_latest_direct_messages not found or failed.' });
        }

        const chatList = await Promise.all(latestMessages.map(async (msg) => {
            const partnerId = msg.sender_id === adminId ? msg.receiver_id : msg.sender_id;
            
            const { data: partner, error: partnerError } = await supabase
                .from('users')
                .select('id, full_name, email, user_type')
                .eq('id', partnerId)
                .single();

            if (partnerError) console.error(`Error fetching partner ${partnerId}:`, partnerError);

            const { count: unreadCount, error: unreadError } = await supabase
                .from('messages')
                .select('*', { count: 'exact', head: true })
                .eq('sender_id', partnerId)
                .eq('receiver_id', adminId)
                .eq('is_read', false)
                .is('negotiation_id', null);
            
            if (unreadError) console.error(`Error fetching unread count for partner ${partnerId}:`, unreadError);

            return {
                partner_id: partnerId,
                partner_name: partner?.full_name || 'Unknown User',
                partner_email: partner?.email || 'unknown@example.com',
                partner_type: partner?.user_type || 'unknown',
                last_message_content: msg.content,
                last_message_timestamp: new Date(msg.timestamp).toLocaleString(),
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
    getNegotiationMessages,
    sendNegotiationMessage,
    uploadChatAttachment,
    handleChatAttachmentUpload
};
