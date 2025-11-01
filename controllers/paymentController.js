const axios = require('axios');
const supabase = require('../database');
const { syncAvailabilityStatus } = require('../controllers/transcriberController');
const emailService = require('../emailService');
const { calculateTranscriberEarning, convertUsdToKes, EXCHANGE_RATE_USD_TO_KES } = require('../utils/paymentUtils');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
// NEW: KoraPay Configuration
const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY;
const KORAPAY_BASE_URL = process.env.KORAPAY_BASE_URL || 'https://api-sandbox.korapay.com/v1'; // Default to sandbox

const getNextFriday = () => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
    const nextFriday = new Date(today);
    nextFriday.setDate(today.getDate() + daysUntilFriday);
    nextFriday.setHours(23, 59, 59, 999);
    return nextFriday.toISOString();
};


const initializePayment = async (req, res, io) => {
    console.log('[initializePayment] Received request body:', req.body);

    // FIX: Destructure negotiationId if present, and use 'email' from body
    const { jobId: rawJobId, negotiationId, amount, email, jobType, paymentMethod = 'paystack' } = req.body; // Added paymentMethod
    const clientId = req.user.userId;

    // Determine the actual jobId and clientEmail to use
    const finalJobId = rawJobId || negotiationId;
    const finalClientEmail = email; // Using 'email' from the request body

    console.log(`[initializePayment] Destructured parameters - jobId: ${finalJobId}, amount: ${amount}, clientEmail: ${finalClientEmail}, jobType: ${jobType}, clientId: ${clientId}, paymentMethod: ${paymentMethod}`);

    if (!finalJobId || !amount || !finalClientEmail || !jobType) {
        console.error('[initializePayment] Validation failed: Missing required parameters.ᐟ');
        return res.status(400).json({ error: 'Job ID, amount, job type, and client email are required.ᐟ' });
    }
    if (!['negotiation', 'direct_upload', 'training'].includes(jobType)) {
        console.error(`[initializePayment] Validation failed: Invalid job type provided: ${jobType}`);
        return res.status(400).json({ error: 'Invalid job type provided for payment initialization.ᐟ' });
    }
    if (!['paystack', 'korapay'].includes(paymentMethod)) { // Validate payment method
        console.error(`[initializePayment] Validation failed: Invalid payment method provided: ${paymentMethod}`);
        return res.status(400).json({ error: 'Invalid payment method provided.ᐟ' });
    }

    if (paymentMethod === 'paystack' && !PAYSTACK_SECRET_KEY) {
        console.error('[initializePayment] PAYSTACK_SECRET_KEY is not set.');
        return res.status(500).json({ error: 'Paystack service not configured.ᐟ' });
    }
    if (paymentMethod === 'korapay' && !KORAPAY_SECRET_KEY) {
        console.error('[initializePayment] KORAPAY_SECRET_KEY is not set.');
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

        if (jobType === 'negotiation') {
            const { data, error } = await supabase
                .from('negotiations')
                .select('id, client_id, transcriber_id, agreed_price_usd, status')
                .eq('id', finalJobId) // Use finalJobId
                .eq('client_id', clientId)
                .single();
            if (error || !data) {
                console.error(`[initializePayment] Error fetching negotiation ${finalJobId} for payment:`, error);
                return res.status(404).json({ error: 'Negotiation not found or not accessible.ᐟ' });
            }
            jobDetails = data;
            transcriberId = data.transcriber_id;
            agreedPriceUsd = data.agreed_price_usd;
            jobStatus = data.status;
            if (jobStatus !== 'accepted_awaiting_payment') {
                console.error(`[initializePayment] Negotiation ${finalJobId} status is ${jobStatus}, not 'accepted_awaiting_payment'.`);
                return res.status(400).json({ error: `Payment can only be initiated for accepted negotiations (status: accepted_awaiting_payment). Current status: ${jobStatus}` });
            }
        } else if (jobType === 'direct_upload') {
            const { data, error } = await supabase
                .from('direct_upload_jobs')
                .select('id, client_id, transcriber_id, quote_amount, status')
                .eq('id', finalJobId) // Use finalJobId
                .eq('client_id', clientId)
                .single();
            if (error || !data) {
                console.error(`[initializePayment] Error fetching direct upload job ${finalJobId} for payment:`, error);
                return res.status(404).json({ error: 'Direct upload job not found or not accessible.ᐟ' });
            }
            jobDetails = data;
            transcriberId = data.transcriber_id;
            agreedPriceUsd = data.quote_amount;
            jobStatus = data.status;
            if (jobStatus !== 'pending_review' && jobStatus !== 'transcriber_assigned') {
                console.error(`[initializePayment] Direct upload job ${finalJobId} status is ${jobStatus}, not 'pending_review' or 'transcriber_assigned'.`);
                return res.status(400).json({ error: `Payment can only be initiated for direct upload jobs awaiting review or with assigned transcriber. Current status: ${jobStatus}` });
            }
        } else if (jobType === 'training') {
            const { data: traineeUser, error } = await supabase
                .from('users')
                .select('id, email, transcriber_status')
                .eq('id', finalJobId) // Use finalJobId
                .eq('user_type', 'trainee')
                .single();
            
            if (error || !traineeUser) {
                console.error(`[initializePayment] Error fetching trainee ${finalJobId} for training payment:`, error);
                return res.status(404).json({ error: 'Trainee not found or not accessible for training payment.ᐟ' });
            }
            if (traineeUser.transcriber_status === 'paid_training_fee') {
                return res.status(400).json({ error: 'Trainee has already paid for training.ᐟ' });
            }
            jobDetails = traineeUser;
            transcriberId = traineeUser.id;
            agreedPriceUsd = 2.00; // Updated training fee
            jobStatus = traineeUser.transcriber_status;
            
            if (Math.round(parsedAmountUsd * 100) !== Math.round(agreedPriceUsd * 100)) {
                console.error('[initializePayment] Training payment amount mismatch. Provided USD:', parsedAmountUsd, 'Expected USD:', agreedPriceUsd);
                return res.status(400).json({ error: `Training payment amount must be USD ${agreedPriceUsd}.` });
            }
        }
        else {
            console.error(`[initializePayment] Unsupported job type for payment initialization: ${jobType}`);
            return res.status(400).json({ error: 'Unsupported job type for payment initialization.ᐟ' });
        }

        if (jobType !== 'training' && Math.round(parsedAmountUsd * 100) !== Math.round(agreedPriceUsd * 100)) {
            console.error('[initializePayment] Payment amount mismatch. Provided USD:', parsedAmountUsd, 'Agreed USD:', agreedPriceUsd);
            return res.status(400).json({ error: 'Payment amount does not match the agreed job price.ᐟ' });
        }

        if (paymentMethod === 'paystack') {
            const amountKes = convertUsdToKes(parsedAmountUsd);
            const amountInCentsKes = Math.round(amountKes * 100);

            const paystackResponse = await axios.post(
                'https://paystack.co/transaction/initialize',
                {
                    email: finalClientEmail,
                    amount: amountInCentsKes,
                    reference: `${finalJobId}-${Date.now()}`,
                    callback_url: `${CLIENT_URL}/payment-callback?relatedJobId=${finalJobId}&jobType=${jobType}`,
                    currency: 'KES',
                    channels: ['mobile_money', 'card', 'bank_transfer', 'pesalink'],
                    metadata: {
                        related_job_id: finalJobId,
                        related_job_type: jobType,
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
                console.error('[initializePayment] Paystack initialization failed:', paystackResponse.data.message);
                return res.status(500).json({ error: paystackResponse.data.message || 'Failed to initialize payment with Paystack.ᐟ' });
            }

            res.status(200).json({
                message: 'Payment initialization successful',
                data: paystackResponse.data.data
            });
        } else if (paymentMethod === 'korapay') {
            const korapayResponse = await axios.post(
                `${KORAPAY_BASE_URL}/charges/initiate`, // Corrected KoraPay endpoint
                {
                    amount: parsedAmountUsd,
                    currency: 'USD',
                    reference: `${finalJobId}-${Date.now()}`,
                    narration: `Payment for TypeMyworDz ${jobType} job ${finalJobId}`,
                    customer: {
                        name: req.user.full_name || 'Customer',
                        email: finalClientEmail,
                        // KoraPay may require a phone number or other details
                    },
                    redirect_url: `${CLIENT_URL}/payment-callback?relatedJobId=${finalJobId}&jobType=${jobType}&paymentMethod=korapay`,
                    metadata: {
                        related_job_id: finalJobId,
                        related_job_type: jobType,
                        client_id: clientId,
                        transcriber_id: transcriberId,
                        agreed_price_usd: agreedPriceUsd,
                        currency_paid: 'USD',
                        exchange_rate_usd_to_kes: EXCHANGE_RATE_USD_TO_KES, // Keep for consistency if needed later
                        amount_paid_usd: parsedAmountUsd
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${KORAPAY_SECRET_KEY}`,
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
                    }
                }
            );

            if (!korapayResponse.data.status || korapayResponse.data.status !== true) {
                console.error('[initializePayment] KoraPay initialization failed:', korapayResponse.data.message || korapayResponse.data.errors);
                return res.status(500).json({ error: korapayResponse.data.message || 'Failed to initialize payment with KoraPay.ᐟ' });
            }

            res.status(200).json({
                message: 'Payment initialization successful',
                data: { authorization_url: korapayResponse.data.data.checkout_url }
            });
        }

    } catch (error) {
        console.error(`[initializePayment] Error initializing ${paymentMethod} payment:`, error.response ? error.response.data : error.message);
        res.status(500).json({ error: `Server error during ${paymentMethod} payment initialization.ᐟ` });
    }
};

const initializeTrainingPayment = async (req, res, io) => {
    const { amount, email, paymentMethod = 'paystack' } = req.body; // Added paymentMethod
    const traineeId = req.user.userId;

    if (!amount || !email) {
        return res.status(400).json({ error: 'Amount and trainee email are required for training payment.ᐟ' });
    }
    if (!['paystack', 'korapay'].includes(paymentMethod)) { // Validate payment method
        console.error(`Invalid payment method provided: ${paymentMethod}`);
        return res.status(400).json({ error: 'Invalid payment method provided.ᐟ' });
    }
    if (paymentMethod === 'paystack' && !PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not set for training payment.');
        return res.status(500).json({ error: 'Paystack service not configured.ᐟ' });
    }
    if (paymentMethod === 'korapay' && !KORAPAY_SECRET_KEY) {
        console.error('KORAPAY_SECRET_KEY is not set for training payment.');
        return res.status(500).json({ error: 'KoraPay service not configured.ᐟ' });
    }

    const parsedAmountUsd = parseFloat(amount);
    if (isNaN(parsedAmountUsd) || parsedAmountUsd <= 0) {
        return res.status(400).json({ error: 'Invalid training payment amount.ᐟ' });
    }

    const TRAINING_FEE_USD = 2.00; // Updated training fee
    if (Math.round(parsedAmountUsd * 100) !== Math.round(TRAINING_FEE_USD * 100)) {
        console.error('Training payment amount mismatch. Provided USD:', parsedAmountUsd, 'Expected USD:', TRAINING_FEE_USD);
        return res.status(400).json({ error: `Training payment amount must be USD ${TRAINING_FEE_USD}.` });
    }

    try {
        if (paymentMethod === 'paystack') {
            const amountKes = convertUsdToKes(parsedAmountUsd);
            const amountInCentsKes = Math.round(amountKes * 100);

            const paystackResponse = await axios.post(
                'https://paystack.co/transaction/initialize',
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
            const korapayResponse = await axios.post(
                `${KORAPAY_BASE_URL}/charges/initiate`, // Corrected KoraPay endpoint
                {
                    payment_reference: `TRAINING-${traineeId}-${Date.now()}`,
                    source: {
                        type: 'bank_transfer', // 'source.type' is required
                        // Reintroducing payment details within source, based on iterative error handling
                        amount: parsedAmountUsd,
                        currency: 'USD',
                        reference: `TRAINING-${traineeId}-${Date.now()}-source`,
                        narration: `Training Fee for TypeMyworDz Trainee ${traineeId}`,
                        customer: {
                            name: req.user.full_name || 'Trainee',
                            email: email,
                        },
                        redirect_url: `${CLIENT_URL}/payment-callback?relatedJobId=${traineeId}&jobType=training&paymentMethod=korapay`,
                        metadata: {
                            related_job_id: traineeId,
                            related_job_type: 'training',
                            client_id: traineeId,
                            agreed_price_usd: TRAINING_FEE_USD,
                            currency_paid: 'USD',
                            exchange_rate_usd_to_kes: EXCHANGE_RATE_USD_TO_KES,
                            amount_paid_usd: parsedAmountUsd
                        }
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${KORAPAY_SECRET_KEY}`,
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
                    }
                }
            );

            if (!korapayResponse.data.status || korapayResponse.data.status !== true) {
                console.error('KoraPay training initialization failed:', korapayResponse.data.message || korapayResponse.data.errors);
                return res.status(500).json({ error: korapayResponse.data.message || 'Failed to initialize training payment with KoraPay.ᐟ' });
            }

            res.status(200).json({
                message: 'Training payment initialization successful',
                data: { authorization_url: korapayResponse.data.data.checkout_url }
            });
        }

    } catch (error) {
        console.error(`[initializeTrainingPayment] Error initializing ${paymentMethod} payment:`, error.response ? error.response.data : error.message);
        res.status(500).json({ error: `Server error during ${paymentMethod} payment initialization.ᐟ` });
    }
};


const verifyPayment = async (req, res, io) => {
    const { reference } = req.params;
    const { relatedJobId, jobType, paymentMethod = 'paystack' } = req.query; // Added paymentMethod

    if (!reference || !relatedJobId || !jobType) {
        return res.status(400).json({ error: 'Payment reference, job ID, and job type are required for verification.ᐟ' });
    }
    if (!['paystack', 'korapay'].includes(paymentMethod)) { // Validate payment method
        console.error(`Invalid payment method provided: ${paymentMethod}`);
        return res.status(400).json({ error: 'Invalid payment method provided.ᐟ' });
    }
    if (paymentMethod === 'paystack' && !PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not set.');
        return res.status(500).json({ error: 'Paystack service not configured.ᐟ' });
    }
    if (paymentMethod === 'korapay' && !KORAPAY_SECRET_KEY) {
        console.error('KORAPAY_SECRET_KEY is not set.');
        return res.status(500).json({ error: 'KoraPay service not configured.ᐟ' });
    }

    try {
        let transaction;

        if (paymentMethod === 'paystack') {
            const paystackResponse = await axios.get(
                `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
                    }
                }
            );

            if (!paystackResponse.data.status || paystackResponse.data.data.status !== 'success') {
                console.error('Paystack verification failed:', paystackResponse.data.data.gateway_response);
                return res.status(400).json({ error: paystackResponse.data.data.gateway_response || 'Payment verification failed.ᐟ' });
            }
            transaction = paystackResponse.data.data;
        } else if (paymentMethod === 'korapay') {
            const korapayResponse = await axios.get(
                `${KORAPAY_BASE_URL}/charges/${reference}/verify`, // Corrected KoraPay verify endpoint
                {
                    headers: {
                        Authorization: `Bearer ${KORAPAY_SECRET_KEY}`,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
                    }
                }
            );

            if (!korapayResponse.data.status || korapayResponse.data.data.status !== 'success') {
                console.error('KoraPay verification failed:', korapayResponse.data.message || korapayResponse.data.errors);
                return res.status(400).json({ error: korapayResponse.data.message || 'Payment verification failed with KoraPay.ᐟ' });
            }
            transaction = korapayResponse.data.data;
            // KoraPay's transaction object might be structured differently,
            // so we'll need to map its fields to match Paystack's for consistency
            transaction.amount = transaction.amount * 100; // Convert to cents for consistency if KoraPay returns whole units
            transaction.paid_at = transaction.paidAt; // Example mapping
            transaction.metadata = transaction.metadata || {}; // Ensure metadata exists
            // Map KoraPay metadata to match Paystack's metadata structure if necessary
            // For now, assume metadata structure is similar or adapt as needed
        }


        const {
            related_job_id: metadataRelatedJobId,
            related_job_type: metadataRelatedJobType,
            client_id: metadataClientId,
            transcriber_id: metadataTranscriberIdRaw,
            agreed_price_usd: metadataAgreedPrice,
            currency_paid: metadataCurrencyPaid,
            exchange_rate_usd_to_kes: metadataExchangeRate,
            amount_paid_kes: metadataAmountPaidKes // This will be undefined for KoraPay USD payments
        } = transaction.metadata;

        const finalTranscriberId = (metadataTranscriberIdRaw === '' || metadataTranscriberIdRaw === undefined) ? null : metadataTranscriberIdRaw;

        if (metadataRelatedJobId !== relatedJobId || metadataRelatedJobType !== jobType) {
            console.error('Metadata job ID or type mismatch:', metadataRelatedJobId, relatedJobId, metadataRelatedJobType, jobType);
            return res.status(400).json({ error: 'Invalid transaction metadata (job ID or type mismatch).ᐟ' });
        }

        if (jobType === 'training') {
            const TRAINING_FEE_USD = 2.00; // Updated training fee
            if (Math.round(metadataAgreedPrice * 100) !== Math.round(TRAINING_FEE_USD * 100)) {
                console.error('Training metadata amount mismatch. Agreed USD:', metadataAgreedPrice, 'Expected USD:', TRAINING_FEE_USD);
                return res.status(400).json({ error: 'Invalid transaction metadata (training amount mismatch).ᐟ' });
            }

            let actualAmountPaidUsd;
            let expectedAmountInCents;
            if (paymentMethod === 'paystack') {
                const expectedAmountKes = convertUsdToKes(TRAINING_FEE_USD);
                expectedAmountInCents = Math.round(expectedAmountKes * 100);
                actualAmountPaidUsd = parseFloat((transaction.amount / 100 / metadataExchangeRate).toFixed(2));
            } else if (paymentMethod === 'korapay') {
                expectedAmountInCents = Math.round(TRAINING_FEE_USD * 100); // KoraPay amount will be in USD, convert to cents for comparison
                actualAmountPaidUsd = parseFloat(transaction.amount.toFixed(2)); // KoraPay amount is already in USD
            }
            

            if (transaction.amount !== expectedAmountInCents) {
                console.error('Training metadata amount mismatch. Transaction amount (cents):', transaction.amount, 'Expected cents:', expectedAmountInCents);
                return res.status(400).json({ error: 'Invalid transaction metadata (training amount mismatch). Payment charged a different amount than expected.ᐟ' });
            }

            const { error: updateTraineeStatusError } = await supabase
                .from('users')
                .update({ transcriber_status: 'paid_training_fee', updated_at: new Date().toISOString() })
                .eq('id', metadataClientId);

            if (updateTraineeStatusError) {
                console.error(`Error updating trainee ${metadataClientId} status after payment:`, updateTraineeStatusError);
                throw updateTraineeStatusError;
            }
            console.log(`Trainee ${metadataClientId} status updated to 'paid_training_fee' after successful payment.`);

            const { error: paymentRecordError } = await supabase
                .from('payments')
                .insert([
                    {
                        negotiation_id: null,
                        direct_upload_job_id: null,
                        related_job_type: 'training',
                        client_id: metadataClientId,
                        transcriber_id: metadataClientId, // Trainee ID is used as transcriber_id for training payments
                        amount: actualAmountPaidUsd,
                        transcriber_earning: actualAmountPaidUsd, // For training, full amount is earning
                        currency: 'USD',
                        paystack_reference: paymentMethod === 'paystack' ? transaction.reference : null, // Only store if Paystack
                        korapay_reference: paymentMethod === 'korapay' ? transaction.reference : null, // Store KoraPay reference
                        paystack_status: paymentMethod === 'paystack' ? transaction.status : null,
                        korapay_status: paymentMethod === 'korapay' ? transaction.status : null,
                        transaction_date: new Date(transaction.paid_at).toISOString(),
                        payout_status: 'completed',
                        currency_paid_by_client: metadataCurrencyPaid,
                        exchange_rate_used: metadataExchangeRate
                    }
                ])
                .select()
                .single();

            if (paymentRecordError) {
                console.error('Error recording training payment in Supabase:', paymentRecordError);
                throw paymentRecordError;
            }

            if (io) {
                io.to(metadataClientId).emit('training_payment_successful', {
                    traineeId: metadataClientId,
                    message: 'Your training payment was successful! You now have access to the training dashboard.ᐟ',
                    newStatus: 'paid_training_fee'
                });
                console.log(`Emitted 'training_payment_successful' to trainee ${metadataClientId}`);
            }

            return res.status(200).json({
                message: 'Training payment verified successfully and access granted.ᐟ',
                transaction: transaction
            });
        }


        let currentJob;
        let updateTable;
        let updateStatusColumn;
        let newJobStatus; // Define a variable for the new job status

        if (jobType === 'negotiation') {
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
            updateTable = 'negotiations';
            updateStatusColumn = 'status';
            newJobStatus = 'hired'; // For negotiation, status becomes 'hired'
            if (currentJob.status === 'hired') {
                return res.status(200).json({ message: 'Payment already processed and job already hired.ᐟ' });
            }
        } else if (jobType === 'direct_upload') {
            const { data, error } = await supabase
                .from('direct_upload_jobs')
                .select('id, client_id, transcriber_id, quote_amount, status')
                .eq('id', relatedJobId)
                .single();
            if (error || !data) {
                console.error(`Error fetching direct upload job ${relatedJobId} during payment verification: `, error);
                return res.status(404).json({ error: 'Direct upload job not found for verification.ᐟ' });
            }
            currentJob = data;
            updateTable = 'direct_upload_jobs';
            updateStatusColumn = 'status';
            newJobStatus = 'available_for_transcriber'; // For direct upload, status becomes 'available_for_transcriber'
            if (currentJob.status === 'available_for_transcriber' || currentJob.status === 'taken' || currentJob.status === 'in_progress') {
                 return res.status(200).json({ message: 'Payment already processed and direct upload job already active.ᐟ' });
            }
        } else {
            return res.status(400).json({ error: 'Unsupported job type for payment verification.ᐟ' });
        }

        let actualAmountPaidUsd;
        let transcriberPayAmount;
        if (paymentMethod === 'paystack') {
            actualAmountPaidUsd = parseFloat((transaction.amount / 100 / metadataExchangeRate).toFixed(2));
            transcriberPayAmount = calculateTranscriberEarning(actualAmountPaidUsd);
        } else if (paymentMethod === 'korapay') {
            actualAmountPaidUsd = parseFloat(transaction.amount.toFixed(2));
            transcriberPayAmount = calculateTranscriberEarning(actualAmountPaidUsd);
        }

        // Conditional insertion based on jobType for negotiation_id and direct_upload_job_id
        const paymentData = {
            related_job_type: jobType,
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
            currency_paid_by_client: metadataCurrencyPaid,
            exchange_rate_used: metadataExchangeRate
        };

        if (jobType === 'negotiation') {
            paymentData.negotiation_id = relatedJobId;
            paymentData.direct_upload_job_id = null;
        } else if (jobType === 'direct_upload') {
            paymentData.direct_upload_job_id = relatedJobId;
            paymentData.negotiation_id = null;
        } else if (jobType === 'training') { // This block should ideally not be reached if training is handled above
            paymentData.negotiation_id = null;
            paymentData.direct_upload_job_id = null;
        }

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
            .update({ [updateStatusColumn]: newJobStatus, updated_at: new Date().toISOString() }) // Use newJobStatus here
            .eq('id', relatedJobId);

        if (jobUpdateError) {
            console.error(`Error updating job status to ${newJobStatus} for ${jobType} ${relatedJobId}: `, jobUpdateError);
            throw jobUpdateError;
        }

        // Only sync availability if a transcriber was directly assigned (negotiation)
        if (jobType === 'negotiation' && finalTranscriberId) {
            await syncAvailabilityStatus(finalTranscriberId, false, relatedJobId);
        }

        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', metadataClientId).single();
        // Only fetch transcriber if one is assigned (negotiation)
        const transcriberUser = (jobType === 'negotiation' && finalTranscriberId)
            ? (await supabase.from('users').select('full_name, email').eq('id', finalTranscriberId).single()).data
            : null;

        if (clientError) console.error('Error fetching client for payment email: ', clientError);
        // FIX: Corrected error variable name from transcriberError to clientError (as transcriberError is not defined here)
        if (transcriberUser === null && jobType === 'negotiation') console.error('Error fetching transcriber for payment email: ', clientError);

        if (clientUser) { // Send email to client for both negotiation and direct upload
            await emailService.sendPaymentConfirmationEmail(clientUser, transcriberUser, currentJob, paymentRecord);
        }

        if (io) {
            io.to(metadataClientId).emit('payment_successful', {
                relatedJobId: relatedJobId,
                jobType: jobType,
                message: 'Your payment was successful and the job is now active!ᐟ',
                newStatus: newJobStatus
            });
            if (jobType === 'negotiation' && finalTranscriberId) { // Only emit job_hired for assigned transcribers in negotiation
                io.to(finalTranscriberId).emit('job_hired', {
                    relatedJobId: relatedJobId,
                    jobType: jobType,
                    message: 'A client has paid for your accepted job. The job is now active!ᐟ',
                    newStatus: newJobStatus
                });
                console.log(`Emitted 'payment_successful' to client ${metadataClientId} and 'job_hired' to transcriber ${finalTranscriberId}`);
            } else if (jobType === 'direct_upload') { // NEW: Emit direct_job_paid for direct uploads
                io.emit('direct_job_paid', { // Emit to all for 'other jobs' pool update
                    jobId: relatedJobId,
                    message: `A direct upload job has been paid for and is now available!`,
                    newStatus: newJobStatus
                });
                console.log(`Emitted 'payment_successful' to client ${metadataClientId} and 'direct_job_paid' to all transcribers.`);
            } else {
                console.log(`Emitted 'payment_successful' to client ${metadataClientId}. No specific transcriber or direct job event emitted.`);
            }
        }

        res.status(200).json({
            message: 'Payment verified successfully and job is now active.ᐟ',
            transaction: transaction
        });

    } catch (error) {
        console.error(`[verifyPayment] Error verifying ${paymentMethod} payment:`, error.response ? error.response.data : error.message);
        res.status(500).json({ error: `Server error during ${paymentMethod} payment verification.ᐟ` + (error.message || '') });
    }
};

const getTranscriberPaymentHistory = async (req, res) => {
    const transcriberId = req.user.userId;

    try {
        // Fetch payments along with joined data for both negotiation and direct upload jobs
        const { data: payments, error } = await supabase
            .from('payments')
            .select(`
                id,
                negotiation_id,
                direct_upload_job_id,
                related_job_type,
                client_id,
                transcriber_id,
                amount,
                transcriber_earning,
                currency,
                paystack_reference,
                korapay_reference, // NEW: KoraPay reference
                paystack_status,
                korapay_status, // NEW: KoraPay status
                transaction_date,
                payout_status,
                currency_paid_by_client,
                exchange_rate_used,
                client:users!client_id(full_name, email),
                negotiation:negotiation_id(id, status, requirements, deadline_hours, agreed_price_usd),
                direct_upload_job:direct_upload_jobs!direct_upload_job_id(id, status, client_instructions, agreed_deadline_hours, quote_amount)
            `)
            .eq('transcriber_id', transcriberId)
            // Filter by payout_status for upcoming payouts
            .or('payout_status.eq.awaiting_completion,payout_status.eq.paid_out')
            .order('transaction_date', { ascending: false });

        if (error) {
            console.error('Error fetching transcriber payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        const paymentsWithJobDetails = (payments || []).map(payment => {
            let jobRequirements = 'N/A';
            let jobStatus = 'N/A'; // Initialize jobStatus
            let jobAmount = 0;
            let jobDeadline = 'N/A';

            if (payment.related_job_type === 'negotiation' && payment.negotiation) {
                jobRequirements = payment.negotiation.requirements;
                jobStatus = payment.negotiation.status; // Correctly get status for negotiation jobs
                jobAmount = payment.negotiation.agreed_price_usd;
                jobDeadline = payment.negotiation.deadline_hours;
            } else if (payment.related_job_type === 'direct_upload' && payment.direct_upload_job) {
                jobRequirements = payment.direct_upload_job.client_instructions;
                jobStatus = payment.direct_upload_job.status; // Correctly get status for direct upload jobs
                jobAmount = payment.direct_upload_job.quote_amount;
                jobDeadline = payment.direct_upload_job.agreed_deadline_hours;
            }

            return {
                ...payment,
                jobRequirements: jobRequirements,
                job_status: jobStatus, // Ensure job_status is set here
                job_amount: jobAmount,
                job_deadline: jobDeadline
            };
        });


        const groupedUpcomingPayouts = {};
        let totalUpcomingPayouts = 0;
        let totalEarnings = 0;
        let monthlyEarnings = 0;

        paymentsWithJobDetails.forEach(payout => {
            // Log payout details before filtering for debugging
            console.log(`[getTranscriberPaymentHistory] Processing payout ${payout.id}. Related job type: ${payout.related_job_type}, Payout status: ${payout.payout_status}, Derived Job status: ${payout.job_status}`);

            // Only consider payments that are 'awaiting_completion' AND whose related job is 'completed' or 'client_completed'
            const isEligibleForUpcomingPayout =
                payout.payout_status === 'awaiting_completion' &&
                (payout.job_status === 'completed' || payout.job_status === 'client_completed');

            console.log(`[getTranscriberPaymentHistory] Payout ${payout.id} is eligible for upcoming payout: ${isEligibleForUpcomingPayout}`);

            if (isEligibleForUpcomingPayout) {
                const transactionDate = new Date(payout.transaction_date);
                const dayOfWeek = transactionDate.getDay();
                const daysUntilFriday = (5 - dayOfWeek + 7) % 7;

                const weekEndingDate = new Date(transactionDate);
                weekEndingDate.setDate(transactionDate.getDate() + daysUntilFriday);
                weekEndingDate.setHours(23, 59, 59, 999);
                const weekEndingString = weekEndingDate.toISOString().split('T')[0];

                if (!groupedUpcomingPayouts[weekEndingString]) {
                    groupedUpcomingPayouts[weekEndingString] = {
                        date: weekEndingString,
                        totalAmount: 0,
                        payouts: []
                    };
                }
                groupedUpcomingPayouts[weekEndingString].totalAmount += payout.transcriber_earning;
                groupedUpcomingPayouts[weekEndingString].payouts.push({
                    id: payout.id,
                    negotiation_id: payout.negotiation_id,
                    direct_upload_job_id: payout.direct_upload_job_id,
                    related_job_type: payout.related_job_type,
                    clientName: payout.client?.full_name || 'N/A',
                    jobRequirements: payout.jobRequirements ? payout.jobRequirements.substring(0, 50) + '...' : 'N/A',
                    amount: payout.transcriber_earning,
                    status: payout.payout_status,
                    job_status: payout.job_status, // Ensure job_status is passed to frontend
                    created_at: new Date(payout.transaction_date).toLocaleDateString()
                });
                totalUpcomingPayouts += payout.transcriber_earning;
            } else if (payout.payout_status === 'paid_out') {
                totalEarnings += payout.transcriber_earning;
                const date = new Date(payout.transaction_date);
                const currentMonth = new Date().getMonth();
                const currentYear = new Date().getFullYear();
                if (date.getMonth() === currentMonth && date.getFullYear() === currentYear) {
                    monthlyEarnings += payout.transcriber_earning;
                }
            }
        });

        const upcomingPayoutsArray = Object.values(groupedUpcomingPayouts).sort((a, b) => new Date(a.date) - new Date(b.date));

        res.status(200).json({
            message: `Upcoming payouts for transcriber ${transcriberId} retrieved successfully.`,
            payments: [], // Keep empty as 'All Past Transactions' table is removed
            upcomingPayouts: upcomingPayoutsArray,
            totalUpcomingPayouts: totalUpcomingPayouts,
            summary: {
                totalEarnings: totalEarnings,
                monthlyEarnings: monthlyEarnings,
            }
        });

    } catch (error) {
        console.error('Server error fetching transcriber payment history: ', error);
        res.status(500).json({ error: 'Server error fetching payment history.ᐟ' });
    }
};

const getClientPaymentHistory = async (req, res) => {
    const clientId = req.user.userId;

    try {
        const { data: payments, error } = await supabase
            .from('payments')
            .select(`
                id,
                negotiation_id,
                direct_upload_job_id,
                related_job_type,
                client_id,
                transcriber_id,
                amount,
                transcriber_earning,
                currency,
                paystack_reference,
                korapay_reference, // NEW: KoraPay reference
                paystack_status,
                korapay_status, // NEW: KoraPay status
                transaction_date,
                payout_status,
                currency_paid_by_client,
                exchange_rate_used,
                transcriber:users!transcriber_id(full_name, email),
                negotiation:negotiation_id(id, status, requirements, deadline_hours, agreed_price_usd)
            `)
            .eq('client_id', clientId)
            .order('transaction_date', { ascending: false });

        if (error) {
            console.error('Error fetching client payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        const paymentsWithJobDetails = await Promise.all((payments || []).map(async (payment) => {
            let jobDetails = {};
            if (payment.related_job_type === 'negotiation') {
                const { data: negotiation, error: negError } = await supabase
                    .from('negotiations')
                    .select('requirements, deadline_hours, agreed_price_usd')
                    .eq('id', payment.negotiation_id)
                    .single();
                jobDetails = { negotiation: negotiation || null };
            } else if (payment.related_job_type === 'direct_upload') {
                const { data: directJob, error: directJobError } = await supabase
                    .from('direct_upload_jobs')
                    .select('client_instructions, agreed_deadline_hours, quote_amount')
                    .eq('id', payment.direct_upload_job_id)
                    .single();
                jobDetails = { direct_upload_job: directJob || null };
            }
            return { ...payment, ...jobDetails };
        }));

        const totalPayments = (paymentsWithJobDetails || []).reduce((sum, p) => sum + p.amount, 0);
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();

        const monthlyPayments = (paymentsWithJobDetails || []).filter(p => {
            const date = new Date(p.transaction_date);
            return date.getMonth() === currentMonth && date.getFullYear() === currentYear;
        }).reduce((sum, p) => sum + p.amount, 0);

        res.status(200).json({
            message: 'Client payment history retrieved successfully.',
            payments: paymentsWithJobDetails,
            summary: {
                totalPayments: totalPayments,
                monthlyPayments: monthlyPayments,
            }
        });

    } catch (error) {
        console.error('Server error fetching client payment history: ', error);
        res.status(500).json({ error: 'Server error fetching client payment history.ᐟ' });
    }
};

const getAllPaymentHistoryForAdmin = async (req, res) => {
  try {
    const { data: payments, error } = await supabase
      .from('payments')
      .select(`
        id,
        negotiation_id,
        direct_upload_job_id,
        related_job_type,
        client_id,
        transcriber_id,
        amount,
        transcriber_earning,
        currency,
        paystack_reference,
        korapay_reference, // NEW: KoraPay reference
        paystack_status,
        korapay_status, // NEW: KoraPay status
        transaction_date,
        payout_status,
        currency_paid_by_client,
        exchange_rate_used,
        client:users!client_id(full_name, email),
        transcriber:users!transcriber_id(full_name, email)
      `)
      .order('transaction_date', { ascending: false });

    if (error) {
        console.error('Error fetching all payment history for admin:', error);
        return res.status(500).json({ error: error.message });
    }

    const paymentsWithJobDetails = await Promise.all((payments || []).map(async (payment) => {
        let jobDetails = {};
        if (payment.related_job_type === 'negotiation') {
            const { data: negotiation, error: negError } = await supabase
                .from('negotiations')
                .select('requirements, deadline_hours, agreed_price_usd')
                .eq('id', payment.negotiation_id)
                .single();
            jobDetails = { negotiation: negotiation || null };
        } else if (payment.related_job_type === 'direct_upload') {
            const { data: directJob, error: directJobError } = await supabase
                .from('direct_upload_jobs')
                .select('client_instructions, agreed_deadline_hours, quote_amount')
                .eq('id', payment.direct_upload_job_id)
                .single();
            jobDetails = { direct_upload_job: directJob || null };
        } else if (payment.related_job_type === 'training') {
            const { data: traineeUser, error: traineeError } = await supabase
                .from('users')
                .select('full_name, email')
                .eq('id', payment.client_id)
                .single();
            jobDetails = { trainee_info: traineeUser || null };
        }
        return { ...payment, ...jobDetails };
    }));

    return res.status(200).json(paymentsWithJobDetails);
  } catch (error) {
    console.error('Server error fetching all payment history for admin:', error);
    return res.status(500).json({ error: 'Failed to fetch all payment history for admin.ᐟ' });
  }
};

const getTranscriberUpcomingPayoutsForAdmin = async (req, res) => {
    const { transcriberId } = req.params;
    const adminId = req.user.userId;

    const { data: adminUser, error: adminError } = await supabase
        .from('users')
        .select('user_type')
        .eq('id', adminId)
        .single();

    if (adminError || adminUser?.user_type !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized: Only administrators can view transcriber payouts.ᐟ' });
    }

    try {
        const { data: payments, error } = await supabase
            .from('payments')
            .select(`
                id,
                negotiation_id,
                direct_upload_job_id,
                related_job_type,
                client_id,
                transcriber_id,
                amount,
                transcriber_earning,
                currency,
                paystack_reference,
                korapay_reference, // NEW: KoraPay reference
                paystack_status,
                korapay_status, // NEW: KoraPay status
                transaction_date,
                payout_status,
                currency_paid_by_client,
                exchange_rate_used,
                client:users!client_id(full_name, email)
            `)
            .eq('transcriber_id', transcriberId)
            .eq('payout_status', 'awaiting_completion')
            .order('transaction_date', { ascending: true });

        if (error) {
            console.error(`Error fetching upcoming payouts for transcriber ${transcriberId}:`, error);
            return res.status(500).json({ error: error.message });
        }

        const paymentsWithJobDetails = await Promise.all((payments || []).map(async (payment) => {
            let jobDetails = {};
            if (payment.related_job_type === 'negotiation') {
                const { data: negotiation, error: negError } = await supabase
                    .from('negotiations')
                    .select('requirements, deadline_hours, agreed_price_usd, created_at')
                    .eq('id', payment.negotiation_id)
                    .single();
                jobDetails = { negotiation: negotiation || null };
            } else if (payment.related_job_type === 'direct_upload') {
                const { data: directJob, error: directJobError } = await supabase
                    .from('direct_upload_jobs')
                    .select('client_instructions, agreed_deadline_hours, quote_amount, created_at')
                    .eq('id', payment.direct_upload_job_id)
                    .single();
                if (directJobError) {
                    console.error(`Error fetching direct upload job ${payment.direct_upload_job_id} for payment:`, directJobError);
                }
                jobDetails = { direct_upload_job: directJob || null };
            }
            return { ...payment, ...jobDetails };
        }));

        const groupedPayouts = {};
        let totalUpcomingPayouts = 0;

        paymentsWithJobDetails.forEach(payout => {
            const transactionDate = new Date(payout.transaction_date);
            const dayOfWeek = transactionDate.getDay();
            const daysUntilFriday = (5 - dayOfWeek + 7) % 7;

            const weekEndingDate = new Date(transactionDate);
            weekEndingDate.setDate(transactionDate.getDate() + daysUntilFriday);
            weekEndingDate.setHours(23, 59, 59, 999);
            const weekEndingString = weekEndingDate.toISOString().split('T')[0];

            if (!groupedPayouts[weekEndingString]) {
                groupedPayouts[weekEndingString] = {
                    date: weekEndingString,
                    totalAmount: 0,
                    payouts: []
                    };
                }
                groupedPayouts[weekEndingString].totalAmount += payout.transcriber_earning;
                groupedPayouts[weekEndingString].payouts.push({
                    id: payout.id,
                    negotiation_id: payout.negotiation_id,
                    direct_upload_job_id: payout.direct_upload_job_id,
                    related_job_type: payout.related_job_type,
                    clientName: payout.client?.full_name || 'N/A',
                    jobRequirements: payout.negotiation?.requirements || payout.direct_upload_job?.client_instructions || 'N/A',
                    amount: payout.transcriber_earning,
                    status: payout.payout_status,
                    created_at: new Date(payout.transaction_date).toLocaleDateString()
                });
                totalUpcomingPayouts += payout.transcriber_earning;
            });

        const upcomingPayoutsArray = Object.values(groupedPayouts).sort((a, b) => new Date(a.date) - new Date(b.date));

        res.status(200).json({
            message: `Upcoming payouts for transcriber ${transcriberId} retrieved successfully.`,
            upcomingPayouts: upcomingPayoutsArray,
            totalUpcomingPayouts: totalUpcomingPayouts
        });

    } catch (error) {
        console.error(`Server error fetching upcoming payouts for transcriber ${transcriberId}:`, error);
        res.status(500).json({ error: 'Server error fetching upcoming payouts.ᐟ' });
    }
};

const markPaymentAsPaidOut = async (req, res, io) => {
    const { paymentId } = req.params;
    const adminId = req.user.userId;

    const { data: adminUser, error: adminError } = await supabase
        .from('users')
        .select('user_type')
        .eq('id', adminId)
        .single();

    if (adminError || adminUser?.user_type !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized: Only administrators can mark payments as paid out.ᐟ' });
    }

    try {
        const { data: payment, error: fetchError } = await supabase
            .from('payments')
            .select('id, transcriber_id, transcriber_earning, related_job_type, negotiation_id, direct_upload_job_id, payout_status')
            .eq('id', paymentId)
            .single();

        if (fetchError || !payment) {
            return res.status(404).json({ error: 'Payment record not found.ᐟ' });
        }

        if (payment.payout_status !== 'awaiting_completion') {
            return res.status(400).json({ error: `Payment status is '${payment.payout_status}'. Only payments 'awaiting_completion' can be marked as paid out.` });
        }

        const { data: updatedPayment, error: updateError } = await supabase
            .from('payments')
            .update({ payout_status: 'paid_out', paid_out_date: new Date().toISOString(), updated_at: new Date().toISOString() }) // Added updated_at
            .eq('id', paymentId)
            .select()
            .single();

        if (updateError) {
            console.error(`Error updating payment ${paymentId} to 'paid_out':`, updateError);
            throw updateError;
        }

        if (io && payment.transcriber_id) {
            io.to(payment.transcriber_id).emit('payout_processed', {
                paymentId: updatedPayment.id,
                amount: updatedPayment.transcriber_earning,
                message: 'Your payment has been processed and disbursed!ᐟ',
                status: 'paid_out'
            });
        }
        
        const { data: transcriberUser, error: transcriberError } = await supabase
            .from('users')
            .select('full_name, email')
            .eq('id', payment.transcriber_id)
            .single();

        if (transcriberError) console.error(`Error fetching transcriber ${payment.transcriber_id} for payout email:`, transcriberError);

        if (transcriberUser) {
            await emailService.sendPayoutConfirmationEmail(transcriberUser, updatedPayment);
        }

        res.status(200).json({
            message: 'Payment marked as paid out successfully.ᐟ',
            payment: updatedPayment
        });

    } catch (error) {
        console.error(`Server error marking payment ${paymentId} as paid out:`, error);
        res.status(500).json({ error: 'Server error marking payment as paid out.ᐟ' });
    }
};


module.exports = {
    initializePayment,
    initializeTrainingPayment,
    verifyPayment,
    getTranscriberPaymentHistory,
    getClientPaymentHistory,
    getAllPaymentHistoryForAdmin,
    getTranscriberUpcomingPayoutsForAdmin,
    markPaymentAsPaidOut
};
