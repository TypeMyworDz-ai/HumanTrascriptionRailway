// backend/controllers/chatController.js - COMPLETE AND FULLY CORRECTED FILE

const supabase = require('..//database');

// Function to get direct messages between an admin and a user
const getAdminDirectMessages = async (req, res, io) => {
    try {
        const { userId } = req.params; // The user the admin is chatting with
        const adminId = req.user.userId; // The logged-in admin's ID

        console.log(`[getAdminDirectMessages] Admin ID: ${adminId}, Target User ID: ${userId}`);

        const { data: messages, error } = await supabase
            .from('messages')
            .select('id, sender_id, receiver_id, content, timestamp, is_read')
            .or(`and(sender_id.eq.${adminId},receiver_id.eq.${userId}),and(sender_id.eq.${userId},receiver_id.eq.${adminId})`)
            .is('negotiation_id', null) // Only fetch direct messages
            .order('timestamp', { ascending: true });

        if (error) {
            console.error(`[getAdminDirectMessages] Supabase error fetching messages:`, error);
            throw error;
        }
        console.log(`[getAdminDirectMessages] Fetched ${messages?.length || 0} messages.`);

        // Mark messages as read when fetched by the admin
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

// Function to send a direct message from admin to a user
const sendAdminDirectMessage = async (req, res, io) => {
    try {
        const { receiverId, messageText } = req.body;
        const senderId = req.user.userId; // The logged-in admin's ID
        const senderFullName = req.user.full_name || 'Admin';

        if (!receiverId || !messageText) {
            return res.status(400).json({ error: 'Receiver ID and message text are required.' });
        }

        const { data: newMessage, error } = await supabase
            .from('messages')
            .insert({
                sender_id: senderId,
                receiver_id: receiverId,
                content: messageText,
                negotiation_id: null, // Mark as a direct admin-user chat
                is_read: false // Mark new messages as unread by default
            })
            .select('id, sender_id, receiver_id, content, timestamp, is_read')
            .single();

        if (error) throw error;

        if (io) {
            const messagePayload = {
                ...newMessage,
                sender_name: senderFullName,
                timestamp: new Date(newMessage.timestamp).toLocaleString()
            };
            io.to(receiverId).emit('newChatMessage', messagePayload);
            io.to(senderId).emit('newChatMessage', messagePayload);
            io.to(receiverId).emit('unreadMessageCountUpdate', { userId: receiverId, change: 1 });
        }

        res.status(201).json({ message: 'Message sent successfully', messageData: newMessage });
    } catch (error) {
        console.error('Error sending admin direct message:', error);
        res.status(500).json({ error: error.message });
    }
};

// Function to get direct messages for a regular user (client/transcriber)
const getUserDirectMessages = async (req, res, io) => {
    try {
        const { chatId } = req.params; // This will be the ID of the other user (e.g., Admin's ID)
        const userId = req.user.userId; // The logged-in user's ID

        const { data: messages, error } = await supabase
            .from('messages')
            .select('id, sender_id, receiver_id, content, timestamp, is_read')
            .or(`and(sender_id.eq.${userId},receiver_id.eq.${chatId}),and(sender_id.eq.${chatId},receiver_id.eq.${userId})`)
            .is('negotiation_id', null) // Only fetch direct messages
            .order('timestamp', { ascending: true });

        if (error) throw error;

        // Mark messages as read when fetched by the user
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

// Function for a regular user to send a direct message
const sendUserDirectMessage = async (req, res, io) => {
    try {
        const { receiverId, messageText } = req.body;
        const senderId = req.user.userId; // The logged-in user's ID
        const senderFullName = req.user.full_name || 'User';

        if (!receiverId || !messageText) {
            return res.status(400).json({ error: 'Receiver ID and message text are required.' });
        }

        const { data: newMessage, error } = await supabase
            .from('messages')
            .insert({
                sender_id: senderId,
                receiver_id: receiverId,
                content: messageText,
                negotiation_id: null, // Mark as a direct chat
                is_read: false // Mark new messages as unread by default
            })
            .select('id, sender_id, receiver_id, content, timestamp, is_read')
            .single();

        if (error) throw error;

        if (io) {
            const messagePayload = {
                ...newMessage,
                sender_name: senderFullName,
                timestamp: new Date(newMessage.timestamp).toLocaleString()
            };
            io.to(receiverId).emit('newChatMessage', messagePayload);
            io.to(senderId).emit('newChatMessage', messagePayload);
            io.to(receiverId).emit('unreadMessageCountUpdate', { userId: receiverId, change: 1 });
        }

        res.status(201).json({ message: 'Message sent successfully', messageData: newMessage });
    } catch (error) {
        console.error('Error sending user direct message:', error);
        res.status(500).json({ error: error.message });
    }
};

// Function to get unread message count for a user
const getUnreadMessageCount = async (req, res) => {
    try {
        const userId = req.user.userId; // The logged-in user's ID

        const { count, error } = await supabase
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('receiver_id', userId)
            .eq('is_read', false)
            .is('negotiation_id', null); // Only count direct messages

        if (error) throw error;

        res.json({ count });
    } catch (error) {
        console.error('Error fetching unread message count:', error);
        res.status(500).json({ error: error.message });
    }
};

// NEW: Function to get messages for a specific negotiation
const getNegotiationMessages = async (req, res, io) => {
    try {
        const { negotiationId } = req.params;
        const userId = req.user.userId; // The logged-in user's ID

        // First, verify that the user is a participant in this negotiation
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
            .select('id, sender_id, receiver_id, content, timestamp, is_read')
            .eq('negotiation_id', negotiationId) // Filter by negotiation_id
            .order('timestamp', { ascending: true });

        if (error) throw error;

        // Mark messages as read when fetched by the user
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
                    // Determine sender for these messages
                    const senderOfUnreadMessages = unreadMessagesForUser[0].sender_id;
                    if (senderOfUnreadMessages !== userId) { // Don't emit to self
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

// NEW: Function to send a message within a negotiation
const sendNegotiationMessage = async (req, res, io) => {
    try {
        const { receiverId, negotiationId, messageText } = req.body;
        const senderId = req.user.userId;
        const senderFullName = req.user.full_name || 'User';

        if (!receiverId || !negotiationId || !messageText) {
            return res.status(400).json({ error: 'Receiver ID, negotiation ID, and message text are required.' });
        }

        // Verify that sender is a participant in this negotiation
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
                negotiation_id: negotiationId, // Link to the negotiation
                content: messageText,
                is_read: false
            })
            .select('id, sender_id, receiver_id, negotiation_id, content, timestamp, is_read')
            .single();

        if (error) throw error;

        if (io) {
            const messagePayload = {
                ...newMessage,
                sender_name: senderFullName,
                timestamp: new Date(newMessage.timestamp).toLocaleString()
            };
            // Emit to both sender and receiver rooms
            io.to(receiverId).emit('receiveMessage', messagePayload);
            io.to(senderId).emit('receiveMessage', messagePayload); // Also emit to sender so their chat updates
            // Increment unread count for the receiver
            io.to(receiverId).emit('unreadMessageCountUpdate', { userId: receiverId, change: 1 });
        }

        res.status(201).json({ message: 'Message sent successfully', messageData: newMessage });
    } catch (error) {
        console.error('Error sending negotiation message:', error);
        res.status(500).json({ error: error.message });
    }
};


// NEW: Function to get a list of users the admin has chatted with, with latest message and unread count
const getAdminChatList = async (req, res) => {
    try {
        const adminId = req.user.userId;

        // Use a SQL function to get the latest messages for each chat partner
        // This RPC call needs to be defined in your Supabase SQL Editor
        const { data: latestMessages, error: latestMessagesError } = await supabase.rpc('get_latest_direct_messages', { p_user_id: adminId });

        if (latestMessagesError) {
            console.error('Error in RPC get_latest_direct_messages:', latestMessagesError);
            throw latestMessagesError;
        }

        const chatList = await Promise.all(latestMessages.map(async (msg) => {
            const partnerId = msg.sender_id === adminId ? msg.receiver_id : msg.sender_id;
            
            // Fetch partner details
            const { data: partner, error: partnerError } = await supabase
                .from('users')
                .select('id, full_name, email, user_type')
                .eq('id', partnerId)
                .single();

            if (partnerError) console.error(`Error fetching partner ${partnerId}:`, partnerError);

            // Fetch unread count for messages *from* this partner *to* the admin
            const { count: unreadCount, error: unreadError } = await supabase
                .from('messages')
                .select('*', { count: 'exact', head: true })
                .eq('sender_id', partnerId) // Messages FROM this partner
                .eq('receiver_id', adminId) // TO the admin
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
    getNegotiationMessages, // NEW: Export the negotiation message getter
    sendNegotiationMessage // NEW: Export the negotiation message sender
};
