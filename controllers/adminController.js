// backend/controllers/adminController.js

const supabase = require('../database');
const emailService = require('../emailService'); // Make sure this path is correct

// Get count of pending transcriber tests
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

// Get count of active jobs
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

// Get count of open disputes (placeholder for now)
const getOpenDisputesCount = async (req, res) => {
    try {
        const disputesCount = 0; // Placeholder
        res.json({ count: disputesCount });
    } catch (error) {
        console.error('Error fetching open disputes count:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get total users count (clients + transcribers + admins)
const getTotalUsersCount = async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('users') // Query the core users table
            .select('*', { count: 'exact', head: true });

        if (error) throw error;

        res.json({ count });
    } catch (error) {
        console.error('Error fetching total users count:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get all transcriber test submissions (for admin review)
const getAllTranscriberTestSubmissions = async (req, res) => {
    try {
        const { data: submissions, error } = await supabase
            .from('test_submissions')
            .select('id, user_id, grammar_score, transcription_text, status, rejection_reason, created_at, users(id, full_name, email)')
            .order('created_at', { ascending: true });

        if (error) throw error;

        res.json({ submissions });
    } catch (error) {
        console.error('Error fetching all transcriber test submissions:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get a single transcriber test submission by ID
const getTranscriberTestSubmissionById = async (req, res) => {
    try {
        const { submissionId } = req.params;
        const { data: submission, error } = await supabase
            .from('test_submissions')
            .select('id, user_id, grammar_score, transcription_text, status, rejection_reason, created_at, users(id, full_name, email)')
            .eq('id', submissionId)
            .single();

        if (error) throw error;
        if (!submission) {
            return res.status(404).json({ error: 'Test submission not found.' });
        }

        res.json({ submission });
    } catch (error) {
        console.error('Error fetching single transcriber test submission:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get all users for admin management, with optional search
const getAllUsersForAdmin = async (req, res) => {
    try {
        const { search } = req.query; // Get search query from URL parameters
        console.log(`Backend: getAllUsersForAdmin called with search term: '${search}'`);
        
        let query = supabase.from('users').select('id, full_name, email, user_type, created_at');

        if (search) {
            query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
            console.log(`Backend: Applying search filter: ${search}`);
        }

        // Only fetch 'client' and 'transcriber' types for management
        query = query.in('user_type', ['client', 'transcriber']);
        console.log('Backend: Applying user_type filter: client, transcriber');

        const { data: users, error } = await query.order('created_at', { ascending: false });

        if (error) {
            console.error('Supabase error in getAllUsersForAdmin:', error);
            throw error;
        }

        console.log(`Backend: Successfully fetched ${users ? users.length : 0} users.`);
        res.json({ users });
    } catch (error) {
        console.error('Error fetching all users for admin (caught):', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
};

// Get a single user by ID for admin (e.g., for chat) - Admin-specific, kept separate
const getUserByIdForAdmin = async (req, res) => {
    try {
        const { userId } = req.params;
        const { data: user, error } = await supabase
            .from('users')
            .select('id, full_name, email, user_type') // Select only necessary fields
            .eq('id', userId)
            .single();

        if (error) throw error;
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.json({ user });
    } catch (error) {
        console.error('Error fetching user by ID for admin:', error);
        res.status(500).json({ error: error.message });
    }
};

// NEW: Generic function to get any user by ID (accessible to any authenticated user)
const getAnyUserById = async (req, res) => {
    try {
        const { userId } = req.params;
        const { data: user, error } = await supabase
            .from('users')
            .select('id, full_name, email, user_type') // Select only necessary fields
            .eq('id', userId)
            .single();

        if (error) throw error;
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.json({ user });
    } catch (error) {
        console.error('Error fetching any user by ID:', error);
        res.status(500).json({ error: error.message });
    }
};


// Approve a transcriber test submission
const approveTranscriberTest = async (req, res) => {
    try {
        const { submissionId } = req.params;
        const { transcriberId } = req.body; // Get transcriberId from the request body

        if (!submissionId || !transcriberId) {
            return res.status(400).json({ error: 'Submission ID and Transcriber ID are required.' });
        }

        // 1. Update test_submissions status to 'approved'
        const { data: updatedSubmission, error: submissionError } = await supabase
            .from('test_submissions')
            .update({ status: 'approved', rejection_reason: null, updated_at: new Date().toISOString() })
            .eq('id', submissionId)
            .eq('user_id', transcriberId) // Ensure we're updating the correct submission
            .select('user_id')
            .single();

        if (submissionError) throw submissionError;
        if (!updatedSubmission) {
            return res.status(404).json({ error: 'Test submission not found or does not belong to the transcriber.' });
        }

        // 2. Update transcriber's profile status to 'active_transcriber'
        const { error: profileUpdateError } = await supabase
            .from('transcribers') // Update the 'transcribers' table
            .update({ status: 'active_transcriber', updated_at: new Date().toISOString() })
            .eq('id', transcriberId); // Update the transcriber's profile

        if (profileUpdateError) throw profileUpdateError;

        // --- SEND WELCOME EMAIL TO TRANSCRIBER UPON APPROVAL ---
        // Fetch transcriber details to send the email
        const { data: transcriberDetails, error: transcriberDetailsError } = await supabase
            .from('users') // Fetch from 'users' table for email and name
            .select('id, email, full_name')
            .eq('id', transcriberId)
            .single();
        
        if (transcriberDetailsError) {
            console.error(`Error fetching transcriber details for email for ID ${transcriberId}:`, transcriberDetailsError);
            // Continue without blocking the response, but log the error
        } else if (transcriberDetails && transcriberDetails.email) {
            await emailService.sendTranscriberTestResultEmail(transcriberDetails, 'approved');
        }
        // --- END OF EMAIL INTEGRATION ---

        res.json({ message: 'Transcriber test approved and status updated.' });
    } catch (error) {
        console.error('Error approving transcriber test:', error);
        res.status(500).json({ error: error.message });
    }
};

// Reject a transcriber test submission
const rejectTranscriberTest = async (req, res) => {
    try {
        const { submissionId } = req.params;
        const { transcriberId, reason } = req.body;

        if (!submissionId || !transcriberId) {
            return res.status(400).json({ error: 'Submission ID and Transcriber ID are required.' });
        }

        // 1. Update test_submissions status to 'rejected'
        const { data: updatedSubmission, error: submissionError } = await supabase
            .from('test_submissions')
            .update({ status: 'rejected', rejection_reason: reason, updated_at: new Date().toISOString() })
            .eq('id', submissionId)
            .eq('user_id', transcriberId) // Ensure we're updating the correct submission
            .select('user_id')
            .single();

        if (submissionError) throw submissionError;
        if (!updatedSubmission) {
            return res.status(404).json({ error: 'Test submission not found or does not belong to the transcriber.' });
        }

        // 2. Update transcriber's profile status to 'rejected'
        const { error: profileUpdateError } = await supabase
            .from('transcribers') // Update the 'transcribers' table
            .update({ status: 'rejected', updated_at: new Date().toISOString() })
            .eq('id', transcriberId);

        if (profileUpdateError) throw profileUpdateError;

        // --- SEND REJECTION EMAIL TO TRANSCRIBER ---
        // Fetch transcriber details to send the email
        const { data: transcriberDetails, error: transcriberDetailsError } = await supabase
            .from('users') // Fetch from 'users' table for email and name
            .select('id, email, full_name')
            .eq('id', transcriberId)
            .single();
        
        if (transcriberDetailsError) {
            console.error(`Error fetching transcriber details for email for ID ${transcriberId}:`, transcriberDetailsError);
            // Continue without blocking the response, but log the error
        } else if (transcriberDetails && transcriberDetails.email) {
            await emailService.sendTranscriberTestResultEmail(transcriberDetails, 'rejected', reason);
        }
        // --- END OF EMAIL INTEGRATION ---

        res.json({ message: 'Transcriber test rejected and status updated.' });
    } catch (error) {
        console.error('Error rejecting transcriber test:', error);
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
    getAllUsersForAdmin,
    getUserByIdForAdmin, // Admin-specific user fetch
    getAnyUserById,       // NEW: Generic user fetch
    approveTranscriberTest,
    rejectTranscriberTest,
};
