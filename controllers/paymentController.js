// backend/controllers/paymentController.js - UPDATED with getClientPaymentHistory and 80% Transcriber Pay

const axios = require('axios');
const supabase = require('../supabaseClient'); // Changed from '../database' to '../supabaseClient' based on previous context
const { syncAvailabilityStatus } = require('./transcriberController'); // Import syncAvailabilityStatus
const emailService = require('../emailService'); // For sending payment confirmation emails

// Paystack Secret Key from environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000'; // Frontend URL for redirects

// --- Helper Functions ---

// Function to initialize a Paystack transaction
const initializePayment = async (req, res, io) => {
    const { negotiationId, amount, email } = req.body; // email is the client's email
    const clientId = req.user.userId;

    if (!negotiationId || !amount || !email) {
        return res.status(400).json({ error: 'Negotiation ID, amount, and client email are required.' });
    }
    if (!PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not set.');
        return res.status(500).json({ error: 'Payment service not configured.' });
    }

    try {
        // 1. Verify negotiation status and ownership
        const { data: negotiation, error: negError } = await supabase
            .from('negotiations')
            .select('id, client_id, transcriber_id, agreed_price_kes, status')
            .eq('id', negotiationId)
            .eq('client_id', clientId)
            .single();

        if (negError || !negotiation) {
            console.error('Error fetching negotiation for payment:', negError);
            return res.status(404).json({ error: 'Negotiation not found or not accessible.' });
        }

        if (negotiation.status !== 'accepted') {
            return res.status(400).json({ error: 'Payment can only be initiated for accepted negotiations.' });
        }

        // Ensure the amount matches the agreed price (important for security)
        if (amount !== negotiation.agreed_price_kes) {
            return res.status(400).json({ error: 'Payment amount does not match agreed negotiation price.' });
        }

        // 2. Initialize transaction with Paystack
        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amount * 100, // Amount in kobo (or cents for other currencies)
                reference: `${negotiationId}-${Date.now()}`, // Unique reference
                callback_url: `${CLIENT_URL}/payment-callback?negotiationId=${negotiationId}`, // Redirect back to frontend
                metadata: {
                    negotiation_id: negotiationId,
                    client_id: clientId,
                    transcriber_id: negotiation.transcriber_id,
                    agreed_price_kes: negotiation.agreed_price_kes
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
            data: paystackResponse.data.data // Contains authorization_url
        });

    } catch (error) {
        console.error('Error initializing Paystack payment:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error during payment initialization.' });
    }
};

// Function to verify a Paystack transaction after callback
const verifyPayment = async (req, res, io) => {
    const { reference } = req.params; // Paystack reference from the redirect URL
    const { negotiationId } = req.query; // Our negotiation ID passed in callback_url

    if (!reference || !negotiationId) {
        return res.status(400).json({ error: 'Payment reference and negotiation ID are required for verification.' });
    }
    if (!PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not set.');
        return res.status(500).json({ error: 'Payment service not configured.' });
    }

    try {
        // 1. Verify transaction with Paystack
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
            negotiation_id: metadataNegotiationId,
            client_id: metadataClientId,
            transcriber_id: metadataTranscriberId,
            agreed_price_kes: metadataAgreedPrice
        } = transaction.metadata;

        // Basic sanity checks (optional, but good practice)
        if (metadataNegotiationId !== negotiationId) {
            console.error('Metadata negotiation ID mismatch:', metadataNegotiationId, negotiationId);
            return res.status(400).json({ error: 'Invalid transaction metadata (negotiation ID mismatch).' });
        }
        if (transaction.amount / 100 !== metadataAgreedPrice) {
            console.error('Metadata amount mismatch:', transaction.amount / 100, metadataAgreedPrice);
            return res.status(400).json({ error: 'Invalid transaction metadata (amount mismatch).' });
        }

        // 2. Update Supabase:
        //    a. Record the payment
        //    b. Update negotiation status to 'hired'
        //    c. Update transcriber's availability (set to busy/not available)

        const { data: negotiation, error: negFetchError } = await supabase
            .from('negotiations')
            .select('id, client_id, transcriber_id, agreed_price_kes, status')
            .eq('id', negotiationId)
            .single();

        if (negFetchError || !negotiation) {
            console.error('Error fetching negotiation during payment verification:', negFetchError);
            return res.status(404).json({ error: 'Negotiation not found for verification.' });
        }

        // Prevent double payment/double status update
        if (negotiation.status === 'hired') {
            return res.status(200).json({ message: 'Payment already processed and job already hired.' });
        }

        // Calculate transcriber's pay (80% of client's payment)
        const transcriberPayAmount = parseFloat((transaction.amount / 100 * 0.8).toFixed(2)); // 80%

        // Record payment
        const { data: paymentRecord, error: paymentError } = await supabase
            .from('payments')
            .insert({
                negotiation_id: negotiationId,
                client_id: metadataClientId,
                transcriber_id: metadataTranscriberId,
                amount: transaction.amount / 100, // Full amount paid by client
                transcriber_earning: transcriberPayAmount, // NEW: Transcriber's 80% share
                currency: transaction.currency,
                paystack_reference: transaction.reference,
                paystack_status: transaction.status,
                transaction_date: new Date(transaction.paid_at).toISOString()
            })
            .select()
            .single();

        if (paymentError) {
            console.error('Error recording payment in Supabase:', paymentError);
            throw paymentError;
        }

        // Update negotiation status to 'hired'
        const { error: negUpdateError } = await supabase
            .from('negotiations')
            .update({ status: 'hired', updated_at: new Date().toISOString() })
            .eq('id', negotiationId);

        if (negUpdateError) {
            console.error('Error updating negotiation status to hired:', negUpdateError);
            throw negUpdateError;
        }

        // Update transcriber's availability (set to busy with this job)
        await syncAvailabilityStatus(metadataTranscriberId, false, negotiationId); // false for is_available (busy)

        // Fetch client and transcriber details for email
        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', metadataClientId).single();
        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', metadataTranscriberId).single();

        if (clientError) console.error('Error fetching client for payment email:', clientError);
        if (transcriberError) console.error('Error fetching transcriber for payment email:', transcriberError);

        if (clientUser && transcriberUser) {
            await emailService.sendPaymentConfirmationEmail(clientUser, transcriberUser, negotiation, paymentRecord);
        }

        // Emit real-time update to both client and transcriber
        if (io) {
            io.to(metadataClientId).emit('payment_successful', {
                negotiationId: negotiationId,
                message: 'Your payment was successful and the job is now active!',
                newStatus: 'hired'
            });
            io.to(metadataTranscriberId).emit('job_hired', {
                negotiationId: negotiationId,
                message: 'A client has paid for your accepted negotiation. The job is now active!',
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
        res.status(500).json({ error: 'Server error during payment verification.' });
    }
};

// Function to get a transcriber's payment history
const getTranscriberPaymentHistory = async (req, res) => {
    const transcriberId = req.user.userId;

    try {
        const { data: payments, error } = await supabase
            .from('payments')
            .select(`
                *,
                negotiation:negotiations(requirements, deadline_hours),
                client:users!client_id(full_name, email)
            `)
            .eq('transcriber_id', transcriberId)
            .order('transaction_date', { ascending: false });

        if (error) {
            console.error('Error fetching transcriber payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        // Calculate totals based on transcriber_earning
        const totalEarnings = payments.reduce((sum, p) => sum + p.transcriber_earning, 0); // Use transcriber_earning
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();

        const monthlyEarnings = payments.filter(p => {
            const date = new Date(p.transaction_date);
            return date.getMonth() === currentMonth && date.getFullYear() === currentYear;
        }).reduce((sum, p) => sum + p.transcriber_earning, 0); // Use transcriber_earning

        res.status(200).json({
            message: 'Transcriber payment history retrieved successfully.',
            payments: payments,
            summary: {
                totalEarnings: totalEarnings,
                monthlyEarnings: monthlyEarnings,
            }
        });

    } catch (error) {
        console.error('Server error fetching transcriber payment history:', error);
        res.status(500).json({ error: 'Server error fetching payment history.' });
    }
};

// NEW: Function to get a client's payment history
const getClientPaymentHistory = async (req, res) => {
    const clientId = req.user.userId;

    try {
        const { data: payments, error } = await supabase
            .from('payments')
            .select(`
                *,
                negotiation:negotiations(requirements, deadline_hours),
                transcriber:users!transcriber_id(full_name, email)
            `)
            .eq('client_id', clientId)
            .order('transaction_date', { ascending: false });

        if (error) {
            console.error('Error fetching client payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        // Calculate totals based on full amount paid by client
        const totalPayments = payments.reduce((sum, p) => sum + p.amount, 0);
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();

        const monthlyPayments = payments.filter(p => {
            const date = new Date(p.transaction_date);
            return date.getMonth() === currentMonth && date.getFullYear() === currentYear;
        }).reduce((sum, p) => sum + p.amount, 0);

        res.status(200).json({
            message: 'Client payment history retrieved successfully.',
            payments: payments,
            summary: {
                totalPayments: totalPayments,
                monthlyPayments: monthlyPayments,
            }
        });

    } catch (error) {
        console.error('Server error fetching client payment history:', error);
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
    const { data, error } = await supabase
      .from('payments')
      .select(`
        *,
        client:users!client_id(full_name, email),
        transcriber:users!transcriber_id(full_name, email),
        negotiation:negotiations(requirements, deadline_hours)
      `)
      .order('transaction_date', { ascending: false });

    if (error) {
        console.error('Error fetching all payment history for admin:', error);
        return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('Server error fetching all payment history for admin:', error);
    return res.status(500).json({ error: 'Failed to fetch all payment history for admin.' });
  }
};


module.exports = {
    initializePayment,
    verifyPayment,
    getTranscriberPaymentHistory,
    getClientPaymentHistory,
    getAllPaymentHistoryForAdmin // Export the new function
};
