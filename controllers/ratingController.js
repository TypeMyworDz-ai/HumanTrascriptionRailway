const supabase = require('..//database');

// Helper function to calculate and update the average rating for a user (transcriber or client)
const updateAverageRating = async (userId, userType) => {
    try {
        // Fetch all ratings for the specified user and type
        const { data: ratings, error: fetchRatingsError } = await supabase
            .from('ratings')
            .select('score') // Only need the score
            .eq('rated_user_id', userId)
            .eq('rated_user_type', userType); // Filter by user type ('transcriber' or 'client')

        if (fetchRatingsError) throw fetchRatingsError;

        // If no ratings exist, set the average rating to a default (e.g., 0 or 5)
        if (ratings.length === 0) {
            const defaultRating = 5.0; // Default to 5.0 for new/unrated users
            const { error: updateError } = await supabase
                .from(userType === 'transcriber' ? 'transcribers' : 'clients') // Target the correct profile table
                .update({ average_rating: defaultRating }) // Default to 5.0 if no ratings
                .eq('id', userId);
            if (updateError) throw updateError;
            return defaultRating; // Return the default average
        }

        // Calculate the new average rating
        const totalScore = ratings.reduce((sum, rating) => sum + rating.score, 0);
        const newAverage = parseFloat((totalScore / ratings.length).toFixed(1)); // Calculate average and round to 1 decimal place

        // Update the user's profile with the new average rating
        const { error: updateError } = await supabase
            .from(userType === 'transcriber' ? 'transcribers' : 'clients')
            .update({ average_rating: newAverage, updated_at: new Date().toISOString() })
            .eq('id', userId);

        if (updateError) throw updateError;

        console.log(`Updated ${userType} ${userId} average rating to ${newAverage}`);
        return newAverage; // Return the calculated average rating

    } catch (error) {
        console.error(`Error updating average rating for ${userType} ${userId}:`, error);
        throw error; // Re-throw the error to be handled by the calling function
    }
};

// --- Rating Functions ---

// Client rates a Transcriber after a completed negotiation
const rateTranscriber = async (req, res) => {
    const { negotiationId, score, comment } = req.body;
    const clientId = req.user.userId; // The client making the rating

    // Validate input: negotiationId, score (1-5) are required
    if (!negotiationId || !score || score < 1 || score > 5) {
        return res.status(400).json({ error: 'Negotiation ID and a score between 1 and 5 are required.' });
    }

    try {
        // 1. Verify the negotiation: Ensure it exists, belongs to the client, and is completed
        const { data: negotiation, error: negError } = await supabase
            .from('negotiations')
            .select('id, client_id, transcriber_id, status')
            .eq('id', negotiationId)
            .eq('client_id', clientId) // Ensure the logged-in user is the client
            .single();

        if (negError || !negotiation) {
            console.error('Error fetching negotiation for rating:', negError);
            return res.status(404).json({ error: 'Negotiation not found or not accessible.' });
        }

        // Ensure the negotiation is completed before allowing rating
        if (negotiation.status !== 'completed') {
            return res.status(400).json({ error: 'Only completed negotiations can be rated.' });
        }

        // 2. Check if the client has already rated this negotiation/transcriber
        const { data: existingRating, error: existingRatingError } = await supabase
            .from('ratings')
            .select('id')
            .eq('rater_id', clientId) // The client rating this
            .eq('negotiation_id', negotiationId) // For this specific negotiation
            .eq('rated_user_id', negotiation.transcriber_id) // The transcriber being rated
            .single();

        if (existingRating) {
            // Prevent duplicate ratings for the same negotiation
            return res.status(409).json({ error: 'You have already rated this transcriber for this negotiation.' });
        }

        // 3. Record the new rating in the 'ratings' table
        const { data: ratingRecord, error: ratingError } = await supabase
            .from('ratings')
            .insert([
                {
                    rater_id: clientId,
                    rater_type: 'client', // The rater is a client
                    rated_user_id: negotiation.transcriber_id, // The user being rated
                    rated_user_type: 'transcriber', // The type of user being rated
                    negotiation_id: negotiationId,
                    score: score,
                    comment: comment || null // Store comment if provided, otherwise null
                }
            ])
            .select() // Return the inserted rating record
            .single();

        if (ratingError) {
            console.error('Error recording transcriber rating:', ratingError);
            throw ratingError;
        }

        // 4. Update the transcriber's average rating using the helper function
        const newAverageRating = await updateAverageRating(negotiation.transcriber_id, 'transcriber');

        // Respond with success message, the rating record, and the new average rating
        res.status(201).json({
            message: 'Transcriber rated successfully!',
            rating: ratingRecord,
            newAverageRating: newAverageRating
        });

    } catch (error) {
        console.error('Server error rating transcriber:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error rating transcriber.' });
    }
};

// Admin rates a Client
const rateClientByAdmin = async (req, res) => {
    const { clientId, score, comment } = req.body;
    const adminId = req.user.userId; // The admin making the rating

    // Validate input: clientId and score (1-5) are required
    if (!clientId || !score || score < 1 || score > 5) {
        return res.status(400).json({ error: 'Client ID and a score between 1 and 5 are required.' });
    }

    try {
        // 1. Verify the client exists and is indeed a client
        const { data: clientUser, error: clientError } = await supabase
            .from('users')
            .select('id, user_type') // Check user type to ensure it's a client
            .eq('id', clientId)
            .eq('user_type', 'client')
            .single();

        if (clientError || !clientUser) {
            console.error('Client not found or is not a client:', clientError);
            return res.status(404).json({ error: 'Client not found.' });
        }

        // 2. Check if this admin has already rated this client (simple check: prevent duplicate ratings by the same admin)
        const { data: existingRating, error: existingRatingError } = await supabase
            .from('ratings')
            .select('id')
            .eq('rater_id', adminId) // The admin rating
            .eq('rated_user_id', clientId) // The client being rated
            .eq('rater_type', 'admin') // Ensure the rater type is admin
            .single();

        if (existingRating) {
            // Currently preventing duplicate ratings. Could be extended to allow updates.
            return res.status(409).json({ error: 'You have already rated this client.' });
        }

        // 3. Record the rating from the admin
        const { data: ratingRecord, error: ratingError } = await supabase
            .from('ratings')
            .insert([
                {
                    rater_id: adminId,
                    rater_type: 'admin', // The rater is an admin
                    rated_user_id: clientId,
                    rated_user_type: 'client', // The user being rated is a client
                    score: score,
                    comment: comment || null
                }
            ])
            .select() // Return the inserted rating record
            .single();

        if (ratingError) {
            console.error('Error recording client rating by admin:', ratingError);
            throw ratingError;
        }

        // 4. Update the client's average rating using the helper function
        const newAverageRating = await updateAverageRating(clientId, 'client');

        // Respond with success message, rating details, and the new average rating
        res.status(201).json({
            message: 'Client rated successfully by admin!',
            rating: ratingRecord,
            newAverageRating: newAverageRating
        });

    } catch (error) {
        console.error('Server error rating client by admin:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error rating client by admin.!' });
    }
};

// Get a Transcriber's ratings and comments (primarily from clients)
const getTranscriberRatings = async (req, res) => {
    const { transcriberId } = req.params;

    try {
        // 1. Fetch the transcriber's average rating from their profile
        const { data: transcriberProfile, error: profileError } = await supabase
            .from('transcribers')
            .select('average_rating') // Get the pre-calculated average rating
            .eq('id', transcriberId)
            .single();

        if (profileError || !transcriberProfile) {
            return res.status(404).json({ error: 'Transcriber not found.' });
        }

        // 2. Fetch all individual ratings and comments for this transcriber
        const { data: ratings, error: ratingsError } = await supabase
            .from('ratings')
            .select(`
                id,
                score,
                comment,
                created_at,
                rater:users!rater_id(full_name) -- Join with users to get the rater's name
            `)
            .eq('rated_user_id', transcriberId) // Filter by the transcriber being rated
            .eq('rated_user_type', 'transcriber') // Ensure it's a rating for a transcriber
            .order('created_at', { ascending: false }); // Order ratings by date

        if (ratingsError) {
            console.error('Error fetching transcriber ratings:', ratingsError);
            throw ratingsError;
        }

        // Format ratings to include rater's name, providing a default if missing
        const formattedRatings = ratings.map(r => ({
            ...r,
            rater_name: r.rater?.full_name || 'Anonymous Client' // Default name if rater info is missing
        }));

        // Respond with the average rating and the list of individual ratings
        res.status(200).json({
            message: 'Transcriber ratings retrieved successfully.',
            averageRating: transcriberProfile.average_rating,
            ratings: formattedRatings
        });

    } catch (error) {
        console.error('Server error fetching transcriber ratings:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error fetching transcriber ratings.' });
    }
};

// Get a Client's rating (primarily from admin ratings, but could include client ratings if implemented)
const getClientRating = async (req, res) => {
    const { clientId } = req.params;

    try {
        // 1. Fetch the client's average rating from their profile
        const { data: clientProfile, error: profileError } = await supabase
            .from('clients')
            .select('client_rating:average_rating') // Alias average_rating to client_rating for consistency
            .eq('id', clientId)
            .single();

        if (profileError || !clientProfile) {
            // Return default 5.0 if client not found or no profile, so it doesn't break UI
            return res.status(200).json({
                message: 'Client not found or no rating available, defaulting to 5.0.',
                averageRating: 5.0,
                ratings: []
            });
        }

        // 2. Fetch detailed ratings for the client (e.g., from admin ratings)
        const { data: ratings, error: ratingsError } = await supabase
            .from('ratings')
            .select(`
                id,
                score,
                comment,
                created_at,
                rater:users!rater_id(full_name) -- Join to get the rater's name (likely admin)
            `)
            .eq('rated_user_id', clientId) // Filter by the client being rated
            .eq('rated_user_type', 'client') // Ensure it's a rating for a client
            .order('created_at', { ascending: false }); // Order ratings by date

        if (ratingsError) {
            console.error('Error fetching client ratings:', ratingsError);
            throw ratingsError;
        }

        // Format ratings to include rater's name, providing a default
        const formattedRatings = ratings.map(r => ({
            ...r,
            rater_name: r.rater?.full_name || 'Admin' // Default name if rater info is missing
        }));

        // Respond with the average rating and detailed ratings
        res.status(200).json({
            message: 'Client rating retrieved successfully.',
            averageRating: clientProfile.client_rating,
            ratings: formattedRatings
        });

    } catch (error) {
        console.error('Server error fetching client rating:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error fetching client rating.' });
    }
};


module.exports = {
    updateAverageRating, // Export the helper function for use in other controllers
    rateTranscriber,
    rateClientByAdmin,
    getTranscriberRatings,
    getClientRating
};
