const supabase = require('../database');
const fs = require('fs');
const path = require('path');
const emailService = require('../emailService');
const multer = require('multer');

const axios = require('axios');
const { convertUsdToKes, EXCHANGE_RATE_USD_TO_KES } = require('../utils/paymentUtils');
const http = require('http');
const https = require('https');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY;
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY;
const KORAPAY_BASE_URL = process.env.KORAPAY_BASE_URL || 'https://api-sandbox.korapay.com/v1';
const KORAPAY_WEBHOOK_URL = process.env.KORAPAY_WEBHOOK_URL || 'http://localhost:5000/api/payment/korapay-webhook';

const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

const TRAINING_FEE_USD = 2.00;


const trainingRoomFileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads/training_room_attachments';
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

const trainingRoomFileFilter = (req, file, cb) => {
    const allowedTypes = [
        'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/mp4', 'audio/m4a', 'audio/ogg',
        'video/mp4', 'video/webm', 'video/ogg',
        'application/pdf',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
        'image/jpeg', 'image/jpg', 'image/png', 'image/gif'
    ];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Only audio, video, PDF, DOC, DOCX, TXT, and image files are allowed for training room attachments!'), false);
    }
};

const uploadTrainingRoomAttachment = multer({
    storage: trainingRoomFileStorage,
    fileFilter: trainingRoomFileFilter,
    limits: {
        fileSize: 500 * 1024 * 1024
    }
}).single('trainingRoomAttachment');


const handleTrainingRoomAttachmentUpload = async (req, res) => {
    try {
        if (!req.file) {
            console.warn('[handleTrainingRoomAttachmentUpload] No file received.');
            return res.status(400).json({ error: 'No file uploaded, or an unexpected file processing error occurred.' });
        }

        const fileUrl = `/uploads/training_room_attachments/${req.file.filename}`;
        
        res.status(200).json({ 
            message: 'Training room attachment uploaded successfully', 
            fileUrl: fileUrl,
            fileName: req.file.originalname
        });

    } catch (error) {
        console.error('[handleTrainingRoomAttachmentUpload] Unexpected error in controller:', error);
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: error.message || 'Failed to upload training room attachment due to server error.' });
    }
};


const getTraineeTrainingStatus = async (req, res) => {
    try {
        const traineeId = req.user.userId;

        const { data: trainee, error } = await supabase
            .from('users')
            .select('transcriber_status, transcriber_user_level')
            .eq('id', traineeId)
            .eq('user_type', 'trainee')
            .single();

        if (error || !trainee) {
            console.error(`Error fetching training status for trainee ${traineeId}:`, error);
            return res.status(404).json({ error: 'Trainee not found or access denied.' });
        }

        const adminId = process.env.ADMIN_USER_ID;
        if (!adminId) {
            console.error('ADMIN_USER_ID is not configured in backend environment variables.');
            return res.status(500).json({ error: 'Training admin ID not configured. Please contact support.' });
        }

        res.json({
            status: trainee.transcriber_status,
            user_level: trainee.transcriber_user_level,
            trainer_id: adminId
        });
    } catch (error) {
        console.error('Error in getTraineeTrainingStatus:', error);
        res.status(500).json({ error: 'Server error fetching training status.' });
    }
};

const getTrainingMaterials = async (req, res) => {
    try {
        const { data: materials, error } = await supabase
            .from('training_materials')
            .select('*')
            .order('order_index', { ascending: true });

        if (error) {
            console.warn('Error fetching training materials from DB, returning static data:', error.message);
            return res.json({
                materials: [
                    { id: '1', title: 'Introduction to Transcription', description: 'Understand the basics of transcription and industry standards.', link: 'https://example.com/intro-to-transcription' },
                    { id: '2', title: 'Clean Verbatim Guidelines', description: 'Master the art of clean verbatim transcription.', link: 'https://example.com/clean-verbatim' },
                    { id: '3', title: 'Full Verbatim Guidelines', description: 'Learn when and how to apply full verbatim transcription.', link: 'https://example.com/full-verbatim' },
                    { id: '4', title: 'Timestamping Best Practices', description: 'A guide to accurate and effective timestamping.', link: 'https://example.com/timestamping' },
                    { id: '5', title: 'Useful Tools for Transcribers', description: 'Software and resources to boost your productivity.', link: 'https://example.com/tools' },
                ]
            });
        }
        res.json({ materials });

    } catch (error) {
        console.error('Error in getTrainingMaterials:', error);
        res.status(500).json({ error: 'Server error fetching training materials.' });
    }
};

const createTrainingMaterial = async (req, res) => {
    try {
        const { title, description, link, order_index } = req.body;

        if (!title || !link) {
            return res.status(400).json({ error: 'Title and link are required for a new training material.' });
        }

        const { data, error } = await supabase
            .from('training_materials')
            .insert([{ title, description, link, order_index }])
            .select()
            .single();

        if (error) throw error;

        res.status(201).json({ message: 'Training material created successfully.', material: data });
    } catch (error) {
        console.error('Error in createTrainingMaterial:', error);
        res.status(500).json({ error: error.message || 'Server error creating training material.' });
    }
};

const updateTrainingMaterial = async (req, res) => {
    try {
        const { materialId } = req.params;
        const { title, description, link, order_index } = req.body;

        if (!title || !link) {
            return res.status(400).json({ error: 'Title and link are required for a training material update.' });
        }

        const { data, error } = await supabase
            .from('training_materials')
            .update({ title, description, link, order_index, updated_at: new Date().toISOString() })
            .eq('id', materialId)
            .select()
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ error: 'Training material not found.' });
            }
            throw error;
        }

        res.status(200).json({ message: 'Training material updated successfully.', material: data });
    } catch (error) {
        console.error('Error in updateTrainingMaterial:', error);
        res.status(500).json({ error: error.message || 'Server error updating training material.' });
    }
};

const deleteTrainingMaterial = async (req, res) => {
    try {
        const { materialId } = req.params;

        const { error } = await supabase
            .from('training_materials')
            .delete()
            .eq('id', materialId);

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ error: 'Training material not found.' });
            }
            throw error;
        }

        res.status(200).json({ message: 'Training material deleted successfully.' });
    } catch (error) {
        console.error('Error in deleteTrainingMaterial:', error);
        res.status(500).json({ error: error.message || 'Server error deleting training material.' });
    }
};


const getTraineeTrainingRoomMessages = async (req, res, io) => {
    try {
        const { chatId } = req.params;
        const userId = req.user.userId;

        if (userId !== chatId && req.user.userType !== 'admin') {
            return res.status(403).json({ error: 'Access denied. You can only view your own training room messages.' });
        }

        const adminId = process.env.ADMIN_USER_ID;
        if (!adminId) {
            console.error('ADMIN_USER_ID is not configured.');
            return res.status(500).json({ error: 'Training chat admin not configured.' });
        }

        const { data: messages, error } = await supabase
            .from('messages')
            .select('id, sender_id, receiver_id, content, timestamp, is_read, file_url, file_name, training_room_id')
            .eq('training_room_id', chatId)
            .order('timestamp', { ascending: true });

        if (error) {
            console.error(`Error fetching training room messages for trainee ${chatId}:`, error);
            throw error;
        }

        if (messages && messages.length > 0 && io) {
            const unreadMessagesForUser = messages.filter(msg => msg.receiver_id === userId && !msg.is_read);
            if (unreadMessagesForUser.length > 0) {
                const unreadIds = unreadMessagesForUser.map(msg => msg.id);
                const { error: updateError } = await supabase
                    .from('messages')
                    .update({ is_read: true, read_at: new Date().toISOString() })
                    .in('id', unreadIds);

                if (updateError) {
                    console.error('Error marking training room messages as read:', updateError);
                } else {
                    const senderOfUnreadMessages = unreadMessagesForUser[0].sender_id;
                    if (senderOfUnreadMessages !== userId) {
                         io.to(senderOfUnreadMessages).emit('unreadMessageCountUpdate', { userId: senderOfUnreadMessages, change: -unreadIds.length });
                         io.to(senderOfUnreadMessages).emit('messageRead', {
                             senderId: userId,
                             receiverId: senderOfUnreadMessages,
                             trainingRoomId: chatId,
                             messageIds: unreadIds
                         });
                    }
                }
            }
        }

        res.json({ messages });
    } catch (error) {
        console.error('Error in getTraineeTrainingRoomMessages:', error);
        res.status(500).json({ error: 'Server error fetching training room messages.' });
    }
};

const sendTraineeTrainingRoomMessage = async (req, res, io) => {
    try {
        const { trainingRoomId, receiverId, messageText, fileUrl, fileName } = req.body;
        const senderId = req.user.userId;
        const senderFullName = req.user.full_name || (req.user.userType === 'admin' ? 'Admin' : 'Trainee');

        if (!trainingRoomId || !receiverId || (!messageText && !fileUrl)) {
            return res.status(400).json({ error: 'Training Room ID, Receiver ID, and either message text or a file are required.' });
        }

        if (senderId !== trainingRoomId && req.user.userType !== 'admin') {
            return res.status(403).json({ error: 'Access denied. You can only send messages in your own training room or as an admin.' });
        }

        const { data: newMessage, error } = await supabase
            .from('messages')
            .insert({
                sender_id: senderId,
                receiver_id: receiverId,
                training_room_id: trainingRoomId,
                content: messageText,
                is_read: false,
                file_url: fileUrl,
                file_name: fileName
            })
            .select('id, sender_id, receiver_id, training_room_id, content, timestamp, is_read, file_url, file_name')
            .single();

        if (error) throw error;

        if (io) {
            const messagePayload = {
                ...newMessage,
                sender_name: senderFullName,
            };

            console.log("[sendTraineeTrainingRoomMessage] Emitting messagePayload:", messagePayload);

            io.to(receiverId).emit('newChatMessage', messagePayload);
            io.to(senderId).emit('newChatMessage', messagePayload);
            io.to(receiverId).emit('unreadMessageCountUpdate', { userId: receiverId, change: 1 });
            console.log(`[sendTraineeTrainingRoomMessage] Emitted 'newChatMessage' for training room ${trainingRoomId}`);
        }

        res.status(201).json({ message: 'Training room message sent successfully', messageData: newMessage });
    } catch (error) {
        console.error('Error in sendTraineeTrainingRoomMessage:', error);
        res.status(500).json({ error: error.message });
    }
};


const completeTraining = async (req, res) => {
    try {
        const { traineeId } = req.params;
        const adminId = req.user.userId;

        if (req.user.userType !== 'admin') {
            return res.status(403).json({ error: 'Access denied. Only admins can complete training.' });
        }

        const { data: traineeUser, error: fetchError } = await supabase
            .from('users')
            .select('id, full_name, email, user_type, transcriber_status, transcriber_user_level')
            .eq('id', traineeId)
            .eq('user_type', 'trainee')
            .single();

        if (fetchError || !traineeUser) {
            console.error(`Error fetching trainee ${traineeId} for training completion:`, fetchError);
            return res.status(404).json({ error: 'Trainee not found or not a valid trainee user.' });
        }

        if (traineeUser.transcriber_status !== 'paid_training_fee') {
            return res.status(400).json({ error: 'Trainee has not paid the training fee. Cannot complete training.' });
        }

        const { data: updatedUser, error: updateError } = await supabase
            .from('users')
            .update({
                user_type: 'transcriber',
                transcriber_status: 'active_transcriber',
                transcriber_user_level: 'transcriber',
                is_active: true,
                // REMOVED: is_available: true, // This line was causing the error
                updated_at: new Date().toISOString()
            })
            .eq('id', traineeId)
            .select('id, full_name, email, user_type, transcriber_status, transcriber_user_level')
            .single();

        if (updateError) {
            console.error(`Error updating user ${traineeId} to active transcriber:`, updateError);
            throw updateError;
        }

        const { error: transcriberMarkerError } = await supabase
            .from('transcribers')
            .insert([{ id: traineeId }]);
        
        if (transcriberMarkerError) {
            console.error(`Error creating transcriber marker for ${traineeId}:`, transcriberMarkerError);
        }

        await emailService.sendTrainingCompletionEmail(updatedUser);

        res.status(200).json({
            message: `Trainee ${traineeUser.full_name} successfully transitioned to an active transcriber.`,
            user: updatedUser
        });

    } catch (error) {
        console.error('Error in completeTraining:', error);
        res.status(500).json({ error: error.message || 'Server error completing training.! ' });
    }
};

const initializeTrainingPayment = async (req, res, io) => {
    const { amount, email, paymentMethod = 'paystack', mobileNumber, fullName } = req.body;
    const traineeId = req.user.userId;

    if (!amount || !email) {
        return res.status(400).json({ error: 'Amount and trainee email are required for training payment.ᐟ' });
    }
    if (!['paystack', 'korapay'].includes(paymentMethod)) {
        console.error(`Invalid payment method provided: ${paymentMethod}`);
        return res.status(400).json({ error: 'Invalid payment method provided.ᐟ' });
    }
    if (paymentMethod === 'paystack' && !PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not set for training payment.');
        return res.status(500).json({ error: 'Paystack service not configured.ᐟ' });
    }
    if (paymentMethod === 'korapay' && (!KORAPAY_SECRET_KEY || !KORAPAY_PUBLIC_KEY)) {
        console.error('KORAPAY_SECRET_KEY or KORAPAY_PUBLIC_KEY is not set for training payment.');
        return res.status(500).json({ error: 'KoraPay service not configured.ᐟ' });
    }

    const parsedAmountUsd = parseFloat(amount);
    if (isNaN(parsedAmountUsd) || parsedAmountUsd <= 0) {
        return res.status(400).json({ error: 'Invalid training payment amount.ᐟ' });
    }

    if (Math.round(parsedAmountUsd * 100) !== Math.round(TRAINING_FEE_USD * 100)) {
        console.error('Training payment amount mismatch. Provided USD:', parsedAmountUsd, 'Expected USD:', TRAINING_FEE_USD);
        return res.status(400).json({ error: `Training payment amount must be USD ${TRAINING_FEE_USD}.` });
    }

    try {
        if (paymentMethod === 'paystack') {
            const amountKes = convertUsdToKes(parsedAmountUsd);
            const amountInCentsKes = Math.round(amountKes * 100);

            const paystackResponse = await axios.post(
                'https://api.paystack.co/transaction/initialize',
                {
                    email: email,
                    amount: amountInCentsKes,
                    reference: `TRAINING-${traineeId}-${Date.now()}`,
                    callback_url: `${CLIENT_URL}/payment-callback?relatedJobId=${traineeId}&jobType=training`,
                    currency: 'KES',
                    channels: ['mobile_money', 'card', 'bank_transfer', 'pesalink'],
                    metadata: {
                        related_job_id: traineeId,
                        related_job_type: 'training',
                        client_id: traineeId,
                        agreed_price_usd: TRAINING_FEE_USD,
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
                console.error('Paystack training initialization failed:', paystackResponse.data.message);
                return res.status(500).json({ error: paystackResponse.data.message || 'Failed to initialize training payment with Paystack.ᐟ' });
            }

            res.status(200).json({
                message: 'Training payment initialization successful',
                data: paystackResponse.data.data
            });
        } else if (paymentMethod === 'korapay') {
            const reference = `TR-${traineeId.substring(0, 8)}-${Date.now().toString(36)}`;
            
            const amountKes = convertUsdToKes(parsedAmountUsd);
            // MODIFIED: Send amount in KES (integer, base unit) for KoraPay Checkout Standard
            const amountInKes = Math.round(amountKes); // Round to integer for base KES unit

            const korapayData = {
                key: KORAPAY_PUBLIC_KEY,
                reference: reference,
                amount: amountInKes, // Send amount in KES (base unit)
                currency: 'KES',
                customer: {
                    name: fullName || req.user.full_name || 'Trainee',
                    email: email,
                },
                notification_url: KORAPAY_WEBHOOK_URL, 
                metadata: {
                    related_job_id: traineeId,
                    related_job_type: 'training',
                    client_id: traineeId,
                    agreed_price_usd: TRAINING_FEE_USD,
                    currency_paid: 'KES',
                    exchange_rate_usd_to_kes: EXCHANGE_RATE_USD_TO_KES,
                    amount_paid_kes: amountKes
                }
            };
            
            res.status(200).json({
                message: 'KoraPay training payment initialization data successful',
                korapayData: korapayData
            });
        }

    } catch (error) {
        console.error(`[initializeTrainingPayment] Error initializing ${paymentMethod} payment:`, error.response ? error.response.data : error.message);
        res.status(500).json({ error: `Server error during ${paymentMethod} payment initialization.ᐟ` });
    }
};

const verifyKorapayTrainingPayment = async (req, res, io) => {
    const { reference } = req.body;
    const traineeId = req.user.userId;

    if (!reference) {
        return res.status(400).json({ error: 'KoraPay transaction reference is required for verification.ᐟ' });
    }
    if (!KORAPAY_SECRET_KEY) {
        console.error('KORAPAY_SECRET_KEY is not set for KoraPay verification.');
        return res.status(500).json({ error: 'KoraPay service not configured.ᐟ' });
    }

    try {
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
            console.error('KoraPay training verification failed:', korapayResponse.data.message || korapayResponse.data.errors);
            return res.status(400).json({ error: korapayResponse.data.message || 'KoraPay training payment verification failed.ᐟ' });
        }

        const transaction = korapayResponse.data.data;

        let transactionDate = transaction.createdAt ? new Date(transaction.createdAt) : new Date();
        if (isNaN(transactionDate.getTime())) {
            console.error('[verifyKorapayTrainingPayment] KoraPay transaction.createdAt is an invalid date:', transaction.createdAt);
            transactionDate = new Date();
        }

        // MODIFIED: Interpret amount received from KoraPay as KES (base unit), then convert to USD
        const amountPaidKes = parseFloat(transaction.amount); // KoraPay returns amount in base unit
        const amountPaidInUsd = parseFloat((amountPaidKes / EXCHANGE_RATE_USD_TO_KES).toFixed(2));

        if (Math.round(amountPaidInUsd * 100) !== Math.round(TRAINING_FEE_USD * 100)) {
            console.error('KoraPay training verification amount mismatch. Paid USD:', amountPaidInUsd, 'Expected USD:', TRAINING_FEE_USD);
            return res.status(400).json({ error: 'KoraPay training payment amount mismatch.ᐟ' });
        }

        const { error: updateTraineeStatusError } = await supabase
            .from('users')
            .update({ transcriber_status: 'paid_training_fee', updated_at: new Date().toISOString() })
            .eq('id', traineeId);

        if (updateTraineeStatusError) {
            console.error(`Error updating trainee ${traineeId} status after KoraPay payment:`, updateTraineeStatusError);
            throw updateTraineeStatusError;
        }
        console.log(`Trainee ${traineeId} status updated to 'paid_training_fee' after successful KoraPay payment.`);

        const { error: paymentRecordError } = await supabase
            .from('payments')
            .insert([
                {
                    negotiation_id: null,
                    direct_upload_job_id: null,
                    related_job_type: 'training',
                    client_id: traineeId,
                    transcriber_id: traineeId,
                    amount: amountPaidInUsd,
                    transcriber_earning: amountPaidInUsd,
                    currency: 'USD',
                    paystack_reference: null,
                    paystack_status: null,
                    korapay_reference: transaction.reference,
                    korapay_status: transaction.status,
                    transaction_date: transactionDate.toISOString(),
                    payout_status: 'completed',
                    currency_paid_by_client: 'KES',
                    exchange_rate_used: EXCHANGE_RATE_USD_TO_KES
                }
            ])
            .select()
            .single();

        if (paymentRecordError) {
            console.error('Error recording KoraPay training payment in Supabase:', paymentRecordError);
            throw paymentRecordError;
        }

        if (io) {
            io.to(traineeId).emit('training_payment_successful', {
                traineeId: traineeId,
                message: 'Your training payment was successful! You now have access to the training dashboard.ᐟ',
                newStatus: 'paid_training_fee'
            });
            console.log(`Emitted 'training_payment_successful' to trainee ${traineeId}`);
        }

        res.status(200).json({
            success: true,
            message: 'KoraPay training payment verified successfully and access granted.ᐟ',
            transaction: transaction
        });

    } catch (error) {
        console.error('[verifyKorapayTrainingPayment] Error verifying KoraPay training payment:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error during KoraPay training payment verification.ᐟ' + (error.message || '') });
    }
};


module.exports = {
    getTraineeTrainingStatus,
    getTrainingMaterials,
    createTrainingMaterial,
    updateTrainingMaterial,
    deleteTrainingMaterial,
    getTraineeTrainingRoomMessages,
    sendTraineeTrainingRoomMessage,
    uploadTrainingRoomAttachment,
    handleTrainingRoomAttachmentUpload,
    completeTraining,
    initializeTrainingPayment,
    verifyKorapayTrainingPayment
};
