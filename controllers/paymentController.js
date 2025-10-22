const axios = require('axios');
const supabase = require('../database');
const { syncAvailabilityStatus } = require('./transcriberController');
const emailService = require('../emailService');
const { calculateTranscriberEarning, convertUsdToKes, EXCHANGE_RATE_USD_TO_KES } = require('../utils/paymentUtils');

// Paystack Secret Key from environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000'; // Frontend URL for redirects

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


// Function to initialize a Paystack transaction
const initializePayment = async (req, res, io) => {
    const { relatedJobId, amount, email, jobType } = req.body; // FIX: relatedJobId and jobType (e.g., 'negotiation', 'direct_upload')
    const clientId = req.user.userId;

    // Basic validation for required fields
    if (!relatedJobId || !amount || !email || !jobType) { // FIX: Added jobType validation
        return res.status(400).json({ error: 'Job ID, amount, job type, and client email are required.' });
    }
    if (!['negotiation', 'direct_upload'].includes(jobType)) { // FIX: Validate jobType
        return res.status(400).json({ error: 'Invalid job type provided for payment initialization.' });
    }
    if (!PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not set.');
        return res.status(500).json({ error: 'Payment service not configured.' });
    }

    const parsedAmountUsd = parseFloat(amount);
    if (isNaN(parsedAmountUsd) || parsedAmountUsd <= 0) {
        return res.status(400).json({ error: 'Invalid payment amount.' });
    }

    try {
        let jobDetails;
        let transcriberId;
        let agreedPriceUsd;
        let jobStatus;

        // FIX: Dynamically fetch job details based on jobType
        if (jobType === 'negotiation') {
            const { data, error } = await supabase
                .from('negotiations')
                .select('id, client_id, transcriber_id, agreed_price_usd, status')
                .eq('id', relatedJobId)
                .eq('client_id', clientId)
                .single();
            if (error || !data) {
                console.error(`Error fetching negotiation ${relatedJobId} for payment:`, error);
                return res.status(404).json({ error: 'Negotiation not found or not accessible.' });
            }
            jobDetails = data;
            transcriberId = data.transcriber_id;
            agreedPriceUsd = data.agreed_price_usd;
            jobStatus = data.status;
            if (jobStatus !== 'accepted_awaiting_payment') {
                return res.status(400).json({ error: `Payment can only be initiated for accepted negotiations (status: accepted_awaiting_payment). Current status: ${jobStatus}` });
            }
        } else if (jobType === 'direct_upload') {
            const { data, error } = await supabase
                .from('direct_upload_jobs')
                .select('id, client_id, transcriber_id, quote_amount, status') // FIX: quote_amount
                .eq('id', relatedJobId)
                .eq('client_id', clientId)
                .single();
            if (error || !data) {
                console.error(`Error fetching direct upload job ${relatedJobId} for payment:`, error);
                return res.status(404).json({ error: 'Direct upload job not found or not accessible.' });
            }
            jobDetails = data;
            transcriberId = data.transcriber_id;
            agreedPriceUsd = data.quote_amount; // FIX: Use quote_amount
            jobStatus = data.status;
            if (jobStatus !== 'pending_review' && jobStatus !== 'transcriber_assigned') { // Assuming direct upload jobs are 'pending_review' or 'transcriber_assigned' before payment
                return res.status(400).json({ error: `Payment can only be initiated for direct upload jobs awaiting review or with assigned transcriber. Current status: ${jobStatus}` });
            }
        } else {
            return res.status(400).json({ error: 'Unsupported job type for payment initialization.' });
        }

        if (Math.round(parsedAmountUsd * 100) !== Math.round(agreedPriceUsd * 100)) {
            console.error('Payment amount mismatch. Provided USD:', parsedAmountUsd, 'Agreed USD:', agreedPriceUsd);
            return res.status(400).json({ error: 'Payment amount does not match the agreed job price.' });
        }

        const amountKes = convertUsdToKes(parsedAmountUsd);
        const amountInCentsKes = Math.round(amountKes * 100);

        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amountInCentsKes,
                reference: `${relatedJobId}-${Date.now()}`,
                callback_url: `${CLIENT_URL}/payment-callback?relatedJobId=${relatedJobId}&jobType=${jobType}`, // FIX: Pass relatedJobId and jobType
                currency: 'KES',
                metadata: {
                    related_job_id: relatedJobId, // FIX: Use related_job_id
                    related_job_type: jobType, // FIX: Pass jobType in metadata
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
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!paystackResponse.data.status) {
            console.error('Paystack initialization failed:', paystackResponse.data.message);
            return res.status(500).json({ error: paystackResponse.data.message || 'Failed to initialize payment with Paystack.' });
        }

        res.status(200).json({
            message: 'Payment initialization successful',
            data: paystackResponse.data.data
        });

    } catch (error) {
        console.error('Error initializing Paystack payment:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error during payment initialization.' });
    }
};

// NEW: Function to initialize a Paystack transaction for training access
const initializeTrainingPayment = async (req, res, io) => {
    const { amount, email } = req.body;
    const traineeId = req.user.userId;

    if (!amount || !email) {
        return res.status(400).json({ error: 'Amount and trainee email are required for training payment.' });
    }
    if (!PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not set for training payment.');
        return res.status(500).json({ error: 'Payment service not configured.' });
    }

    const parsedAmountUsd = parseFloat(amount);
    if (isNaN(parsedAmountUsd) || parsedAmountUsd <= 0) {
        return res.status(400).json({ error: 'Invalid training payment amount.' });
    }

    // Expected training fee
    const TRAINING_FEE_USD = 0.50; 
    if (Math.round(parsedAmountUsd * 100) !== Math.round(TRAINING_FEE_USD * 100)) {
        console.error('Training payment amount mismatch. Provided USD:', parsedAmountUsd, 'Expected USD:', TRAINING_FEE_USD);
        return res.status(400).json({ error: `Training payment amount must be USD ${TRAINING_FEE_USD}.` });
    }

    try {
        const amountKes = convertUsdToKes(parsedAmountUsd);
        const amountInCentsKes = Math.round(amountKes * 100);

        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amountInCentsKes,
                reference: `TRAINING-${traineeId}-${Date.now()}`, // Unique reference for training
                callback_url: `${CLIENT_URL}/payment-callback?relatedJobId=${traineeId}&jobType=training`, // Pass traineeId and jobType 'training'
                currency: 'KES',
                metadata: {
                    related_job_id: traineeId, // Store traineeId here
                    related_job_type: 'training', // Indicate it's a training payment
                    client_id: traineeId, // Trainee is effectively the 'client' for this payment
                    agreed_price_usd: TRAINING_FEE_USD,
                    currency_paid: 'KES',
                    exchange_rate_usd_to_kes: EXCHANGE_RATE_USD_TO_KES,
                    amount_paid_kes: amountKes
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!paystackResponse.data.status) {
            console.error('Paystack training initialization failed:', paystackResponse.data.message);
            return res.status(500).json({ error: paystackResponse.data.message || 'Failed to initialize training payment with Paystack.' });
        }

        res.status(200).json({
            message: 'Training payment initialization successful',
            data: paystackResponse.data.data
        });

    } catch (error) {
        console.error('Error initializing Paystack training payment:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error during training payment initialization.' });
    }
};


// Function to verify a Paystack transaction after the callback
const verifyPayment = async (req, res, io) => {
    const { reference } = req.params;
    const { relatedJobId, jobType } = req.query; // FIX: relatedJobId and jobType from query

    if (!reference || !relatedJobId || !jobType) { // FIX: Added jobType validation
        return res.status(400).json({ error: 'Payment reference, job ID, and job type are required for verification.' });
    }
    if (!PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not set.');
        return res.status(500).json({ error: 'Payment service not configured.' });
    }

    try {
        const paystackResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                }
            }
        );

        if (!paystackResponse.data.status || paystackResponse.data.data.status !== 'success') {
            console.error('Paystack verification failed:', paystackResponse.data.data.gateway_response);
            return res.status(400).json({ error: paystackResponse.data.data.gateway_response || 'Payment verification failed.' });
        }

        const transaction = paystackResponse.data.data;
        const {
            related_job_id: metadataRelatedJobId, // FIX: Use related_job_id from metadata
            related_job_type: metadataRelatedJobType, // FIX: Use related_job_type from metadata
            client_id: metadataClientId,
            transcriber_id: metadataTranscriberId,
            agreed_price_usd: metadataAgreedPrice,
            currency_paid: metadataCurrencyPaid,
            exchange_rate_usd_to_kes: metadataExchangeRate,
            amount_paid_kes: metadataAmountPaidKes
        } = transaction.metadata;

        if (metadataRelatedJobId !== relatedJobId || metadataRelatedJobType !== jobType) { // FIX: Validate against relatedJobId and jobType
            console.error('Metadata job ID or type mismatch:', metadataRelatedJobId, relatedJobId, metadataRelatedJobType, jobType);
            return res.status(400).json({ error: 'Invalid transaction metadata (job ID or type mismatch).' });
        }

        // Handle specific logic for training payment verification
        if (jobType === 'training') {
            const TRAINING_FEE_USD = 0.50;
            if (Math.round(metadataAgreedPrice * 100) !== Math.round(TRAINING_FEE_USD * 100)) {
                console.error('Training metadata amount mismatch. Agreed USD:', metadataAgreedPrice, 'Expected USD:', TRAINING_FEE_USD);
                return res.status(400).json({ error: 'Invalid transaction metadata (training amount mismatch).' });
            }

            const expectedAmountKes = convertUsdToKes(TRAINING_FEE_USD);
            const expectedAmountInCentsKes = Math.round(expectedAmountKes * 100);

            if (transaction.amount !== expectedAmountInCentsKes) {
                console.error('Training metadata amount mismatch. Transaction amount (KES cents):', transaction.amount, 'Expected KES cents:', expectedAmountInCentsKes);
                return res.status(400).json({ error: 'Invalid transaction metadata (training amount mismatch). Paystack charged a different KES amount than expected.' });
            }

            // Update trainee's transcriber_status to 'paid_training_fee'
            const { error: updateTraineeStatusError } = await supabase
                .from('users')
                .update({ transcriber_status: 'paid_training_fee', updated_at: new Date().toISOString() })
                .eq('id', metadataClientId); // metadataClientId is the traineeId here

            if (updateTraineeStatusError) {
                console.error(`Error updating trainee ${metadataClientId} status after payment:`, updateTraineeStatusError);
                throw updateTraineeStatusError;
            }
            console.log(`Trainee ${metadataClientId} status updated to 'paid_training_fee' after successful payment.`);

            // Record the payment details in the 'payments' table (for training)
            const actualAmountPaidUsd = parseFloat((transaction.amount / 100 / metadataExchangeRate).toFixed(2));
            const { error: paymentRecordError } = await supabase
                .from('payments')
                .insert([
                    {
                        related_job_id: metadataRelatedJobId,
                        related_job_type: 'training',
                        client_id: metadataClientId,
                        amount: actualAmountPaidUsd,
                        currency: 'USD',
                        paystack_reference: transaction.reference,
                        paystack_status: transaction.status,
                        transaction_date: new Date(transaction.paid_at).toISOString(),
                        payout_status: 'completed', // Training payment is immediately completed
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

            // Emit a real-time event to the trainee
            if (io) {
                io.to(metadataClientId).emit('training_payment_successful', {
                    traineeId: metadataClientId,
                    message: 'Your training payment was successful! You now have access to the training dashboard.',
                    newStatus: 'paid_training_fee'
                });
                console.log(`Emitted 'training_payment_successful' to trainee ${metadataClientId}`);
            }

            return res.status(200).json({
                message: 'Training payment verified successfully and access granted.',
                transaction: transaction
            });
        }


        // Continue with existing job payment verification logic for 'negotiation' and 'direct_upload'
        let currentJob;
        let updateTable;
        let updateStatusColumn;

        // FIX: Fetch current job details and determine update table/column based on jobType
        if (jobType === 'negotiation') {
            const { data, error } = await supabase
                .from('negotiations')
                .select('id, client_id, transcriber_id, agreed_price_usd, status')
                .eq('id', relatedJobId)
                .single();
            if (error || !data) {
                console.error(`Error fetching negotiation ${relatedJobId} during payment verification: `, error);
                return res.status(404).json({ error: 'Negotiation not found for verification.' });
            }
            currentJob = data;
            updateTable = 'negotiations';
            updateStatusColumn = 'status';
            if (currentJob.status === 'hired') {
                return res.status(200).json({ message: 'Payment already processed and job already hired.' });
            }
        } else if (jobType === 'direct_upload') {
            const { data, error } = await supabase
                .from('direct_upload_jobs')
                .select('id, client_id, transcriber_id, quote_amount, status') // FIX: quote_amount
                .eq('id', relatedJobId)
                .single();
            if (error || !data) {
                console.error(`Error fetching direct upload job ${relatedJobId} during payment verification: `, error);
                return res.status(404).json({ error: 'Direct upload job not found for verification.' });
            }
            currentJob = data;
            updateTable = 'direct_upload_jobs';
            updateStatusColumn = 'status'; // Or 'payment_status' if you have a separate column
            if (currentJob.status === 'hired' || currentJob.status === 'in_progress') { // Assuming 'hired' or 'in_progress' implies paid for direct uploads
                 return res.status(200).json({ message: 'Payment already processed and direct upload job already active.' });
            }
        } else {
            return res.status(400).json({ error: 'Unsupported job type for payment verification.' });
        }

        const actualAmountPaidUsd = parseFloat((transaction.amount / 100 / metadataExchangeRate).toFixed(2));
        const transcriberPayAmount = calculateTranscriberEarning(actualAmountPaidUsd);

        // Record the payment details in the 'payments' table
        const { data: paymentRecord, error: paymentError } = await supabase
            .from('payments')
            .insert([
                {
                    related_job_id: relatedJobId, // FIX: Use related_job_id
                    related_job_type: jobType, // NEW: Store jobType in payments table
                    client_id: metadataClientId,
                    transcriber_id: metadataTranscriberId,
                    amount: actualAmountPaidUsd,
                    transcriber_earning: transcriberPayAmount,
                    currency: 'USD',
                    paystack_reference: transaction.reference,
                    paystack_status: transaction.status,
                    transaction_date: new Date(transaction.paid_at).toISOString(),
                    payout_status: 'awaiting_completion',
                    currency_paid_by_client: metadataCurrencyPaid,
                    exchange_rate_used: metadataExchangeRate
                }
            ])
            .select()
            .single();

        if (paymentError) {
            console.error('Error recording payment in Supabase: ', paymentError);
            throw paymentError;
        }

        // FIX: Update the correct job table's status
        const { error: jobUpdateError } = await supabase
            .from(updateTable)
            .update({ [updateStatusColumn]: 'hired', updated_at: new Date().toISOString() }) // Assuming 'hired' is the status after payment for both types
            .eq('id', relatedJobId);

        if (jobUpdateError) {
            console.error(`Error updating job status to hired for ${jobType} ${relatedJobId}: `, jobUpdateError);
            throw jobUpdateError;
        }

        await syncAvailabilityStatus(metadataTranscriberId, false, relatedJobId);

        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', metadataClientId).single();
        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', metadataTranscriberId).single();

        if (clientError) console.error('Error fetching client for payment email: ', clientError);
        if (transcriberError) console.error('Error fetching transcriber for payment email: ', transcriberError);

        if (clientUser && transcriberUser) {
            await emailService.sendPaymentConfirmationEmail(clientUser, transcriberUser, currentJob, paymentRecord); // FIX: Pass currentJob
        }

        if (io) {
            io.to(metadataClientId).emit('payment_successful', {
                relatedJobId: relatedJobId,
                jobType: jobType,
                message: 'Your payment was successful and the job is now active!',
                newStatus: 'hired'
            });
            io.to(metadataTranscriberId).emit('job_hired', {
                relatedJobId: relatedJobId,
                jobType: jobType,
                message: 'A client has paid for your accepted job. The job is now active!', // FIX: Generic message
                newStatus: 'hired'
            });
            console.log(`Emitted 'payment_successful' to client ${metadataClientId} and 'job_hired' to transcriber ${metadataTranscriberId}`);
        }

        res.status(200).json({
            message: 'Payment verified successfully and job is now active.',
            transaction: transaction
        });

    } catch (error) {
        console.error('Error verifying Paystack payment:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error during payment verification. ' + (error.message || '') });
    }
};

// Function to get a transcriber's payment history
const getTranscriberPaymentHistory = async (req, res) => {
    const transcriberId = req.user.userId;

    try {
        // FIX: Select related_job_id and related_job_type from payments
        const { data: payments, error } = await supabase
            .from('payments')
            .select(`
                id,
                related_job_id,
                related_job_type,
                client_id,
                transcriber_id,
                amount,
                transcriber_earning,
                currency,
                paystack_reference,
                paystack_status,
                transaction_date,
                payout_status,
                currency_paid_by_client,
                exchange_rate_used,
                client:users!client_id(full_name, email)
            `)
            .eq('transcriber_id', transcriberId)
            .order('transaction_date', { ascending: false });

        if (error) {
            console.error('Error fetching transcriber payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        // FIX: Dynamically fetch job details for each payment
        const paymentsWithJobDetails = await Promise.all((payments || []).map(async (payment) => {
            let jobDetails = {};
            if (payment.related_job_type === 'negotiation') {
                const { data: negotiation, error: negError } = await supabase
                    .from('negotiations')
                    .select('requirements, deadline_hours, agreed_price_usd')
                    .eq('id', payment.related_job_id)
                    .single();
                jobDetails = { negotiation: negotiation || null };
            } else if (payment.related_job_type === 'direct_upload') {
                const { data: directJob, error: directJobError } = await supabase
                    .from('direct_upload_jobs')
                    .select('client_instructions, agreed_deadline_hours, quote_amount') // FIX: quote_amount
                    .eq('id', payment.related_job_id)
                    .single();
                jobDetails = { direct_upload_job: directJob || null };
            }
            return { ...payment, ...jobDetails };
        }));

        const totalEarnings = (paymentsWithJobDetails || []).reduce((sum, p) => sum + p.transcriber_earning, 0);
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();

        const monthlyEarnings = (paymentsWithJobDetails || []).filter(p => {
            const date = new Date(p.transaction_date);
            return date.getMonth() === currentMonth && date.getFullYear() === currentYear;
        }).reduce((sum, p) => sum + p.transcriber_earning, 0);

        res.status(200).json({
            message: 'Transcriber payment history retrieved successfully.',
            payments: paymentsWithJobDetails,
            summary: {
                totalEarnings: totalEarnings,
                monthlyEarnings: monthlyEarnings,
            }
        });

    } catch (error) {
        console.error('Server error fetching transcriber payment history: ', error);
        res.status(500).json({ error: 'Server error fetching payment history.' });
    }
};

// NEW: Function to get a client's payment history
const getClientPaymentHistory = async (req, res) => {
    const clientId = req.user.userId;

    try {
        // FIX: Select related_job_id and related_job_type from payments
        const { data: payments, error } = await supabase
            .from('payments')
            .select(`
                id,
                related_job_id,
                related_job_type,
                client_id,
                transcriber_id,
                amount,
                transcriber_earning,
                currency,
                paystack_reference,
                paystack_status,
                transaction_date,
                payout_status,
                currency_paid_by_client,
                exchange_rate_used,
                transcriber:users!transcriber_id(full_name, email)
            `)
            .eq('client_id', clientId)
            .order('transaction_date', { ascending: false });

        if (error) {
            console.error('Error fetching client payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        // FIX: Dynamically fetch job details for each payment
        const paymentsWithJobDetails = await Promise.all((payments || []).map(async (payment) => {
            let jobDetails = {};
            if (payment.related_job_type === 'negotiation') {
                const { data: negotiation, error: negError } = await supabase
                    .from('negotiations')
                    .select('requirements, deadline_hours, agreed_price_usd')
                    .eq('id', payment.related_job_id)
                    .single();
                jobDetails = { negotiation: negotiation || null };
            } else if (payment.related_job_type === 'direct_upload') {
                const { data: directJob, error: directJobError } = await supabase
                    .from('direct_upload_jobs')
                    .select('client_instructions, agreed_deadline_hours, quote_amount') // FIX: quote_amount
                    .eq('id', payment.related_job_id)
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
        res.status(500).json({ error: 'Server error fetching client payment history.' });
    }
};

/**
 * @route GET /api/admin/payments
 * @desc Admin can view all payment transactions
 * @access Private (Admin only)
 */
const getAllPaymentHistoryForAdmin = async (req, res) => {
  try {
    // FIX: Select related_job_id and related_job_type from payments
    const { data: payments, error } = await supabase
      .from('payments')
      .select(`
        id,
        related_job_id,
        related_job_type,
        client_id,
        transcriber_id,
        amount,
        transcriber_earning,
        currency,
        paystack_reference,
        paystack_status,
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

    // FIX: Dynamically fetch job details for each payment
    const paymentsWithJobDetails = await Promise.all((payments || []).map(async (payment) => {
        let jobDetails = {};
        if (payment.related_job_type === 'negotiation') {
            const { data: negotiation, error: negError } = await supabase
                .from('negotiations')
                .select('requirements, deadline_hours, agreed_price_usd')
                .eq('id', payment.related_job_id)
                .single();
            jobDetails = { negotiation: negotiation || null };
        } else if (payment.related_job_type === 'direct_upload') {
            const { data: directJob, error: directJobError } = await supabase
                .from('direct_upload_jobs')
                .select('client_instructions, agreed_deadline_hours, quote_amount') // FIX: quote_amount
                .eq('id', payment.related_job_id)
                .single();
            jobDetails = { direct_upload_job: directJob || null };
        } else if (payment.related_job_type === 'training') { // NEW: Handle training payments
            // For training payments, we might not have 'job details' in the same way,
            // but we can fetch the trainee's name if needed.
            const { data: traineeUser, error: traineeError } = await supabase
                .from('users')
                .select('full_name, email')
                .eq('id', payment.client_id) // client_id in payments table is traineeId for training
                .single();
            jobDetails = { trainee_info: traineeUser || null };
        }
        return { ...payment, ...jobDetails };
    }));

    return res.status(200).json(paymentsWithJobDetails); // Return the array of all payments with job details
  } catch (error) {
    console.error('Server error fetching all payment history for admin: ', error);
    return res.status(500).json({ error: 'Failed to fetch all payment history for admin.' });
  }
};


module.exports = {
    initializePayment,
    initializeTrainingPayment, // NEW: Export initializeTrainingPayment
    verifyPayment,
    getTranscriberPaymentHistory,
    getClientPaymentHistory,
    getAllPaymentHistoryForAdmin
};
