const axios = require('axios');
const supabase = require('..//database');
const { syncAvailabilityStatus } = require('..//controllers/transcriberController');
const emailService = require('..//emailService');
const { calculateTranscriberEarning, convertUsdToKes, EXCHANGE_RATE_USD_TO_KES } = require('..//utils/paymentUtils');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

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

    const { jobId, amount, clientEmail, jobType } = req.body; 
    const clientId = req.user.userId;

    console.log(`[initializePayment] Destructured parameters - jobId: ${jobId}, amount: ${amount}, clientEmail: ${clientEmail}, jobType: ${jobType}, clientId: ${clientId}`);

    if (!jobId || !amount || !clientEmail || !jobType) { 
        console.error('[initializePayment] Validation failed: Missing required parameters.');
        return res.status(400).json({ error: 'Job ID, amount, job type, and client email are required.' });
    }
    if (!['negotiation', 'direct_upload', 'training'].includes(jobType)) {
        console.error(`[initializePayment] Validation failed: Invalid job type provided: ${jobType}`);
        return res.status(400).json({ error: 'Invalid job type provided for payment initialization.' });
    }
    if (!PAYSTACK_SECRET_KEY) {
        console.error('[initializePayment] PAYSTACK_SECRET_KEY is not set.');
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

        if (jobType === 'negotiation') {
            const { data, error } = await supabase
                .from('negotiations')
                .select('id, client_id, transcriber_id, agreed_price_usd, status')
                .eq('id', jobId)
                .eq('client_id', clientId)
                .single();
            if (error || !data) {
                console.error(`[initializePayment] Error fetching negotiation ${jobId} for payment:`, error);
                return res.status(404).json({ error: 'Negotiation not found or not accessible.' });
            }
            jobDetails = data;
            transcriberId = data.transcriber_id;
            agreedPriceUsd = data.agreed_price_usd;
            jobStatus = data.status;
            if (jobStatus !== 'accepted_awaiting_payment') {
                console.error(`[initializePayment] Negotiation ${jobId} status is ${jobStatus}, not 'accepted_awaiting_payment'.`);
                return res.status(400).json({ error: `Payment can only be initiated for accepted negotiations (status: accepted_awaiting_payment). Current status: ${jobStatus}` });
            }
        } else if (jobType === 'direct_upload') {
            const { data, error } = await supabase
                .from('direct_upload_jobs')
                .select('id, client_id, transcriber_id, quote_amount, status')
                .eq('id', jobId)
                .eq('client_id', clientId)
                .single();
            if (error || !data) {
                console.error(`[initializePayment] Error fetching direct upload job ${jobId} for payment:`, error);
                return res.status(404).json({ error: 'Direct upload job not found or not accessible.' });
            }
            jobDetails = data;
            transcriberId = data.transcriber_id;
            agreedPriceUsd = data.quote_amount;
            jobStatus = data.status;
            if (jobStatus !== 'pending_review' && jobStatus !== 'transcriber_assigned') {
                console.error(`[initializePayment] Direct upload job ${jobId} status is ${jobStatus}, not 'pending_review' or 'transcriber_assigned'.`);
                return res.status(400).json({ error: `Payment can only be initiated for direct upload jobs awaiting review or with assigned transcriber. Current status: ${jobStatus}` });
            }
        } else if (jobType === 'training') {
            const { data: traineeUser, error } = await supabase
                .from('users')
                .select('id, email, transcriber_status')
                .eq('id', jobId)
                .eq('user_type', 'trainee')
                .single();
            
            if (error || !traineeUser) {
                console.error(`[initializePayment] Error fetching trainee ${jobId} for training payment:`, error);
                return res.status(404).json({ error: 'Trainee not found or not accessible for training payment.' });
            }
            if (traineeUser.transcriber_status === 'paid_training_fee') {
                return res.status(400).json({ error: 'Trainee has already paid for training.' });
            }
            jobDetails = traineeUser;
            transcriberId = traineeUser.id;
            agreedPriceUsd = 0.50;
            jobStatus = traineeUser.transcriber_status;
            
            if (Math.round(parsedAmountUsd * 100) !== Math.round(agreedPriceUsd * 100)) {
                console.error('[initializePayment] Training payment amount mismatch. Provided USD:', parsedAmountUsd, 'Expected USD:', agreedPriceUsd);
                return res.status(400).json({ error: `Training payment amount must be USD ${agreedPriceUsd}.` });
            }
        }
        else {
            console.error(`[initializePayment] Unsupported job type for payment initialization: ${jobType}`);
            return res.status(400).json({ error: 'Unsupported job type for payment initialization.' });
        }

        if (jobType !== 'training' && Math.round(parsedAmountUsd * 100) !== Math.round(agreedPriceUsd * 100)) {
            console.error('[initializePayment] Payment amount mismatch. Provided USD:', parsedAmountUsd, 'Agreed USD:', agreedPriceUsd);
            return res.status(400).json({ error: 'Payment amount does not match the agreed job price.' });
        }

        const amountKes = convertUsdToKes(parsedAmountUsd);
        const amountInCentsKes = Math.round(amountKes * 100);

        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: clientEmail,
                amount: amountInCentsKes,
                reference: `${jobId}-${Date.now()}`,
                callback_url: `${CLIENT_URL}/payment-callback?relatedJobId=${jobId}&jobType=${jobType}`,
                currency: 'KES',
                // Explicitly define payment channels to include Pesalink
                channels: ['mobile_money', 'card', 'bank_transfer', 'pesalink'],
                metadata: {
                    related_job_id: jobId,
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
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!paystackResponse.data.status) {
            console.error('[initializePayment] Paystack initialization failed:', paystackResponse.data.message);
            return res.status(500).json({ error: paystackResponse.data.message || 'Failed to initialize payment with Paystack.' });
        }

        res.status(200).json({
            message: 'Payment initialization successful',
            data: paystackResponse.data.data
        });

    } catch (error) {
        console.error('[initializePayment] Error initializing Paystack payment:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error during payment initialization.' });
    }
};

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

    const TRAINING_FEE_USD = 0.50; 
    if (Math.round(parsedAmountUsd * 100) !== Math.round(TRAINING_FEE_USD * 100)) {
        console.error('Training payment amount mismatch. Provided USD:', parsedAmountUsd, 'Expected USD:', TRAINING_FEE_USD);
        return res.status(400).json({ error: `Training payment amount must be USD ${agreedPriceUsd}.` });
    }

    try {
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
                // Explicitly define payment channels to include Pesalink
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


const verifyPayment = async (req, res, io) => {
    const { reference } = req.params;
    const { relatedJobId, jobType } = req.query;

    if (!reference || !relatedJobId || !jobType) {
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
            related_job_id: metadataRelatedJobId,
            related_job_type: metadataRelatedJobType,
            client_id: metadataClientId,
            transcriber_id: metadataTranscriberId,
            agreed_price_usd: metadataAgreedPrice,
            currency_paid: metadataCurrencyPaid,
            exchange_rate_usd_to_kes: metadataExchangeRate,
            amount_paid_kes: metadataAmountPaidKes
        } = transaction.metadata;

        if (metadataRelatedJobId !== relatedJobId || metadataRelatedJobType !== jobType) {
            console.error('Metadata job ID or type mismatch:', metadataRelatedJobId, relatedJobId, metadataRelatedJobType, jobType);
            return res.status(400).json({ error: 'Invalid transaction metadata (job ID or type mismatch).' });
        }

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

            const { error: updateTraineeStatusError } = await supabase
                .from('users')
                .update({ transcriber_status: 'paid_training_fee', updated_at: new Date().toISOString() })
                .eq('id', metadataClientId);

            if (updateTraineeStatusError) {
                console.error(`Error updating trainee ${metadataClientId} status after payment:`, updateTraineeStatusError);
                throw updateTraineeStatusError;
            }
            console.log(`Trainee ${metadataClientId} status updated to 'paid_training_fee' after successful payment.`);

            const actualAmountPaidUsd = parseFloat((transaction.amount / 100 / metadataExchangeRate).toFixed(2));
            const { error: paymentRecordError } = await supabase
                .from('payments')
                .insert([
                    {
                        related_job_id: null,
                        related_job_type: 'training',
                        client_id: metadataClientId,
                        transcriber_id: metadataClientId, 
                        amount: actualAmountPaidUsd,
                        currency: 'USD',
                        paystack_reference: transaction.reference,
                        paystack_status: transaction.status,
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


        let currentJob;
        let updateTable;
        let updateStatusColumn;

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
                .select('id, client_id, transcriber_id, quote_amount, status')
                .eq('id', relatedJobId)
                .single();
            if (error || !data) {
                console.error(`Error fetching direct upload job ${relatedJobId} during payment verification: `, error);
                return res.status(404).json({ error: 'Direct upload job not found for verification.' });
            }
            currentJob = data;
            updateTable = 'direct_upload_jobs';
            updateStatusColumn = 'status';
            if (currentJob.status === 'hired' || currentJob.status === 'in_progress') {
                 return res.status(200).json({ message: 'Payment already processed and direct upload job already active.' });
            }
        } else {
            return res.status(400).json({ error: 'Unsupported job type for payment verification.' });
        }

        const actualAmountPaidUsd = parseFloat((transaction.amount / 100 / metadataExchangeRate).toFixed(2));
        const transcriberPayAmount = calculateTranscriberEarning(actualAmountPaidUsd);

        const { data: paymentRecord, error: paymentError } = await supabase
            .from('payments')
            .insert([
                {
                    related_job_id: relatedJobId,
                    related_job_type: jobType,
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

        const { error: jobUpdateError } = await supabase
            .from(updateTable)
            .update({ [updateStatusColumn]: 'hired', updated_at: new Date().toISOString() })
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
            await emailService.sendPaymentConfirmationEmail(clientUser, transcriberUser, currentJob, paymentRecord);
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
                message: 'A client has paid for your accepted job. The job is now active!',
                newStatus: 'hired'
            });
            console.log(`Emitted 'payment_successful' to client ${metadataClientId} and 'job_hired' to transcriber ${metadataTranscriberId}`);
        }

        res.status(200).json({
            message: 'Payment verified successfully and job is now active.',
            transaction: transaction
        });

    } catch (error) {
        console.error('[initializePayment] Error verifying Paystack payment:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error during payment verification. ' + (error.message || '') });
    }
};

const getTranscriberPaymentHistory = async (req, res) => {
    const transcriberId = req.user.userId;

    try {
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
                negotiation:negotiations!related_job_id(status, requirements, deadline_hours, agreed_price_usd)
                // Removed direct_upload_job join from here to prevent schema cache error
            `)
            .eq('transcriber_id', transcriberId)
            // Filter to include only payments that are 'awaiting_completion' or 'paid_out'
            .or('payout_status.eq.awaiting_completion,payout_status.eq.paid_out')
            .order('transaction_date', { ascending: false });

        if (error) {
            console.error('Error fetching transcriber payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        const paymentsWithJobDetails = await Promise.all((payments || []).map(async (payment) => {
            let jobDetails = {};
            // The negotiation data is already joined by the select query
            if (payment.related_job_type === 'negotiation') {
                jobDetails = { negotiation: payment.negotiation || null };
            } else if (payment.related_job_type === 'direct_upload') {
                // NEW: Fetch direct_upload_job details separately due to schema cache error
                const { data: directJob, error: directJobError } = await supabase
                    .from('direct_upload_jobs')
                    .select('status, client_instructions, agreed_deadline_hours, quote_amount')
                    .eq('id', payment.related_job_id)
                    .single();
                if (directJobError) {
                    console.error(`Error fetching direct upload job ${payment.related_job_id} for payment:`, directJobError);
                }
                jobDetails = { direct_upload_job: directJob || null };
            }
            return { ...payment, ...jobDetails };
        }));

        // Group payments by week ending Friday for upcoming payouts
        const groupedUpcomingPayouts = {};
        let totalUpcomingPayouts = 0;
        let totalEarnings = 0; // Initialize total earnings for completed jobs
        let monthlyEarnings = 0; // Initialize monthly earnings for completed jobs

        paymentsWithJobDetails.forEach(payout => {
            if (payout.payout_status === 'awaiting_completion') {
                const transactionDate = new Date(payout.transaction_date);
                const dayOfWeek = transactionDate.getDay(); // 0 for Sunday, 1 for Monday, ..., 6 for Saturday
                const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
                
                const weekEndingDate = new Date(transactionDate);
                weekEndingDate.setDate(transactionDate.getDate() + daysUntilFriday);
                weekEndingDate.setHours(23, 59, 59, 999); // Set to end of Friday
                const weekEndingString = weekEndingDate.toISOString().split('T')[0]; // YYYY-MM-DD

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
                    related_job_id: payout.related_job_id,
                    related_job_type: payout.related_job_type,
                    clientName: payout.client?.full_name || 'N/A',
                    jobRequirements: payout.negotiation?.requirements || payout.direct_upload_job?.client_instructions || 'N/A',
                    amount: payout.transcriber_earning,
                    status: payout.payout_status, // This is the payout_status
                    job_status: payout.negotiation?.status || payout.direct_upload_job?.status || 'N/A', // NEW: Add the job's actual status
                    created_at: new Date(payout.transaction_date).toLocaleDateString()
                });
                totalUpcomingPayouts += payout.transcriber_earning;
            } else if (payout.payout_status === 'paid_out') { // Calculate total and monthly earnings from 'paid_out' payments
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
            message: 'Transcriber payment history retrieved successfully.',
            payments: [], // No longer returning 'All Past Transactions' in this endpoint
            upcomingPayouts: upcomingPayoutsArray,
            totalUpcomingPayouts: totalUpcomingPayouts,
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

const getClientPaymentHistory = async (req, res) => {
    const clientId = req.user.userId;

    try {
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
                    .select('client_instructions, agreed_deadline_hours, quote_amount')
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

const getAllPaymentHistoryForAdmin = async (req, res) => {
  try {
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
                .select('client_instructions, agreed_deadline_hours, quote_amount')
                .eq('id', payment.related_job_id)
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
    console.error('Server error fetching all payment history for admin: ', error);
    return res.status(500).json({ error: 'Failed to fetch all payment history for admin.' });
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
        return res.status(403).json({ error: 'Unauthorized: Only administrators can view transcriber payouts.' });
    }

    try {
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
                    .eq('id', payment.related_job_id)
                    .single();
                jobDetails = { negotiation: negotiation || null };
            } else if (payment.related_job_type === 'direct_upload') {
                const { data: directJob, error: directJobError } = await supabase
                    .from('direct_upload_jobs')
                    .select('client_instructions, agreed_deadline_hours, quote_amount, created_at')
                    .eq('id', payment.related_job_id)
                    .single();
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
                related_job_id: payout.related_job_id,
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
        res.status(500).json({ error: 'Server error fetching upcoming payouts.' });
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
        return res.status(403).json({ error: 'Unauthorized: Only administrators can mark payments as paid out.' });
    }

    try {
        const { data: payment, error: fetchError } = await supabase
            .from('payments')
            .select('*')
            .eq('id', paymentId)
            .single();

        if (fetchError || !payment) {
            return res.status(404).json({ error: 'Payment record not found.' });
        }

        if (payment.payout_status !== 'awaiting_completion') {
            return res.status(400).json({ error: `Payment status is '${payment.payout_status}'. Only payments 'awaiting_completion' can be marked as paid out.` });
        }

        const { data: updatedPayment, error: updateError } = await supabase
            .from('payments')
            .update({ payout_status: 'paid_out', paid_out_date: new Date().toISOString() })
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
                message: 'Your payment has been processed and disbursed!',
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
            message: 'Payment marked as paid out successfully.',
            payment: updatedPayment
        });

    } catch (error) {
        console.error(`Server error marking payment ${paymentId} as paid out:`, error);
        res.status(500).json({ error: 'Server error marking payment as paid out.' });
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
