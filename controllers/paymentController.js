const axios = require('axios');
const supabase = require('..//database');
const { syncAvailabilityStatus } = require('./transcriberController');
const emailService = require('..//emailService');
const { calculateTranscriberEarning, convertUsdToKes, EXCHANGE_RATE_USD_TO_KES } = require('..//utils/paymentUtils'); // Now imports from the new file and new utilities

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
    const { negotiationId, amount, email } = req.body; // amount is now expected in USD (dollars)
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

    // Ensure amount is a valid positive number
    const parsedAmountUsd = parseFloat(amount); // Keep this as USD amount from frontend
    if (isNaN(parsedAmountUsd) || parsedAmountUsd <= 0) {
        return res.status(400).json({ error: 'Invalid payment amount.' });
    }

    try {
        // 1. Verify negotiation status and client ownership
        const { data: negotiation, error: negError } = await supabase
            .from('negotiations')
            .select('id, client_id, transcriber_id, agreed_price_usd, status')
            .eq('id', negotiationId)
            .eq('client_id', clientId) // Ensure the logged-in user is the client
            .single();

        if (negError || !negotiation) {
            console.error('Error fetching negotiation for payment:', negError);
            return res.status(404).json({ error: 'Negotiation not found or not accessible.' });
        }

        // Ensure the negotiation is in a state where payment can be initiated (e.g., 'accepted_awaiting_payment')
        if (negotiation.status !== 'accepted_awaiting_payment') {
            return res.status(400).json({ error: `Payment can only be initiated for accepted negotiations (status: accepted_awaiting_payment). Current status: ${negotiation.status}` });
        }

        // Validate that the provided amount matches the agreed price in the negotiation (in USD, comparing cents)
        if (Math.round(parsedAmountUsd * 100) !== Math.round(negotiation.agreed_price_usd * 100)) { // Compare USD cents
            console.error('Payment amount mismatch. Provided USD:', parsedAmountUsd, 'Agreed USD:', negotiation.agreed_price_usd);
            return res.status(400).json({ error: 'Payment amount does not match the agreed negotiation price.' });
        }

        // --- NEW: Currency Conversion for Paystack ---
        const amountKes = convertUsdToKes(parsedAmountUsd); // Convert USD to KES
        const amountInCentsKes = Math.round(amountKes * 100); // Paystack expects amount in cents for KES

        // 2. Initialize transaction with Paystack API
        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amountInCentsKes, // Send KES amount in cents to Paystack
                reference: `${negotiationId}-${Date.now()}`, // Generate a unique reference
                callback_url: `${CLIENT_URL}/payment-callback?negotiationId=${negotiationId}`, // Redirect URL after payment
                currency: 'KES', // Specify currency as KES for Paystack
                metadata: { // Include custom data for later retrieval
                    negotiation_id: negotiationId,
                    client_id: clientId,
                    transcriber_id: negotiation.transcriber_id,
                    agreed_price_usd: negotiation.agreed_price_usd, // Store agreed price in original USD
                    currency_paid: 'KES', // Store currency paid in metadata
                    exchange_rate_usd_to_kes: EXCHANGE_RATE_USD_TO_KES, // Store exchange rate used
                    amount_paid_kes: amountKes // Store KES amount paid
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
            agreed_price_usd: metadataAgreedPrice, // This is the original agreed price in USD
            currency_paid: metadataCurrencyPaid, // This should be 'KES'
            exchange_rate_usd_to_kes: metadataExchangeRate, // Exchange rate used during initialization
            amount_paid_kes: metadataAmountPaidKes // KES amount paid during initialization
        } = transaction.metadata;

        // Perform sanity checks on metadata
        if (metadataNegotiationId !== negotiationId) {
            console.error('Metadata negotiation ID mismatch:', metadataNegotiationId, negotiationId);
            return res.status(400).json({ error: 'Invalid transaction metadata (negotiation ID mismatch).' });
        }

        // --- NEW: Validate amount with KES conversion ---
        // transaction.amount is the actual amount charged by Paystack in KES cents.
        // metadataAgreedPrice is the original agreed price in USD dollars.
        // We need to convert metadataAgreedPrice to KES cents for comparison.
        const expectedAmountKes = convertUsdToKes(metadataAgreedPrice);
        const expectedAmountInCentsKes = Math.round(expectedAmountKes * 100);

        if (transaction.amount !== expectedAmountInCentsKes) {
            console.error('Metadata amount mismatch. Transaction amount (KES cents):', transaction.amount, 'Expected KES cents:', expectedAmountInCentsKes);
            return res.status(400).json({ error: 'Invalid transaction metadata (amount mismatch). Paystack charged a different KES amount than expected.' });
        }
        // --- END NEW: Validate amount with KES conversion ---

        // 2. Update Supabase records:
        //    a. Record the payment details in the 'payments' table.
        //    b. Update the negotiation status to 'hired'.
        //    c. Update the transcriber's availability status.
        //    d. REMOVED: Create a record in 'transcriber_payouts' table here. This will now happen on job completion.

        // Fetch the current negotiation details to check status and prevent double updates
        const { data: negotiation, error: negFetchError } = await supabase
            .from('negotiations')
            .select('id, client_id, transcriber_id, agreed_price_usd, status')
            .eq('id', negotiationId)
            .single();

        if (negFetchError || !negotiation) {
            console.error('Error fetching negotiation during payment verification: ', negFetchError);
            return res.status(404).json({ error: 'Negotiation not found for verification.' });
        }

        // Prevent processing if the job is already hired (e.g., due to duplicate callbacks)
        if (negotiation.status === 'hired') {
            return res.status(200).json({ message: 'Payment already processed and job already hired.' });
        }

        // --- NEW: Determine the USD equivalent of the actual amount paid in KES ---
        const actualAmountPaidUsd = parseFloat((transaction.amount / 100 / metadataExchangeRate).toFixed(2)); // Convert KES cents to KES dollars, then to USD
        const transcriberPayAmount = calculateTranscriberEarning(actualAmountPaidUsd); // Calculate transcriber earning in USD

        // Record the payment details in the 'payments' table
        const { data: paymentRecord, error: paymentError } = await supabase
            .from('payments')
            .insert([
                {
                    negotiation_id: negotiationId,
                    client_id: metadataClientId,
                    transcriber_id: metadataTranscriberId,
                    amount: actualAmountPaidUsd, // Store the actual USD equivalent of the payment
                    transcriber_earning: transcriberPayAmount, // Transcriber's share in USD
                    currency: 'USD', // Standardize to USD for internal records
                    paystack_reference: transaction.reference,
                    paystack_status: transaction.status,
                    transaction_date: new Date(transaction.paid_at).toISOString(), // Use the timestamp from Paystack
                    // UPDATED: Payout status to 'awaiting_completion'
                    payout_status: 'awaiting_completion', 
                    // REMOVED: payout_week_end_date here, as it will be set on completion
                    currency_paid_by_client: metadataCurrencyPaid, // NEW: Store the currency the client actually paid in
                    exchange_rate_used: metadataExchangeRate // NEW: Store the exchange rate used
                }
            ])
            .select()
            .single();

        if (paymentError) {
            console.error('Error recording payment in Supabase: ', paymentError);
            throw paymentError;
        }

        // --- REMOVED: Insertion into transcriber_payouts table. This will happen on job completion. ---
        // const { data: payoutRecord, error: payoutError } = await supabase
        //     .from('transcriber_payouts')
        //     .insert([
        //         {
        //             transcriber_id: metadataTranscriberId,
        //             payment_id: paymentRecord.id,
        //             negotiation_id: negotiationId,
        //             amount: transcriberPayAmount,
        //             currency: 'USD',
        //             status: 'pending',
        //             due_date: getNextFriday(),
        //         }
        //     ])
        //     .select()
        //     .single();

        // if (payoutError) {
        //     console.error('Error recording transcriber payout in Supabase: ', payoutError);
        //     throw payoutError; 
        // }
        // console.log(`Recorded payout for transcriber ${metadataTranscriberId}:`, payoutRecord);


        // Update the negotiation status to 'hired'
        const { error: negUpdateError } = await supabase
            .from('negotiations')
            .update({ status: 'hired', updated_at: new Date().toISOString() })
            .eq('id', negotiationId);

        if (negUpdateError) {
            console.error('Error updating negotiation status to hired: ', negUpdateError);
            throw negUpdateError;
        }

        // Update the transcriber's availability: set to busy (unavailable) and assign the job ID
        await syncAvailabilityStatus(metadataTranscriberId, false, negotiationId); // false for is_available (busy)

        // Fetch client and transcriber details for email notifications
        const { data: clientUser, error: clientError } = await supabase.from('users').select('full_name, email').eq('id', metadataClientId).single();
        const { data: transcriberUser, error: transcriberError } = await supabase.from('users').select('full_name, email').eq('id', metadataTranscriberId).single();

        if (clientError) console.error('Error fetching client for payment email: ', clientError);
        if (transcriberError) console.error('Error fetching transcriber for payment email: ', transcriberError);

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
        console.error('Error verifying Paystack payment: ', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error during payment verification. ' + (error.message || '') });
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
                negotiation:negotiations(requirements, deadline_hours, agreed_price_usd),
                client:users!client_id(full_name, email)
            `)
            .eq('transcriber_id', transcriberId)
            .order('transaction_date', { ascending: false }); // Order by date, newest first

        if (error) {
            console.error('Error fetching transcriber payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        // Calculate earnings summaries (total and monthly) based on transcriber_earning
        const totalEarnings = (payments || []).reduce((sum, p) => sum + p.transcriber_earning, 0);
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();

        const monthlyEarnings = (payments || []).filter(p => {
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
                negotiation:negotiations(requirements, deadline_hours, agreed_price_usd),
                transcriber:users!transcriber_id(full_name, email)
            `)
            .eq('client_id', clientId)
            .order('transaction_date', { ascending: false }); // Order by date, newest first

        if (error) {
            console.error('Error fetching client payment history:', error);
            return res.status(500).json({ error: error.message });
        }

        // Calculate payment summaries (total and monthly) based on the full amount paid
        const totalPayments = (payments || []).reduce((sum, p) => sum + p.amount, 0);
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();

        const monthlyPayments = (payments || []).filter(p => {
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
        negotiation:negotiations(requirements, deadline_hours, agreed_price_usd)
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
