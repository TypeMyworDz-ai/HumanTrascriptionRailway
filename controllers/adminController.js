// backend/controllers/adminController.js - Part 1 - UPDATED for getUserByIdForAdmin debugging

const supabase = require('../database');
const emailService = require('../emailService'); // Assuming this path is correct

// --- Admin Statistics ---

const getPendingTranscriberTestsCount = async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('test_submissions')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending');

        if (error) throw error;
        res.json({ count });
    } catch (error) {
        console.error('Error fetching pending transcriber tests count:', error);
        res.status(500).json({ error: error.message });
    }
};

const getActiveJobsCount = async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('negotiations')
            .select('*', { count: 'exact', head: true })
            .in('status', ['accepted', 'hired']);

        if (error) throw error;
        res.json({ count });
    } catch (error) {
        console.error('Error fetching active jobs count:', error);
        res.status(500).json({ error: error.message });
    }
};

const getOpenDisputesCount = async (req, res) => {
    try {
        // Assuming a 'disputes' table and a 'status' column for open/closed
        const { count, error } = await supabase
            .from('disputes')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'open'); // Or 'pending', depending on your schema

        if (error) throw error;
        res.json({ count });
    } catch (error) {
        console.error('Error fetching open disputes count:', error);
        res.status(500).json({ error: error.message });
    }
};

const getTotalUsersCount = async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });

        if (error) throw error;
        res.json({ count });
    } catch (error) {
        console.error('Error fetching total users count:', error);
        res.status(500).json({ error: error.message });
    }
};

// --- Admin Transcriber Test Management ---

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
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ submissions });
    } catch (error) {
        console.error('Error fetching all transcriber test submissions:', error);
        res.status(500).json({ error: error.message });
    }
};

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
            .eq('id', submissionId)
            .single();

        if (error) throw error;
        res.json({ submission });
    } catch (error) {
        console.error('Error fetching transcriber test submission by ID::', error);
        res.status(500).json({ error: error.message });
    }
};

const approveTranscriberTest = async (req, res) => {
    try {
        const { submissionId } = req.params;
        const { transcriberId } = req.body;

        const { error: submissionUpdateError } = await supabase
            .from('test_submissions')
            .update({ status: 'approved', admin_notes: 'Approved by admin', updated_at: new Date().toISOString() })
            .eq('id', submissionId);

        if (submissionUpdateError) throw submissionUpdateError;

        // Update the transcriber's profile status to 'active_transcriber'
        const { error: transcriberProfileError } = await supabase
            .from('transcribers')
            .update({ status: 'active_transcriber', updated_at: new Date().toISOString() })
            .eq('id', transcriberId);

        if (transcriberProfileError) throw transcriberProfileError;

        // NEW: Update the user's main profile status as well
        const { error: userStatusError } = await supabase
            .from('users')
            .update({ status: 'active_transcriber', updated_at: new Date().toISOString() })
            .eq('id', transcriberId);

        if (userStatusError) console.error('Error updating user status after test approval:', userStatusError);

        // Fetch user details for email
        const { data: userDetails, error: userDetailsError } = await supabase
            .from('users')
            .select('full_name, email')
            .eq('id', transcriberId)
            .single();

        if (userDetailsError) console.error('Error fetching user details for approval email:', userDetailsError);

        if (userDetails) {
            await emailService.sendTranscriberTestApprovedEmail(userDetails);
        }

        res.json({ message: 'Transcriber test approved successfully.' });
    } catch (error) {
        console.error('Error approving transcriber test:', error);
        res.status(500).json({ error: error.message });
    }
};

const rejectTranscriberTest = async (req, res) => {
    try {
        const { submissionId } = req.params;
        const { transcriberId, reason } = req.body;

        const { error: submissionUpdateError } = await supabase
            .from('test_submissions')
            .update({ status: 'rejected', rejection_reason: reason, admin_notes: 'Rejected by admin', updated_at: new Date().toISOString() })
            .eq('id', submissionId);

        if (submissionUpdateError) throw submissionUpdateError;

        // Update the transcriber's profile status to 'rejected'
        const { error: transcriberProfileError } = await supabase
            .from('transcribers')
            .update({ status: 'rejected', updated_at: new Date().toISOString() })
            .eq('id', transcriberId);

        if (transcriberProfileError) throw transcriberProfileError;

        // NEW: Update the user's main profile status as well
        const { error: userStatusError } = await supabase
            .from('users')
            .update({ status: 'rejected', updated_at: new Date().toISOString() })
            .eq('id', transcriberId);

        if (userStatusError) console.error('Error updating user status after test rejection:', userStatusError);

        // Fetch user details for email
        const { data: userDetails, error: userDetailsError } = await supabase
            .from('users')
            .select('full_name, email')
            .eq('id', transcriberId)
            .single();

        if (userDetailsError) console.error('Error fetching user details for rejection email:', userDetailsError);

        if (userDetails) {
            await emailService.sendTranscriberTestRejectedEmail(userDetails, reason);
        }

        res.json({ message: 'Transcriber test rejected successfully.' });
    } catch (error) {
        console.error('Error rejecting transcriber test:', error);
        res.status(500).json({ error: error.message });
    }
};

// --- Admin User Management ---

const getAllUsersForAdmin = async (req, res) => {
    try {
        const { search } = req.query; // Get search term from query parameters
        let query = supabase.from('users').select('id, full_name, email, user_type, created_at');

        if (search) {
            query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
        }

        const { data: users, error } = await query.order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ users });
    } catch (error) {
        console.error('Error fetching all users for admin:', error);
        res.status(500).json({ error: error.message });
    }
};

const getUserByIdForAdmin = async (req, res) => {
    try {
        const { userId } = req.params;
        console.log(`[getUserByIdForAdmin] Attempting to fetch user ID: ${userId}`);

        const { data: user, error } = await supabase
            .from('users')
            .select(`
                id,
                full_name,
                email,
                user_type,
                created_at,
                is_online,
                is_available,
                transcribers (
                    status,
                    user_level,
                    average_rating,
                    completed_jobs,
                    badges
                ),
                clients (
                    client_rating
                )
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

        // Flatten the data for easier consumption on the frontend
        const formattedUser = {
            ...user,
            // Safely access array elements for one-to-one relationships
            transcriber_profile: user.transcribers?.[0] || null,
            client_profile: user.clients?.[0] || null,
        };
        delete formattedUser.transcribers; // Clean up raw nested arrays
        delete formattedUser.clients; // Clean up raw nested arrays

        console.log(`[getUserByIdForAdmin] Successfully fetched and formatted user: ${userId}`);
        res.json({ user: formattedUser });
    } catch (error) {
        console.error('[getUserByIdForAdmin] Error fetching user by ID for admin:', error);
        res.status(500).json({ error: error.message });
    }
};

const getAnyUserById = async (req, res) => {
    try {
        const { userId } = req.params;
        const { data: user, error } = await supabase
            .from('users')
            .select('id, full_name, email, user_type')
            .eq('id', userId)
            .single();

        if (error) throw error;
        res.json({ user });
    } catch (error) {
        console.error('Error fetching any user by ID:', error);
        res.status(500).json({ error: error.message });
    }
};

// --- Admin Global Settings ---

const getAdminSettings = async (req, res) => {
    try {
        const { data: settings, error } = await supabase
            .from('admin_settings')
            .select('default_price_per_minute, default_deadline_hours')
            .single();

        if (error && error.code === 'PGRST116') { // No rows found, return defaults
            return res.json({
                settings: {
                    default_price_per_minute: 0.00,
                    default_deadline_hours: 24,
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

const updateAdminSettings = async (req, res) => {
    try {
        const { default_price_per_minute, default_deadline_hours } = req.body;

        const { data, error } = await supabase
            .from('admin_settings')
            .update({
                default_price_per_minute: default_price_per_minute,
                default_deadline_hours: default_deadline_hours,
                updated_at: new Date().toISOString(),
            })
            .limit(1) // Ensure only one row is affected
            .select();

        if (error) throw error;

        if (!data || data.length === 0) {
            const { data: insertData, error: insertError } = await supabase
                .from('admin_settings')
                .insert({
                    default_price_per_minute: default_price_per_minute,
                    default_deadline_hours: default_deadline_hours,
                })
                .select();
            if (insertError) throw insertError;
            return res.json({ message: 'Settings initialized and saved successfully.', settings: insertData[0] });
        }

        res.json({ message: 'Settings updated successfully.', settings: data[0] });
    } catch (error) {
        console.error('Error updating admin settings:', error);
        res.status(500).json({ error: error.message });
    }
};

// NEW: Function to get all jobs (negotiations) for admin
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
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Flatten the client and transcriber names for easier frontend consumption
        const jobs = negotiations.map(n => ({
            ...n,
            client: n.client || { full_name: 'Unknown Client' }, // Ensure client object exists
            transcriber: n.transcriber || { full_name: 'Unassigned' } // Ensure transcriber object exists
        }));

        res.json({ jobs });
    } catch (error) {
        console.error('Error fetching all jobs for admin:', error);
        res.status(500).json({ error: error.message });
    }
};

// NEW: Function to get all disputes for admin
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
            .order('opened_at', { ascending: false });

        if (error) throw error;

        // Flatten client and transcriber names
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
// backend/controllers/adminController.js - Part 2 - UPDATED with getAllDisputesForAdmin (Continue from Part 1)

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
