const supabase = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ... (rest of your existing code for multer config and handleChatAttachmentUpload) ...

const getAdminDirectMessages = async (req, res, io) => {
    // ... (existing code) ...
};

const sendAdminDirectMessage = async (req, res, io) => {
    // ... (existing code) ...
};

const getUserDirectMessages = async (req, res, io) => {
    // ... (existing code) ...
};

const sendUserDirectMessage = async (req, res, io) => {
    // ... (existing code) ...
};

const getUnreadMessageCount = async (req, res) => {
    // ... (existing code) ...
};

const getNegotiationMessages = async (req, res, io) => {
    // ... (existing code) ...
};

const sendNegotiationMessage = async (req, res, io) => {
    try {
        const { receiverId, negotiationId, messageText, file_url, file_name } = req.body;
        const senderId = req.user.userId;
        const senderFullName = req.user.full_name || 'User';

        if (!receiverId || !negotiationId || (!messageText && !file_url)) {
            return res.status(400).json({ error: 'Receiver ID, negotiation ID, and either message text or a file are required.' });
        }

        // Verify that the sender is part of the negotiation
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

            // --- ADD THESE CONSOLE LOGS ---
            console.log(`[sendNegotiationMessage] Attempting to emit 'receiveMessage' for negotiation ${negotiationId}`);
            console.log(`[sendNegotiationMessage] Sender ID: ${senderId}, Receiver ID: ${receiverId}`);
            console.log(`[sendNegotiationMessage] Emitting payload:`, messagePayload);
            // --- END ADDED LOGS ---

            // Emit to both participants in the negotiation room
            io.to(receiverId).emit('receiveMessage', messagePayload);
            io.to(senderId).emit('receiveMessage', messagePayload);
            // Increment unread count for the receiver
            io.to(receiverId).emit('unreadMessageCountUpdate', { userId: receiverId, change: 1 });
        }

        res.status(201).json({ message: 'Message sent successfully', messageData: newMessage });
    } catch (error) {
        console.error('Error sending negotiation message:', error);
        res.status(500).json({ error: error.message });
    }
};

const getAdminChatList = async (req, res) => {
    // ... (existing code) ...
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
