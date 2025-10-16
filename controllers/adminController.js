const supabase = require('../database');
const emailService = require('../emailService'); // Assuming emailService might be used by other admin functions

// Helper function for logging (optional, can be removed)
const log = (message, ...args) => console.log(`[adminController.js] ${message}`, ...args);
const errorLog = (message, ...args) => console.error(`[adminController.js ERROR] ${message}`, ...args);

// NEW: Function to get the count of pending transcriber tests
const getPendingTranscriberTestsCount = async (req, res) => {
    log('getPendingTranscriberTestsCount function called.');
    try {
        const { count, error } = await supabase
            .from('transcriber_tests')
            .select('id', { count: 'exact' })
            .eq('status', 'pending');

        if (error) {
            errorLog('Supabase error fetching pending transcriber tests count:', error);
            return res.status(500).json({ error: error.message });
        }

        log('Pending transcriber tests count:', count);
        res.json({ count: count });
    } catch (error) {
        errorLog('Unexpected error in getPendingTranscriberTestsCount:', error);
        res.status(500).json({ error: 'Failed to get pending tests count.' });
    }
};

// Placeholder for other admin functions as their implementations were not provided.
// You will need to replace these with your actual logic.

const getActiveJobsCount = async (req, res) => {
    log('getActiveJobsCount function called. (Placeholder)');
    try {
        const { count, error } = await supabase
            .from('negotiations')
            .select('id', { count: 'exact' })
            .in('status', ['in_progress', 'accepted']); // Assuming these are active statuses

        if (error) {
            errorLog('Supabase error fetching active jobs count:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json({ count: count });
    } catch (error) {
        errorLog('Error in getActiveJobsCount:', error);
        res.status(500).json({ error: 'Failed to get active jobs count.' });
    }
};

const getOpenDisputesCount = async (req, res) => {
    log('getOpenDisputesCount function called. (Placeholder)');
    try {
        const { count, error } = await supabase
            .from('disputes')
            .select('id', { count: 'exact' })
            .eq('status', 'open'); // Assuming 'open' is the status for active disputes

        if (error) {
            errorLog('Supabase error fetching open disputes count:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json({ count: count });
    } catch (error) {
        errorLog('Error in getOpenDisputesCount:', error);
        res.status(500).json({ error: 'Failed to get open disputes count.' });
    }
};

const getTotalUsersCount = async (req, res) => {
    log('getTotalUsersCount function called. (Placeholder)');
    try {
        const { count, error } = await supabase
            .from('users')
            .select('id', { count: 'exact' });

        if (error) {
            errorLog('Supabase error fetching total users count:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json({ count: count });
    } catch (error) {
        errorLog('Error in getTotalUsersCount:', error);
        res.status(500).json({ error: 'Failed to get total users count.' });
    }
};

const getAllTranscriberTestSubmissions = async (req, res) => {
    log('getAllTranscriberTestSubmissions function called. (Placeholder)');
    try {
        const { data, error } = await supabase
            .from('transcriber_tests')
            .select(`
                *,
                user:users(full_name, email)
            `);

        if (error) {
            errorLog('Supabase error fetching all transcriber test submissions:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json(data);
    } catch (error) {
        errorLog('Error in getAllTranscriberTestSubmissions:', error);
        res.status(500).json({ error: 'Failed to get all transcriber test submissions.' });
    }
};

const getTranscriberTestSubmissionById = async (req, res) => {
    log('getTranscriberTestSubmissionById function called. (Placeholder)');
    const { testId } = req.params;
    try {
        const { data, error } = await supabase
            .from('transcriber_tests')
            .select(`
                *,
                user:users(full_name, email)
            `)
            .eq('id', testId)
            .single();

        if (error) {
            errorLog('Supabase error fetching transcriber test submission by ID:', error);
            return res.status(500).json({ error: error.message });
        }
        if (!data) {
            return res.status(404).json({ message: 'Test submission not found.' });
        }
        res.json(data);
    } catch (error) {
        errorLog('Error in getTranscriberTestSubmissionById:', error);
        res.status(500).json({ error: 'Failed to get transcriber test submission by ID.' });
    }
};

const approveTranscriberTest = async (req, res) => {
    log('approveTranscriberTest function called. (Placeholder)');
    const { testId } = req.params;
    try {
        // First, get the test to find the user_id
        const { data: test, error: fetchError } = await supabase
            .from('transcriber_tests')
            .select('user_id')
            .eq('id', testId)
            .single();

        if (fetchError || !test) {
            errorLog('Error fetching test for approval:', fetchError);
            return res.status(500).json({ error: fetchError?.message || 'Test not found.' });
        }

        // Update the transcriber_tests status
        const { error: testUpdateError } = await supabase
            .from('transcriber_tests')
            .update({ status: 'approved', updated_at: new Date().toISOString() })
            .eq('id', testId);

        if (testUpdateError) {
            errorLog('Supabase error approving transcriber test:', testUpdateError);
            return res.status(500).json({ error: testUpdateError.message });
        }

        // Update the user's user_type and status
        const { error: userUpdateError } = await supabase
            .from('users')
            .update({ user_type: 'transcriber', status: 'active', updated_at: new Date().toISOString() })
            .eq('id', test.user_id);

        if (userUpdateError) {
            errorLog('Supabase error updating user status after test approval:', userUpdateError);
            return res.status(500).json({ error: userUpdateError.message });
        }

        // Update transcriber profile status
        const { error: transcriberUpdateError } = await supabase
            .from('transcribers')
            .update({ status: 'active', user_level: 'transcriber', updated_at: new Date().toISOString() })
            .eq('id', test.user_id);

        if (transcriberUpdateError) {
            errorLog('Supabase error updating transcriber profile status after test approval:', transcriberUpdateError);
            return res.status(500).json({ error: transcriberUpdateError.message });
        }

        res.json({ message: 'Transcriber test approved and user status updated successfully.' });
    } catch (error) {
        errorLog('Error in approveTranscriberTest:', error);
        res.status(500).json({ error: 'Failed to approve transcriber test.' });
    }
};

const rejectTranscriberTest = async (req, res) => {
    log('rejectTranscriberTest function called. (Placeholder)');
    const { testId } = req.params;
    try {
        const { error } = await supabase
            .from('transcriber_tests')
            .update({ status: 'rejected', updated_at: new Date().toISOString() })
            .eq('id', testId);

        if (error) {
            errorLog('Supabase error rejecting transcriber test:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json({ message: 'Transcriber test rejected successfully.' });
    } catch (error) {
        errorLog('Error in rejectTranscriberTest:', error);
        res.status(500).json({ error: 'Failed to reject transcriber test.' });
    }
};

const getAllUsersForAdmin = async (req, res) => {
    log('getAllUsersForAdmin function called. (Placeholder)');
    try {
        const { data, error } = await supabase
            .from('users')
            .select(`
                id,
                full_name,
                email,
                user_type,
                is_active,
                created_at,
                last_login,
                clients(phone, client_rating),
                transcribers(phone, status, user_level, is_online, is_available, average_rating, completed_jobs, badges, current_job_id)
            `);

        if (error) {
            errorLog('Supabase error fetching all users for admin:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json(data);
    } catch (error) {
        errorLog('Error in getAllUsersForAdmin:', error);
        res.status(500).json({ error: 'Failed to get all users for admin.' });
    }
};

const getUserByIdForAdmin = async (req, res) => {
    log('getUserByIdForAdmin function called. (Placeholder)');
    const { userId } = req.params;
    try {
        const { data: user, error: userError } = await supabase
            .from('users')
            .select(`
                id,
                full_name,
                email,
                user_type,
                is_active,
                created_at,
                last_login,
                clients(phone, client_rating),
                transcribers(phone, status, user_level, is_online, is_available, average_rating, completed_jobs, badges, current_job_id)
            `)
            .eq('id', userId)
            .single();

        if (userError) {
            errorLog('Supabase error fetching user by ID for admin:', userError);
            return res.status(500).json({ error: userError.message });
        }
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.json(user);
    } catch (error) {
        errorLog('Error in getUserByIdForAdmin:', error);
        res.status(500).json({ error: 'Failed to get user by ID for admin.' });
    }
};

const getAnyUserById = async (req, res) => {
    log('getAnyUserById function called. (Placeholder)');
    const { userId } = req.params;
    try {
        const { data: user, error: userError } = await supabase
            .from('users')
            .select(`
                id,
                full_name,
                email,
                user_type,
                is_active,
                created_at,
                last_login
            `)
            .eq('id', userId)
            .single();

        if (userError) {
            errorLog('Supabase error fetching any user by ID:', userError);
            return res.status(500).json({ error: userError.message });
        }
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.json(user);
    } catch (error) {
        errorLog('Error in getAnyUserById:', error);
        res.status(500).json({ error: 'Failed to get any user by ID.' });
    }
};


const getAdminSettings = async (req, res) => {
    log('getAdminSettings function called. (Placeholder)');
    try {
        const { data, error } = await supabase
            .from('admin_settings')
            .select('*')
            .single(); // Assuming only one row for global settings

        if (error) {
            errorLog('Supabase error fetching admin settings:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json(data);
    } catch (error) {
        errorLog('Error in getAdminSettings:', error);
        res.status(500).json({ error: 'Failed to get admin settings.' });
    }
};

const updateAdminSettings = async (req, res) => {
    log('updateAdminSettings function called. (Placeholder)');
    const { default_price_per_minute, default_deadline_hours } = req.body;
    try {
        const { data, error } = await supabase
            .from('admin_settings')
            .update({
                default_price_per_minute,
                default_deadline_hours,
                updated_at: new Date().toISOString()
            })
            .eq('id', 1) // Assuming a fixed ID for the single settings row
            .select();

        if (error) {
            errorLog('Supabase error updating admin settings:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json({ message: 'Admin settings updated successfully.', settings: data[0] });
    } catch (error) {
        errorLog('Error in updateAdminSettings:', error);
        res.status(500).json({ error: 'Failed to update admin settings.' });
    }
};

const getAllJobsForAdmin = async (req, res) => {
    log('getAllJobsForAdmin function called. (Placeholder)');
    try {
        const { data, error } = await supabase
            .from('negotiations')
            .select(`
                *,
                client:users!client_id(full_name, email),
                transcriber:users!transcriber_id(full_name, email)
            `);

        if (error) {
            errorLog('Supabase error fetching all jobs for admin:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json(data);
    } catch (error) {
        errorLog('Error in getAllJobsForAdmin:', error);
        res.status(500).json({ error: 'Failed to get all jobs for admin.' });
    }
};

const getAllDisputesForAdmin = async (req, res) => {
    log('getAllDisputesForAdmin function called. (Placeholder)');
    try {
        const { data, error } = await supabase
            .from('disputes')
            .select(`
                *,
                client:users!client_id(full_name, email),
                transcriber:users!transcriber_id(full_name, email),
                negotiation:negotiations(title)
            `);

        if (error) {
            errorLog('Supabase error fetching all disputes for admin:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json(data);
    } catch (error) {
        errorLog('Error in getAllDisputesForAdmin:', error);
        res.status(500).json({ error: 'Failed to get all disputes for admin.' });
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
