const axios = require('axios');
const supabase = require('../database'); // CORRECTED: Changed from '../supabaseClient' to '../database'
const { syncAvailabilityStatus } = require('./transcriberController'); // Import syncAvailabilityStatus
const emailService = require('../emailService'); // For sending payment confirmation emails
const { calculateTranscriberEarning } = require('../utils/paymentUtils'); // Now imports from the new file

// Paystack Secret Key from environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000'; // Frontend URL for redirects

// --- Helper Functions ---

// Function to initialize a Paystack transaction
const initializePayment = async (req, res, io) => {
    const { negotiationId, amount, email } = req.body; // email is the client's email
    const clientId = req.user.userId;

    // Basic validation for required fields
    if (!negotiationId || !amount || !email) {
        return res.status(400).json({ error: 'Negotiation ID, amount, and client email are required.' });
    }
    // Check if Paystack secret key is configured
    if (!PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not set.');
        return res.status(500).json({ error: 'Payment service not configured.' });
    }

    try {
        // 1. Verify negotiation status and client ownership
        const { data: negotiation, error: negError } = await supabase
            .from('negotiations')
            .select('id, client_id, transcriber_id, agreed_price_kes, status')
            .eq('id', negotiationId)
            .eq('client_id', clientId) // Ensure the logged-in user is the client
            .single();

        if (negError || !negotiation) {
            console.error('Error fetching negotiation for payment:', negError);
            return res.status(404).json({ error: 'Negotiation not found or not accessible.' });
        }

        // Ensure the negotiation is in a state where payment can be initiated (e.g., 'accepted')
        if (negotiation.status !== 'accepted') {
            return res.status(400).json({ error: 'Payment can only be initiated for accepted negotiations.' });
        }

        // Validate that the provided amount matches the agreed price in the negotiation
        if (amount !== negotiation.agreed_price_kes) {
            return res.status(400).json({ error: 'Payment amount does not match the agreed negotiation price.' });
        }

        // 2. Initialize transaction with Paystack API
        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amount * 100, // Paystack expects amount in kobo (or smallest currency unit)
                reference: `${negotiationId}-${Date.now()}`, // Generate a unique reference
                callback_url: `${CLIENT_URL}/payment-callback?negotiationId=${negotiationId}`, // Redirect URL after payment
                metadata: { // Include custom data for later retrieval
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

        // Check Paystack response for success
        if (!paystackResponse.data.status) {
            console.error('Paystack initialization failed:', paystackResponse.data.message);
            return res.status(500).json({ error: paystackResponse.data.message || 'Failed to initialize payment with Paystack.' });
        }

        // Respond with Paystack's data, including the authorization URL
        res.status(200).json({
            message: 'Payment initialization successful',
            data: paystackResponse.data.data // Contains authorization_url
        });

    } catch (error) {
        console.error('Error initializing Paystack payment:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error during payment initialization.' });
    }
};

// Function to verify a Paystack transaction after the callback
const verifyPayment = async (req, res, io) => {
    const { reference } = req.params; // Paystack reference from the redirect URL
    const { negotiationId } = req.query; // Our negotiation ID passed in the callback_url

    // Validate required parameters
    if (!reference || !negotiationId) {
        return res.status(400).json({ error: 'Payment reference and negotiation ID are required for verification.' });
    }
    if (!PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not set.');
        return res.status(500).json({ error: 'Payment service not configured.' });
    }

    try {
        // 1. Verify the transaction status with Paystack API
        const paystackResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                }
            }
        );

        // Check Paystack's response and transaction status
        if (!paystackResponse.data.status || paystackResponse.data.data.status !== 'success') {
            console.error('Paystack verification failed:', paystackResponse.data.data.gateway_response);
            return res.status(400).json({ error: paystackResponse.data.data.gateway_response || 'Payment verification failed.' });
        }

        const transaction = paystackResponse.data.data;
        // Extract metadata and other relevant details
        const {
            negotiation_id: metadataNegotiationId,
            client_id: metadataClientId,
            transcriber_id: metadataTranscriberId,
            agreed_price_kes: metadataAgreedPrice
        } = transaction.metadata;

        // Perform sanity checks on metadata
        if (metadataNegotiationId !== negotiationId) {
            console.error('Metadata negotiation ID mismatch:', metadataNegotiationId, negotiationId);
            return res.status(400).json({ error: 'Invalid transaction metadata (negotiation ID mismatch).' });
        }
        // Ensure the amount matches (convert Paystack amount back to original unit)
        if (transaction.amount / 100 !== metadataAgreedPrice) {
            console.error('Metadata amount mismatch:', transaction.amount / 100, metadataAgreedPrice);
            return res.status(400).json({ error: 'Invalid transaction metadata (amount mismatch).' });
        }

        // 2. Update Supabase records:
        //    a. Record the payment details in the 'payments' table.
        //    b. Update the negotiation status to 'hired'.
        //    c. Update the transcriber's availability status.

        // Fetch the current negotiation details to check status and prevent double updates
        const { data: negotiation, error: negFetchError } = await supabase
            .from('negotiations')
            .select('id, client_id, transcriber_id, agreed_price_kes, status')
            .eq('id', negotiationId)
            .single();

        if (negFetchError || !negotiation) {
            console.error('Error fetching negotiation during payment verification:', negFetchError);
            return res.status(404).json({ error: 'Negotiation not found for verification.' });
        }

        // Prevent processing if the job is already hired (e.g., due to duplicate callbacks)
        if (negotiation.status === 'hired') {
            return res.status(200).json({ message: 'Payment already processed and job already hired.' });
        }

        // Calculate the transcriber's earning (e.g., 80% of the agreed price)
        const transcriberPayAmount = calculateTranscriberEarning(transaction.amount / 100);

        // Record the payment details in the 'payments' table
        const { data: paymentRecord, error: paymentError } = await supabase
            .from('payments')
            .insert([
                {
                    negotiation_id: negotiationId,
                    client_id: metadataClientId,
                    transcriber_id: metadataTranscriberId,
                    amount: transaction.amount / 100, // Full amount paid by client
                    transcriber_earning: transcriberPayAmount, // Transcriber's share
                    currency: transaction.currency,
                    paystack_reference: transaction.reference,
                    paystack_status: transaction.status,
                    transaction_date: new Date(transaction.paid_at).toISOString() // Use the timestamp from Paystack
                }
            ])
            .select()
            .single();

        if (paymentError) {
            console.error('Error recording payment in Supabase:', paymentError);
            throw paymentError;
        }

        // Update the negotiation status to 'hired'
        const { error: negUpdateError } = await supabase
            .from('negotiations')
            .update({ status: 'hired', updated_at: new Date().toISOString() })
            .eq('id', negotiationId);

        if (negUpdateError) {
            console.error('Error updating negotiation status to hired:', negUpdateError);
            throw negUpdateError;
        }

        // Update the transcriber's availability: set to busy (unavailable) and assign the job ID
        await syncAvailabilityStatus(metadataTranscriberId, false, negotiationId); // false for is_available (busy)

        // Fetch client and transcriber details for email notifications
        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', metadataClientId).single();
        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', metadataTranscriberId).single();

        if (clientError) console.error('Error fetching client for payment email:', clientError);
        if (transcriberError) console.error('Error fetching transcriber for payment email:', transcriberError);

        // Send confirmation emails if details were fetched successfully
        if (clientUser && transcriberUser) {
            await emailService.sendPaymentConfirmationEmail(clientUser, transcriberUser, negotiation, paymentRecord);
        }

        // Emit real-time updates to client (payment success) and transcriber (job hired)
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
            transaction: transaction // Return details of the verified transaction
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
        // Fetch payment records for the transcriber, joining with negotiation and client details
        const { data: payments, error } = await supabase
            .from('payments')
            .select(`
                *,
                negotiation:negotiations(requirements, deadline_hours),
                client:users!client_id(full_name, email)
            `)
            .eq('transcriber_id', transcriberId)
            .order('transaction_date', { ascending: false }); // Order by date, newest first

        if (error) {
            console.error('Error fetching transcriber payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        // Calculate earnings summaries (total and monthly) based on transcriber_earning
        const totalEarnings = payments.reduce((sum, p) => sum + p.transcriber_earning, 0);
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();

        const monthlyEarnings = payments.filter(p => {
            const date = new Date(p.transaction_date);
            return date.getMonth() === currentMonth && date.getFullYear() === currentYear;
        }).reduce((sum, p) => sum + p.transcriber_earning, 0);

        // Respond with payment history and earnings summary
        res.status(200).json({
            message: 'Transcriber payment history retrieved successfully.',
            payments: payments,
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
        // Fetch payment records for the client, joining with negotiation and transcriber details
        const { data: payments, error } = await supabase
            .from('payments')
            .select(`
                *,
                negotiation:negotiations(requirements, deadline_hours),
                transcriber:users!transcriber_id(full_name, email)
            `)
            .eq('client_id', clientId)
            .order('transaction_date', { ascending: false }); // Order by date, newest first

        if (error) {
            console.error('Error fetching client payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        // Calculate payment summaries (total and monthly) based on the full amount paid
        const totalPayments = payments.reduce((sum, p) => sum + p.amount, 0);
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();

        const monthlyPayments = payments.filter(p => {
            const date = new Date(p.transaction_date);
            return date.getMonth() === currentMonth && date.getFullYear() === currentYear;
        }).reduce((sum, p) => sum + p.amount, 0);

        // Respond with payment history and summary
        res.status(200).json({
            message: 'Client payment history retrieved successfully.',
            payments: payments,
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
    // Fetch all payment records, joining with client, transcriber, and negotiation details
    const { data, error } = await supabase
      .from('payments')
      .select(`
        *,
        client:users!client_id(full_name, email),
        transcriber:users!transcriber_id(full_name, email),
        negotiation:negotiations(requirements, deadline_hours)
      `)
      .order('transaction_date', { ascending: false }); // Order by transaction date

    if (error) {
        console.error('Error fetching all payment history for admin:', error);
        return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data); // Return the array of all payments
  } catch (error) {
    console.error('Server error fetching all payment history for admin: ', error);
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
