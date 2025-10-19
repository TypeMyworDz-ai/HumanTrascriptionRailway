const supabase = require('../database');
const emailService = require('../emailService'); // Ensure this path is correct

// --- Admin Statistics ---

// Get count of pending transcriber test submissions
const getPendingTranscriberTestsCount = async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('test_submissions')
            .select('*', { count: 'exact', head: true }) // Use head: true for count only
            .eq('status', 'pending'); // Filter for pending submissions

        if (error) throw error;
        res.json({ count });
    } catch (error) {
        console.error('Error fetching pending transcriber tests count:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get count of active jobs (negotiations with status 'accepted' or 'hired')
const getActiveJobsCount = async (req, res) => {
    try {
        // UPDATED: Include 'accepted_awaiting_payment' in active jobs count
        const { count, error } = await supabase
            .from('negotiations')
            .select('*', { count: 'exact', head: true })
            .in('status', ['accepted_awaiting_payment', 'hired']); // Count jobs that are active or awaiting payment

        if (error) throw error;
        res.json({ count });
    } catch (error) {
        console.error('Error fetching active jobs count:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get count of open disputes
const getOpenDisputesCount = async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('disputes')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'open'); // Filter for open disputes

        if (error) throw error;
        res.json({ count });
    } catch (error) {
            console.error('Error fetching open disputes count:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get total count of users in the system
const getTotalUsersCount = async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true }); // Count all users

        if (error) throw error;
        res.json({ count });
    } catch (error) {
        console.error('Error fetching total users count:', error); // SYNTAX FIX: Corrected console.error
        res.status(500).json({ error: error.message });
    }
};

// --- Admin Transcriber Test Management ---

// Get all transcriber test submissions with related user info
const getAllTranscriberTestSubmissions = async (req, res) => {
    try {
        const { data: submissions, error } = await supabase
            .from('test_submissions')
            .select(`
                id,
                user_id,
                grammar_score,
                transcription_text,
                status,
                created_at,
                rejection_reason,
                users (
                    full_name,
                    email
                )
            `)
            .order('created_at', { ascending: false }); // Order by creation date, newest first

        if (error) throw error;
        res.json({ submissions });
    } catch (error) {
        console.error('Error fetching all transcriber test submissions:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get a specific transcriber test submission by its ID
const getTranscriberTestSubmissionById = async (req, res) => {
    try {
        const { submissionId } = req.params;
        const { data: submission, error } = await supabase
            .from('test_submissions')
            .select(`
                id,
                user_id,
                grammar_score,
                transcription_text,
                status,
                created_at,
                rejection_reason,
                users (
                    full_name,
                    email
                )
            `)
            .eq('id', submissionId) // Filter by the submission ID
            .single();

        if (error) throw error;
        // Handle case where submission is not found
        if (!submission) {
            return res.status(404).json({ error: 'Test submission not found.' });
        }
        res.json({ submission });
    } catch (error) {
        console.error('Error fetching transcriber test submission by ID:', error);
        res.status(500).json({ error: error.message });
    }
};

// Approve a transcriber test submission
const approveTranscriberTest = async (req, res) => {
    try {
        const { submissionId } = req.params;
        const { transcriberId } = req.body; // Get transcriber ID from request body

        // Update the test submission status to 'approved'
        const { error: submissionUpdateError } = await supabase
            .from('test_submissions')
            .update({ status: 'approved', admin_notes: 'Approved by admin', updated_at: new Date().toISOString() })
            .eq('id', submissionId);

        if (submissionUpdateError) throw submissionUpdateError;

        // Update the transcriber's status in the 'transcribers' table to 'active_transcriber'
        const { error: transcriberProfileError } = await supabase
            .from('transcribers')
            .update({ status: 'active_transcriber', updated_at: new Date().toISOString() })
            .eq('id', transcriberId);

        if (transcriberProfileError) throw transcriberProfileError;

        // Also update the status in the 'users' table for consistency
        const { error: userStatusError } = await supabase
            .from('users')
            .update({ status: 'active_transcriber', updated_at: new Date().toISOString() })
            .eq('id', transcriberId);

        if (userStatusError) console.error('Error updating user status after test approval:', userStatusError);

        // Fetch user details to send an approval email
        const { data: userDetails, error: userDetailsError } = await supabase
            .from('users')
            .select('full_name, email')
            .eq('id', transcriberId)
            .single();

        if (userDetailsError) console.error('Error fetching user details for approval email:', userDetailsError);

        // Send approval email if user details were fetched
        if (userDetails) {
            await emailService.sendTranscriberTestResultEmail(userDetails, 'approved');
        }

        res.json({ message: 'Transcriber test approved successfully.' });
    } catch (error) {
        console.error('Error approving transcriber test:', error);
        res.status(500).json({ error: error.message });
    }
};

// Reject a transcriber test submission
const rejectTranscriberTest = async (req, res) => {
    try {
        const { submissionId } = req.params;
        const { transcriberId, reason } = req.body; // Get transcriber ID and rejection reason

        // Update the test submission status to 'rejected' and store the reason
        const { error: submissionUpdateError } = await supabase
            .from('test_submissions')
            .update({ status: 'rejected', rejection_reason: reason, admin_notes: 'Rejected by admin', updated_at: new Date().toISOString() })
            .eq('id', submissionId);

        if (submissionUpdateError) throw submissionUpdateError;

        // Update the transcriber's status to 'rejected' in both 'transcribers' and 'users' tables
        const { error: transcriberProfileError } = await supabase
            .from('transcribers')
            .update({ status: 'rejected', updated_at: new Date().toISOString() })
            .eq('id', transcriberId);

        if (transcriberProfileError) throw transcriberProfileError;

        const { error: userStatusError } = await supabase
            .from('users')
            .update({ status: 'rejected', updated_at: new Date().toISOString() })
            .eq('id', transcriberId);

        if (userStatusError) console.error('Error updating user status after test rejection:', userStatusError);

        // Fetch user details to send a rejection email
        const { data: userDetails, error: userDetailsError } = await supabase
            .from('users')
            .select('full_name, email')
            .eq('id', transcriberId)
            .single();

        if (userDetailsError) console.error('Error fetching user details for rejection email:', userDetailsError);

        // Send rejection email if user details were fetched
        if (userDetails) {
            await emailService.sendTranscriberTestResultEmail(userDetails, 'rejected', reason); // Pass the rejection reason
        }

        res.json({ message: 'Transcriber test rejected successfully.' });
    } catch (error) {
        console.error('Error rejecting transcriber test:', error);
        res.status(500).json({ error: error.message });
    }
};

// --- Admin User Management ---

// Get all users, with optional search functionality
const getAllUsersForAdmin = async (req, res) => {
    try {
        const { search } = req.query; // Get search query from query parameters
        let query = supabase.from('users').select('id, full_name, email, user_type, created_at');

        // Apply search filter if provided
        if (search) {
            query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
        }

        // Order users by creation date, newest first
        const { data: users, error } = await query.order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ users });
    } catch (error) {
        console.error('Error fetching all users for admin:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get a specific user's details by ID for admin view
const getUserByIdForAdmin = async (req, res) => {
    try {
        const { userId } = req.params;
        console.log(`[getUserByIdForAdmin] Attempting to fetch user ID: ${userId}`);

        // Fetch user details, including nested transcriber and client profiles
        const { data: user, error } = await supabase
            .from('users')
            .select(`
                id, full_name, email, user_type, created_at, is_online, is_available, current_job_id,
                transcribers (status, user_level, average_rating, completed_jobs, badges),
                clients (average_rating)
            `)
            .eq('id', userId)
            .single();

        if (error) {
            console.error(`[getUserByIdForAdmin] Supabase error fetching user ${userId}:`, error);
            // Return 404 if user not found, 500 for other errors
            if (error.code === 'PGRST116') { // No rows found
                 console.warn(`[getUserByIdForAdmin] User ${userId} not found.`);
                 return res.status(404).json({ error: 'User not found.' });
            }
            // Log the full error to understand what's happening
            console.error(`[getUserByIdForAdmin] Detailed Supabase error for user ${userId}:`, error);
            throw error; // Re-throw other Supabase errors
        }
        if (!user) { // This case should ideally be caught by PGRST116, but defensive check
            console.warn(`[getUserByIdForAdmin] User ${userId} not found (after initial check).`);
            return res.status(404).json({ error: 'User not found.' });
        }

        // Format the user object to nest profile data and remove redundant arrays
        const formattedUser = {
            ...user,
            transcriber_profile: user.transcribers?.[0] || null, // Nest transcriber profile or set to null
            client_profile: user.clients?.[0] || null, // Nest client profile or set to null
        };
        // Clean up the original nested arrays
        delete formattedUser.transcribers;
        delete formattedUser.clients;

        console.log(`[getUserByIdForAdmin] Successfully fetched and formatted user: ${userId}`);
        res.json({ user: formattedUser });
    } catch (error) {
        console.error('[getUserByIdForAdmin] Error fetching user by ID for admin: ', error.message); // Log full error message
        res.status(500).json({ error: error.message || 'Server error fetching user details.' });
    }
};

// Get basic user info by ID (potentially for public viewing or less sensitive contexts)
const getAnyUserById = async (req, res) => {
    try {
        const { userId } = req.params;
        const { data: user, error } = await supabase
            .from('users')
            .select('id, full_name, email, user_type, is_online, is_available, current_job_id') // Added availability and job status
            .eq('id', userId)
            .single();

        if (error) {
            console.error(`[getAnyUserById] Supabase error fetching user ${userId}:`, error);
            // Return 404 if user not found, 500 for other errors
            if (error.code === 'PGRST116') { // No rows found
                 console.warn(`[getAnyUserById] User ${userId} not found.`);
                 return res.status(404).json({ error: 'User not found.' });
            }
            // Log the full error to understand what's happening
            console.error(`[getAnyUserById] Detailed Supabase error for user ${userId}:`, error);
            throw error; // Re-throw other Supabase errors
        }
        if (!user) { // Defensive check
            console.warn(`[getAnyUserById] User ${userId} not found (after initial check).`);
            return res.status(404).json({ error: 'User not found.' });
        }
        res.json({ user });
    } catch (error) {
        console.error('[getAnyUserById] Error fetching any user by ID: ', error.message); // Log full error message
        res.status(500).json({ error: error.message || 'Server error fetching user details.' });
    }
};

// --- Admin Global Settings ---

// Get admin settings (e.g., default prices, deadlines)
const getAdminSettings = async (req, res) => {
    try {
        // UPDATED: Fetch pricing_rules instead of individual price/deadline settings
        const { data: settings, error } = await supabase
            .from('admin_settings')
            .select('id, pricing_rules') // Select the id and the new JSONB column
            .single();

        // Handle case where settings table might be empty (return defaults)
        if (error && error.code === 'PGRST116') { // PGRST116 = No rows found
            return res.json({
                settings: {
                    id: null, // No ID if no settings exist yet
                    pricing_rules: [] // Default to an empty array of rules
                }
            });
        }
        if (error) throw error;

        res.json({ settings });
    } catch (error) {
        console.error('Error fetching admin settings:', error);
        res.status(500).json({ error: error.message });
    }
};

// Update admin settings
const updateAdminSettings = async (req, res) => {
    try {
        // UPDATED: Expect pricing_rules from the body
        const { id, pricing_rules } = req.body; // 'id' will be used for updating an existing row

        if (!pricing_rules || !Array.isArray(pricing_rules)) {
            return res.status(400).json({ error: 'Pricing rules must be provided as an array.' });
        }

        const updatePayload = {
            pricing_rules: pricing_rules,
            updated_at: new Date().toISOString(),
        };

        let result;
        if (id) {
            // Attempt to update existing settings
            const { data, error } = await supabase
                .from('admin_settings')
                .update(updatePayload)
                .eq('id', id) // Update the specific row
                .select(); // Return the updated row

            if (error) throw error;
            result = data;
        } else {
            // If no ID is provided, assume no settings exist, and insert new ones
            const { data, error } = await supabase
                .from('admin_settings')
                .insert(updatePayload)
                .select(); // Return the inserted row
            if (error) throw error;
            result = data;
        }
        
        if (!result || result.length === 0) {
            return res.status(500).json({ error: 'Failed to save or update settings. No data returned.' });
        }

        res.json({ message: 'Settings updated successfully.', settings: result[0] });
    } catch (error) {
        console.error('Error updating admin settings:', error);
        res.status(500).json({ error: error.message });
    }
};

// NEW: Function to get all jobs (negotiations) for admin view
const getAllJobsForAdmin = async (req, res) => {
    try {
        const { data: negotiations, error } = await supabase
            .from('negotiations')
            .select(`
                id,
                status,
                agreed_price_usd,     // UPDATED: Changed to agreed_price_usd
                requirements,
                deadline_hours,
                created_at,
                client_id,
                transcriber_id,
                client:users!client_id (
                    full_name, email
                ),
                transcriber:users!transcriber_id (
                    full_name, email
                )
            `)
            .order('created_at', { ascending: false }); // Order by creation date

        if (error) throw error;

        // Format results to handle potential null client/transcriber IDs gracefully
        const jobs = negotiations.map(n => ({
            ...n,
            client: n.client || { full_name: 'Unknown Client', email: 'N/A' }, // Provide default if client is null
            transcriber: n.transcriber || { full_name: 'Unassigned', email: 'N/A' } // Provide default if transcriber is null
        }));

        res.json(jobs); // Return the array of jobs directly
    } catch (error) {
        console.error('Error fetching all jobs for admin:', error);
        res.status(500).json({ error: error.message });
    }
};

// NEW: Function to get a single job (negotiation) by ID for admin view
const getJobByIdForAdmin = async (req, res) => {
    try {
        const { jobId } = req.params;
        console.log(`[getJobByIdForAdmin] Attempting to fetch job ID: ${jobId}`);

        const { data: negotiation, error } = await supabase
            .from('negotiations')
            .select(`
                *,
                client:users!client_id (
                    id, full_name, email
                ),
                transcriber:users!transcriber_id (
                    id, full_name, email
                )
            `)
            .eq('id', jobId)
            .single();

        if (error) {
            console.error(`[getJobByIdForAdmin] Supabase error fetching job ${jobId}:`, error);
            // Return 404 if job not found, 500 for other errors
            if (error.code === 'PGRST116') { // No rows found
                 console.warn(`[getJobByIdForAdmin] Job ${jobId} not found.`);
                 return res.status(404).json({ error: 'Job not found.' });
            }
            // Log the full error to understand what's happening
            console.error(`[getJobByIdForAdmin] Detailed Supabase error for job ${jobId}:`, error);
            throw error; // Re-throw other Supabase errors
        }
        if (!negotiation) { // This case should ideally be caught by PGRST116, but defensive check
            console.warn(`[getJobByIdForAdmin] Job ${jobId} not found (after initial check).`);
            return res.status(404).json({ error: 'Job not found.' });
        }

        // Format the job object to handle potential null client/transcriber IDs gracefully
        const formattedJob = {
            ...negotiation,
            client: negotiation.client || { id: null, full_name: 'Unknown Client', email: 'N/A' },
            transcriber: negotiation.transcriber || { id: null, full_name: 'Unassigned', email: 'N/A' }
        };

        res.json(formattedJob); // Return the formatted job object directly
    } catch (error) {
        console.error('Error fetching job by ID for admin: ', error.message); // Log full error message
        res.status(500).json({ error: error.message || 'Server error fetching job details.' });
    }
};


// NEW: Function to get all disputes for admin view
const getAllDisputesForAdmin = async (req, res) => {
    try {
        const { data: disputes, error } = await supabase
            .from('disputes')
            .select(`
                id,
                negotiation_id,
                reason,
                description,
                status,
                opened_at,
                resolved_at,
                resolution_notes,
                client:users!client_id (
                    full_name
                ),
                transcriber:users!transcriber_id (
                    full_name
                )
            `)
            .order('opened_at', { ascending: false }); // Order by when dispute was opened

        if (error) throw error;

        // Format disputes to handle potential null client/transcriber IDs
        const formattedDisputes = disputes.map(d => ({
            ...d,
            client: d.client || { full_name: 'Unknown Client' },
            transcriber: d.transcriber || { full_name: 'Unknown Transcriber' }
        }));

        res.json({ disputes: formattedDisputes });
    } catch (error) {
        console.error('Error fetching all disputes for admin:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getPendingTranscriberTestsCount,
    getActiveJobsCount,
    getOpenDisputesCount,
    getTotalUsersCount,
    getAllTranscriberTestSubmissions,
    getTranscriberTestSubmissionById,
    approveTranscriberTest,
    rejectTranscriberTest,
    getAllUsersForAdmin,
    getUserByIdForAdmin,
    getAnyUserById,
    getAdminSettings,
    updateAdminSettings,
    getAllJobsForAdmin,
    getJobByIdForAdmin, // NEW: Export the new function
    getAllDisputesForAdmin,
};
