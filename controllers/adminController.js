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
        const { count, error } = await supabase
            .from('negotiations')
            .select('*', { count: 'exact', head: true })
            .in('status', ['accepted', 'hired']); // Count jobs that are active

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
        console.error('Error fetching total users count:', error);
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
            `) // Corrected: Removed embedded comment
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
            `) // Corrected: Removed embedded comment
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
                id, full_name, email, user_type, created_at, is_online, is_available,
                transcribers (status, user_level, average_rating, completed_jobs, badges),
                clients (average_rating)
            `)
            .eq('id', userId)
            .single();

        if (error) {
            console.error(`[getUserByIdForAdmin] Supabase error fetching user ${userId}:`, error);
            throw error;
        }
        if (!user) {
            console.warn(`[getUserByIdForAdmin] User ${userId} not found.`);
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
        console.error('Error fetching user by ID for admin:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get basic user info by ID (potentially for public viewing or less sensitive contexts)
const getAnyUserById = async (req, res) => {
    try {
        const { userId } = req.params;
        const { data: user, error } = await supabase
            .from('users')
            .select('id, full_name, email, user_type') // Select minimal fields
            .eq('id', userId)
            .single();

        if (error) throw error;
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json({ user });
    } catch (error) {
        console.error('Error fetching any user by ID:', error);
        res.status(500).json({ error: error.message });
    }
};

// --- Admin Global Settings ---

// Get admin settings (e.g., default prices, deadlines)
const getAdminSettings = async (req, res) => {
    try {
        const { data: settings, error } = await supabase
            .from('admin_settings')
            .select('default_price_per_minute, default_deadline_hours')
            .single();

        // Handle case where settings table might be empty (return defaults)
        if (error && error.code === 'PGRST116') { // PGRST116 = No rows found
            return res.json({
                settings: {
                    default_price_per_minute: 0.00, // Default value
                    default_deadline_hours: 24,     // Default value
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
        const { default_price_per_minute, default_deadline_hours } = req.body;

        // Attempt to update existing settings, or insert if none exist
        const { data, error } = await supabase
            .from('admin_settings')
            .update({
                default_price_per_minute: default_price_per_minute,
                default_deadline_hours: default_deadline_hours,
                updated_at: new Date().toISOString(),
            })
            .limit(1) // Ensure only one row is updated/affected
            .select(); // Return the updated row

        if (error) throw error;

        // If no row was updated (table was empty), insert new settings
        if (!data || data.length === 0) {
            const { data: insertData, error: insertError } = await supabase
                .from('admin_settings')
                .insert({
                    default_price_per_minute: default_price_per_minute,
                    default_deadline_hours: default_deadline_hours,
                })
                .select(); // Return the inserted row
            if (insertError) throw insertError;
            return res.json({ message: 'Settings initialized and saved successfully.', settings: insertData[0] });
        }

        res.json({ message: 'Settings updated successfully.', settings: data[0] });
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
                agreed_price_kes,
                requirements,
                deadline_hours,
                created_at,
                client:users!client_id (
                    full_name
                ),
                transcriber:users!transcriber_id (
                    full_name
                )
            `)
            .order('created_at', { ascending: false }); // Order by creation date

        if (error) throw error;

        // Format results to handle potential null client/transcriber IDs gracefully
        const jobs = negotiations.map(n => ({
            ...n,
            client: n.client || { full_name: 'Unknown Client' }, // Provide default if client is null
            transcriber: n.transcriber || { full_name: 'Unassigned' } // Provide default if transcriber is null
        }));

        res.json({ jobs });
    } catch (error) {
        console.error('Error fetching all jobs for admin:', error);
        res.status(500).json({ error: error.message });
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
    getAllDisputesForAdmin,
};
