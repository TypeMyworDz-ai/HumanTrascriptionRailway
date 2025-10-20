const supabase = require('../database');

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

        // Calculate the new average rating
        const defaultRating = 5.0; // Default to 5.0 for new/unrated users
        const newAverage = ratings.length > 0
            ? parseFloat((ratings.reduce((sum, rating) => sum + rating.score, 0) / ratings.length).toFixed(1))
            : defaultRating; // Calculate average or use default if no ratings

        // Check if the profile (transcriber or client) exists
        const profileTable = userType === 'transcriber' ? 'transcribers' : 'clients';
        const { data: existingProfile, error: fetchProfileError } = await supabase
            .from(profileTable)
            .select('id')
            .eq('id', userId)
            .single();

        if (fetchProfileError && fetchProfileError.code !== 'PGRST116') { // PGRST116 means "No rows found"
            console.error(`[updateAverageRating] Error checking existing ${userType} profile for ${userId}:`, fetchProfileError);
            throw fetchProfileError;
        }

        if (existingProfile) {
            // Profile exists, update it
            const { error: updateError } = await supabase
                .from(profileTable)
                .update({ average_rating: newAverage, updated_at: new Date().toISOString() })
                .eq('id', userId);
            if (updateError) throw updateError;
            console.log(`[updateAverageRating] Updated existing ${userType} ${userId} average rating to ${newAverage}`);
        } else {
            // Profile does not exist, insert a new one
            const { error: insertError } = await supabase
                .from(profileTable)
                .insert([
                    { id: userId, average_rating: newAverage, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
                ]);
            if (insertError) throw insertError;
            console.log(`[updateAverageRating] Created new ${userType} ${userId} profile with average rating ${newAverage}`);
        }

        return newAverage; // Return the calculated average rating

    } catch (error) {
        console.error(`[updateAverageRating] Error updating average rating for ${userType} ${userId}:`, error);
        throw error; // Re-throw the error to be handled by the calling function
    }
};

// --- Rating Functions ---

// Client rates a Transcriber after a completed negotiation - REMOVED as per instructions.
// This functionality is delegated to admins.

// NEW: Admin rates a user (Client or Transcriber)
const rateUserByAdmin = async (req, res) => {
    const { ratedUserId, ratedUserType, score, comment } = req.body;
    const adminId = req.user.userId; // The admin making the rating

    // Validate input: ratedUserId, ratedUserType, and score (1-5) are required
    if (!ratedUserId || !ratedUserType || !score || score < 1 || score > 5) {
        return res.status(400).json({ error: 'Rated User ID, User Type, and a score between 1 and 5 are required.' });
    }
    if (!['client', 'transcriber'].includes(ratedUserType)) {
        return res.status(400).json({ error: 'Invalid user type for rating. Must be "client" or "transcriber".' });
    }

    try {
        // 1. Verify the user exists and is of the specified type
        const { data: userToRate, error: userError } = await supabase
            .from('users')
            .select('id, user_type') // Check user type to ensure it's correct
            .eq('id', ratedUserId)
            .eq('user_type', ratedUserType)
            .single();

        if (userError || !userToRate) {
            console.error(`[rateUserByAdmin] User to rate not found or is not of type ${ratedUserType}:`, userError);
            return res.status(404).json({ error: `User (type: ${ratedUserType}) not found.` });
        }

        // 2. Check if this admin has already rated this user
        const { data: existingRating, error: existingRatingError } = await supabase
            .from('ratings')
            .select('id')
            .eq('rater_id', adminId) // The admin rating
            .eq('rated_user_id', ratedUserId) // The user being rated
            .eq('rater_type', 'admin') // Ensure the rater type is admin
            .eq('rated_user_type', ratedUserType) // For this specific user type
            .single();

        if (existingRatingError && existingRatingError.code !== 'PGRST116') { // PGRST116 means "No rows found"
            console.error('[rateUserByAdmin] Error checking existing rating:', existingRatingError);
            throw existingRatingError;
        }

        let ratingRecord;
        if (existingRating) {
            // If an existing rating is found, update it
            const { data: updatedRating, error: updateRatingError } = await supabase
                .from('ratings')
                .update({ score: score, comment: comment || null, updated_at: new Date().toISOString() })
                .eq('id', existingRating.id)
                .select()
                .single();

            if (updateRatingError) {
                console.error('[rateUserByAdmin] Error updating existing user rating by admin:', updateRatingError);
                throw updateRatingError;
            }
            ratingRecord = updatedRating;
            console.log(`[rateUserByAdmin] Updated existing rating for ${ratedUserType} ${ratedUserId} by admin ${adminId}.`);
        } else {
            // If no existing rating, create a new one
            const { data: newRating, error: createRatingError } = await supabase
                .from('ratings')
                .insert([
                    {
                        rater_id: adminId,
                        rater_type: 'admin', // The rater is an admin
                        rated_user_id: ratedUserId,
                        rated_user_type: ratedUserType, // The type of user being rated
                        score: score,
                        comment: comment || null
                    }
                ])
                .select() // Return the inserted rating record
                .single();

            if (createRatingError) {
                console.error('[rateUserByAdmin] Error recording new user rating by admin:', createRatingError);
                throw createRatingError;
            }
            ratingRecord = newRating;
            console.log(`[rateUserByAdmin] Recorded new rating for ${ratedUserType} ${ratedUserId} by admin ${adminId}.`);
        }

        // 4. Update the user's average rating using the helper function
        const newAverageRating = await updateAverageRating(ratedUserId, ratedUserType);

        // Respond with success message, rating details, and the new average rating
        res.status(201).json({
            message: `${ratedUserType} rating adjusted successfully by admin!`,
            rating: ratingRecord,
            newAverageRating: newAverageRating
        });

    } catch (error) {
        console.error(`[rateUserByAdmin] Server error rating user by admin:`, error.response ? error.response.data : error.message);
        res.status(500).json({ error: `Server error adjusting ${ratedUserType} rating by admin.` });
    }
};

// Get a Transcriber's ratings and comments (primarily from clients, now potentially from admins)
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
            console.warn(`[getTranscriberRatings] Transcriber profile for ID ${transcriberId} not found. Defaulting rating to 0.`);
            return res.status(200).json({ // Return 200 with default if profile not found
                message: 'Transcriber not found or no rating available, defaulting to 0.0.',
                averageRating: 0.0,
                ratings: []
            });
        }
        console.log(`[getTranscriberRatings] Raw transcriber profile data for ${transcriberId}:`, transcriberProfile);


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
            console.error('[getTranscriberRatings] Error fetching transcriber ratings:', ratingsError);
            throw ratingsError;
        }

        // Format ratings to include rater's name, providing a default if missing
        const formattedRatings = ratings.map(r => ({
            ...r,
            rater_name: r.rater?.full_name || 'Anonymous' // Default name if rater info is missing
        }));

        // Respond with the average rating and the list of individual ratings
        res.status(200).json({
            message: 'Transcriber ratings retrieved successfully.',
            averageRating: transcriberProfile.average_rating,
            ratings: formattedRatings
        });

    } catch (error) {
        console.error(`[getTranscriberRatings] Server error fetching transcriber ratings:`, error.response ? error.response.data : error.message);
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
            .select('average_rating') // FIX: Select 'average_rating' directly
            .eq('id', clientId)
            .single();

        if (profileError || !clientProfile) {
            console.warn(`[getClientRating] Client profile for ID ${clientId} not found. Defaulting rating to 5.0.`);
            // Return default 5.0 if client not found or no profile, so it doesn't break UI
            return res.status(200).json({
                message: 'Client not found or no rating available, defaulting to 5.0.',
                averageRating: 5.0,
                ratings: []
            });
        }
        console.log(`[getClientRating] Raw client profile data for ${clientId}:`, clientProfile);


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
            console.error('[getClientRating] Error fetching client ratings:', ratingsError);
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
            averageRating: clientProfile.average_rating, // FIX: Use average_rating directly
            ratings: formattedRatings
        });

    } catch (error) {
        console.error(`[getClientRating] Server error fetching client rating:`, error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error fetching client rating.' });
    }
};


module.exports = {
    updateAverageRating, // Export the helper function for use in other controllers
    rateUserByAdmin, // Export the new generic admin rating function
    getTranscriberRatings,
    getClientRating
};
