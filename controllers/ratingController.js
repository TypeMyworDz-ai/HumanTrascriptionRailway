// backend/controllers/ratingController.js

const supabase = require('../database');

// Helper function to calculate and update average rating for a user (transcriber or client)
const updateAverageRating = async (userId, userType) => {
    try {
        const { data: ratings, error: fetchRatingsError } = await supabase
            .from('ratings')
            .select('score')
            .eq('rated_user_id', userId)
            .eq('rated_user_type', userType);

        if (fetchRatingsError) throw fetchRatingsError;

        if (ratings.length === 0) {
            // If no ratings, set to default (e.g., 0 or 5 depending on initial assumption)
            const { error: updateError } = await supabase
                .from(userType === 'transcriber' ? 'transcribers' : 'clients')
                .update({ average_rating: 0 }) // Default to 0 if no ratings
                .eq('id', userId);
            if (updateError) throw updateError;
            return 0;
        }

        const totalScore = ratings.reduce((sum, rating) => sum + rating.score, 0);
        const newAverage = parseFloat((totalScore / ratings.length).toFixed(1));

        const { error: updateError } = await supabase
            .from(userType === 'transcriber' ? 'transcribers' : 'clients')
            .update({ average_rating: newAverage, updated_at: new Date().toISOString() })
            .eq('id', userId);

        if (updateError) throw updateError;

        console.log(`Updated ${userType} ${userId} average rating to ${newAverage}`);
        return newAverage;

    } catch (error) {
        console.error(`Error updating average rating for ${userType} ${userId}:`, error);
        throw error;
    }
};


// --- Rating Functions ---

// Client rates a Transcriber after a completed negotiation
const rateTranscriber = async (req, res) => {
    const { negotiationId, score, comment } = req.body;
    const clientId = req.user.userId;

    if (!negotiationId || !score || score < 1 || score > 5) {
        return res.status(400).json({ error: 'Negotiation ID and a score between 1 and 5 are required.' });
    }

    try {
        // 1. Verify the negotiation is completed and belongs to the client
        const { data: negotiation, error: negError } = await supabase
            .from('negotiations')
            .select('id, client_id, transcriber_id, status')
            .eq('id', negotiationId)
            .eq('client_id', clientId)
            .single();

        if (negError || !negotiation) {
            console.error('Error fetching negotiation for rating:', negError);
            return res.status(404).json({ error: 'Negotiation not found or not accessible.' });
        }

        if (negotiation.status !== 'completed') {
            return res.status(400).json({ error: 'Only completed negotiations can be rated.' });
        }

        // 2. Check if the client has already rated this negotiation
        const { data: existingRating, error: existingRatingError } = await supabase
            .from('ratings')
            .select('id')
            .eq('rater_id', clientId)
            .eq('negotiation_id', negotiationId)
            .eq('rated_user_id', negotiation.transcriber_id)
            .single();

        if (existingRating) {
            return res.status(409).json({ error: 'You have already rated this transcriber for this negotiation.' });
        }

        // 3. Record the rating
        const { data: ratingRecord, error: ratingError } = await supabase
            .from('ratings')
            .insert({
                rater_id: clientId,
                rater_type: 'client',
                rated_user_id: negotiation.transcriber_id,
                rated_user_type: 'transcriber',
                negotiation_id: negotiationId,
                score: score,
                comment: comment || null
            })
            .select()
            .single();

        if (ratingError) {
            console.error('Error recording transcriber rating:', ratingError);
            throw ratingError;
        }

        // 4. Update the transcriber's average rating
        const newAverageRating = await updateAverageRating(negotiation.transcriber_id, 'transcriber');

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
    const adminId = req.user.userId;

    if (!clientId || !score || score < 1 || score > 5) {
        return res.status(400).json({ error: 'Client ID and a score between 1 and 5 are required.' });
    }

    try {
        // 1. Verify the client exists
        const { data: clientUser, error: clientError } = await supabase
            .from('users')
            .select('id, user_type')
            .eq('id', clientId)
            .eq('user_type', 'client')
            .single();

        if (clientError || !clientUser) {
            return res.status(404).json({ error: 'Client not found.' });
        }

        // 2. Check if this admin has already rated this client (for simplicity, one admin rating per client)
        const { data: existingRating, error: existingRatingError } = await supabase
            .from('ratings')
            .select('id')
            .eq('rater_id', adminId)
            .eq('rated_user_id', clientId)
            .single();

        if (existingRating) {
            // Option: Allow admin to update their rating instead of rejecting
            // For now, let's keep it simple and return error
            return res.status(409).json({ error: 'You have already rated this client.' });
        }


        // 3. Record the rating
        const { data: ratingRecord, error: ratingError } = await supabase
            .from('ratings')
            .insert({
                rater_id: adminId,
                rater_type: 'admin',
                rated_user_id: clientId,
                rated_user_type: 'client',
                score: score,
                comment: comment || null
            })
            .select()
            .single();

        if (ratingError) {
            console.error('Error recording client rating by admin:', ratingError);
            throw ratingError;
        }

        // 4. Update the client's average rating
        const newAverageRating = await updateAverageRating(clientId, 'client');

        res.status(201).json({
            message: 'Client rated successfully by admin!',
            rating: ratingRecord,
            newAverageRating: newAverageRating
        });

    } catch (error) {
        console.error('Server error rating client by admin:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error rating client by admin.' });
    }
};

// Get a Transcriber's ratings and comments
const getTranscriberRatings = async (req, res) => {
    const { transcriberId } = req.params;

    try {
        // 1. Fetch transcriber's profile to get average rating
        const { data: transcriberProfile, error: profileError } = await supabase
            .from('transcribers')
            .select('average_rating')
            .eq('id', transcriberId)
            .single();

        if (profileError || !transcriberProfile) {
            return res.status(404).json({ error: 'Transcriber not found.' });
        }

        // 2. Fetch all ratings and comments for this transcriber
        const { data: ratings, error: ratingsError } = await supabase
            .from('ratings')
            .select(`
                id,
                score,
                comment,
                created_at,
                rater:users!rater_id(full_name)
            `)
            .eq('rated_user_id', transcriberId)
            .eq('rated_user_type', 'transcriber')
            .order('created_at', { ascending: false });

        if (ratingsError) {
            console.error('Error fetching transcriber ratings:', ratingsError);
            throw ratingsError;
        }

        res.status(200).json({
            message: 'Transcriber ratings retrieved successfully.',
            averageRating: transcriberProfile.average_rating,
            ratings: ratings.map(r => ({
                ...r,
                rater_name: r.rater?.full_name || 'Anonymous Client'
            }))
        });

    } catch (error) {
        console.error('Server error fetching transcriber ratings:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error fetching transcriber ratings.' });
    }
};

// Get a Client's rating (primarily from admin)
const getClientRating = async (req, res) => {
    const { clientId } = req.params;

    try {
        // 1. Fetch client's profile to get average rating
        const { data: clientProfile, error: profileError } = await supabase
            .from('clients')
            .select('client_rating:average_rating') // Alias average_rating to client_rating for consistency
            .eq('id', clientId)
            .single();

        if (profileError || !clientProfile) {
            return res.status(404).json({ error: 'Client not found.' });
        }

        // 2. Optionally fetch detailed ratings if needed (e.g., admin comments)
        const { data: ratings, error: ratingsError } = await supabase
            .from('ratings')
            .select(`
                id,
                score,
                comment,
                created_at,
                rater:users!rater_id(full_name)
            `)
            .eq('rated_user_id', clientId)
            .eq('rated_user_type', 'client')
            .order('created_at', { ascending: false });

        if (ratingsError) {
            console.error('Error fetching client ratings:', ratingsError);
            throw ratingsError;
        }


        res.status(200).json({
            message: 'Client rating retrieved successfully.',
            averageRating: clientProfile.client_rating,
            ratings: ratings.map(r => ({
                ...r,
                rater_name: r.rater?.full_name || 'Admin'
            }))
        });

    } catch (error) {
        console.error('Server error fetching client rating:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Server error fetching client rating.' });
    }
};


module.exports = {
    rateTranscriber,
    rateClientByAdmin,
    getTranscriberRatings,
    getClientRating
};
