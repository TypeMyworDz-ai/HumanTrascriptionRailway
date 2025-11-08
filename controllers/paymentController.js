const axios = require('axios');
const supabase = require('../database');
const { syncAvailabilityStatus } = require('../controllers/transcriberController'); // Keep for potential use in general payment history context if needed
const emailService = require('../emailService');
const { calculateTranscriberEarning, convertUsdToKes, EXCHANGE_RATE_USD_TO_KES } = require('../utils/paymentUtils');
const http = require('http');
const https = require('https');

// Keep these constants as they might be used by other controllers after refactoring,
// or for general payment history related processing if needed.
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY;
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY;
const KORAPAY_BASE_URL = process.env.KORAPAY_BASE_URL || 'https://api-sandbox.korapay.com/v1';
const KORAPAY_WEBHOOK_URL = process.env.KORAPAY_WEBHOOK_URL || 'http://localhost:5000/api/payment/korapay-webhook';

const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

const getNextFriday = () => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
    const nextFriday = new Date(today);
    nextFriday.setDate(today.getDate() + daysUntilFriday);
    nextFriday.setHours(23, 59, 59, 999);
    return nextFriday.toISOString();
};

// REMOVED: initializePayment function is moved to specific controllers (negotiationController, directUploadController, trainingController)
// REMOVED: initializeTrainingPayment function is moved to trainingController.js
// REMOVED: verifyPayment function is moved to specific controllers (negotiationController, directUploadController)
// REMOVED: verifyKorapayTrainingPayment function is moved to trainingController.js


const getTranscriberPaymentHistory = async (req, res) => {
    const transcriberId = req.user.userId;

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
                korapay_reference,
                paystack_status,
                korapay_status,
                transaction_date,
                payout_status,
                currency_paid_by_client,
                exchange_rate_used,
                client:users!client_id(full_name, email),
                negotiation:negotiation_id(
                    id, 
                    status, 
                    requirements, 
                    deadline_hours, 
                    agreed_price_usd,
                    completed_at, // UPDATED: Include completed_at
                    transcriber_response, // UPDATED: Include transcriber_response (your comment)
                    client_feedback_comment, // UPDATED: Include client_feedback_comment
                    client_feedback_rating // UPDATED: Include client_feedback_rating
                ),
                direct_upload_job:direct_upload_jobs!direct_upload_job_id(
                    id, 
                    status, 
                    client_instructions, 
                    agreed_deadline_hours, 
                    quote_amount,
                    completed_at, // UPDATED: Include completed_at
                    client_completed_at, // UPDATED: Include client_completed_at
                    transcriber_comment, // UPDATED: Include transcriber_comment (your comment)
                    client_feedback_comment, // UPDATED: Include client_feedback_comment
                    client_feedback_rating // UPDATED: Include client_feedback_rating
                )
            `)
            .eq('transcriber_id', transcriberId)
            // UPDATED: Filter for 'pending', 'awaiting_completion', and 'paid_out' to cover all relevant statuses
            .or('payout_status.eq.pending,payout_status.eq.awaiting_completion,payout_status.eq.paid_out') 
            .order('transaction_date', { ascending: false });

        if (error) {
            console.error('Error fetching transcriber payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        const paymentsWithJobDetails = (payments || []).map(payment => {
            let jobRequirements = 'N/A';
            let jobStatus = 'N/A';
            let jobAmount = 0;
            let jobDeadline = 'N/A';
            let completedOn = 'N/A';
            let transcriberComment = 'N/A';
            let clientFeedbackComment = 'N/A';
            let clientFeedbackRating = 0;


            if (payment.related_job_type === 'negotiation' && payment.negotiation) {
                jobRequirements = payment.negotiation.requirements;
                jobStatus = payment.negotiation.status;
                jobAmount = payment.negotiation.agreed_price_usd;
                jobDeadline = payment.negotiation.deadline_hours;
                completedOn = payment.negotiation.completed_at;
                transcriberComment = payment.negotiation.transcriber_response;
                clientFeedbackComment = payment.negotiation.client_feedback_comment;
                clientFeedbackRating = payment.negotiation.client_feedback_rating;
            } else if (payment.related_job_type === 'direct_upload' && payment.direct_upload_job) {
                jobRequirements = payment.direct_upload_job.client_instructions;
                jobStatus = payment.direct_upload_job.status;
                jobAmount = payment.direct_upload_job.quote_amount;
                jobDeadline = payment.direct_upload_job.agreed_deadline_hours;
                completedOn = payment.direct_upload_job.completed_at || payment.direct_upload_job.client_completed_at;
                transcriberComment = payment.direct_upload_job.transcriber_comment;
                clientFeedbackComment = payment.direct_upload_job.client_feedback_comment;
                clientFeedbackRating = payment.direct_upload_job.client_feedback_rating;
            } else if (payment.related_job_type === 'training') {
                jobRequirements = 'Training Fee';
                jobStatus = 'paid_training_fee';
                jobAmount = payment.amount;
                jobDeadline = 'N/A';
                completedOn = payment.transaction_date; // Use transaction date for training completion
            }

            return {
                ...payment,
                jobRequirements: jobRequirements,
                job_status: jobStatus,
                job_amount: jobAmount,
                job_deadline: jobDeadline,
                completed_on: completedOn,
                transcriber_comment: transcriberComment,
                client_feedback_comment: clientFeedbackComment,
                client_feedback_rating: clientFeedbackRating
            };
        });


        const groupedUpcomingPayouts = {};
        let totalUpcomingPayouts = 0;
        let totalEarnings = 0;
        let monthlyEarnings = 0;

        paymentsWithJobDetails.forEach(payout => {
            console.log(`[getTranscriberPaymentHistory] Processing payout ${payout.id}. Related job type: ${payout.related_job_type}, Payout status: ${payout.payout_status}, Derived Job status: ${payout.job_status}`);

            // UPDATED: Include 'pending' status for upcoming payouts as well
            const isEligibleForUpcomingPayout =
                (payout.payout_status === 'pending' || payout.payout_status === 'awaiting_completion') &&
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
                    job_status: payout.job_status,
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
            payments: [], // This will be the detailed history if needed later
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
                korapay_reference,
                paystack_status,
                korapay_status,
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
            } else if (payment.related_job_type === 'training') {
                // For training, provide generic details
                jobDetails = { training_info: { requirements: 'Training Fee Payment', agreed_price_usd: payment.amount } };
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
        korapay_reference,
        paystack_status,
        korapay_status,
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
            jobDetails = { trainee_info: traineeUser || null, training_fee: payment.amount };
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
                korapay_reference,
                paystack_status,
                korapay_status,
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
            } else if (payment.related_job_type === 'training') {
                jobDetails = { training_info: { requirements: 'Training Fee Payment', agreed_price_usd: payment.amount, created_at: payment.transaction_date } };
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
                    jobRequirements: payout.negotiation?.requirements || payout.direct_upload_job?.client_instructions || payout.training_info?.requirements || 'N/A',
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

        if (payment.payout_status !== 'pending') { // UPDATED: Changed from 'awaiting_completion' to 'pending'
            return res.status(400).json({ error: `Payment status is '${payment.payout_status}'. Only payments 'pending' can be marked as paid out.` });
        }

        const { data: updatedPayment, error: updateError } = await supabase
            .from('payments')
            .update({ payout_status: 'paid_out', paid_out_date: new Date().toISOString(), updated_at: new Date().toISOString() })
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
    // initializePayment is moved to specific controllers (negotiationController, directUploadController, trainingController)
    // verifyPayment is moved to specific controllers (negotiationController, directUploadController)
    getTranscriberPaymentHistory,
    getClientPaymentHistory,
    getAllPaymentHistoryForAdmin,
    getTranscriberUpcomingPayoutsForAdmin,
    markPaymentAsPaidOut
};
