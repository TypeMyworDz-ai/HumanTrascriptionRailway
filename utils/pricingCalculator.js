// backend/utils/pricingCalculator.js - FINALIZED for Audio Quality and robust rule matching

const supabase = require('..//database'); // Assuming '../database' points to your Supabase client

/**
 * Calculates the price per minute based on defined pricing rules.
 * Rules are evaluated in order; the first matching active rule is used.
 * If no specific rule matches, it falls back to a default if available.
 *
 * A pricing rule object should look like this (example):
 * {
 *   id: "unique-id",
 *   name: "Excellent Audio, Urgent Deadline",
 *   audio_quality: "excellent", // Expected values: "excellent", "good", "standard", "difficult"
 *   deadline_type: "urgent",    // Expected values: "flexible", "standard", "urgent"
 *   price_per_minute_usd: 0.75,
 *   min_duration_minutes: 0,
 *   max_duration_minutes: 60,   // null for no max
 *   is_active: true
 * }
 *
 * @param {object} jobParams - Parameters describing the job.
 * @param {string} jobParams.audio_quality - The audio quality of the job (e.g., "excellent", "standard", "difficult").
 * @param {string} jobParams.deadline_type - The desired deadline type (e.g., "flexible", "standard", "urgent").
 * @param {number} jobParams.duration_minutes - The total duration of the audio in minutes.
 * @returns {number|null} The calculated price per minute in USD, or null if no matching rule is found.
 */
const calculatePricePerMinute = async (jobParams) => {
    try {
        // 1. Fetch pricing rules from admin_settings
        const { data: settings, error } = await supabase
            .from('admin_settings')
            .select('pricing_rules')
            .single();

        if (error && error.code !== 'PGRST116') { // Ignore "No rows found" error for initial setup
            console.error('Error fetching admin pricing settings:', error);
            return null; // Or throw, depending on desired error handling
        }

        const pricingRules = settings?.pricing_rules || [];

        // 2. Filter for active rules
        const activeRules = pricingRules.filter(rule => rule.is_active);

        // 3. Sort rules to prioritize more specific matches.
        // Rules with more defined conditions should come first.
        // Heuristic: Audio Quality (most specific) > Deadline Type > Duration Range
        activeRules.sort((a, b) => {
            const getSpecificityScore = (rule) => {
                let score = 0;
                // Higher score for more specific matches
                if (rule.audio_quality) score += 4; 
                if (rule.deadline_type) score += 2; 
                if (typeof rule.min_duration_minutes === 'number' && rule.min_duration_minutes > 0) score += 1;
                if (typeof rule.max_duration_minutes === 'number') score += 1;
                return score;
            };
            return getSpecificityScore(b) - getSpecificityScore(a); // Sort descending by score
        });


        // 4. Find the first matching rule
        for (const rule of activeRules) {
            let matches = true;

            // Match by audio quality (if rule defines it)
            // jobParams.audio_quality should be one of "excellent", "good", "standard", "difficult"
            if (rule.audio_quality && rule.audio_quality !== jobParams.audio_quality) {
                matches = false;
            }

            // Match by deadline type (if rule defines it)
            // jobParams.deadline_type should be one of "flexible", "standard", "urgent"
            if (matches && rule.deadline_type && rule.deadline_type !== jobParams.deadline_type) {
                matches = false;
            }

            // Match by duration (if rule defines min/max)
            const jobDuration = jobParams.duration_minutes;
            if (matches && typeof jobDuration === 'number' && jobDuration > 0) { // Only check duration if it's a valid positive number
                if (typeof rule.min_duration_minutes === 'number' && jobDuration < rule.min_duration_minutes) {
                    matches = false;
                }
                if (matches && typeof rule.max_duration_minutes === 'number' && jobDuration > rule.max_duration_minutes) {
                    matches = false;
                }
            }
            // If the rule has a min_duration > 0 but jobDuration is not provided or invalid, it doesn't match
            else if (matches && typeof rule.min_duration_minutes === 'number' && rule.min_duration_minutes > 0) {
                matches = false;
            }


            if (matches) {
                // Ensure price_per_minute_usd is a valid number before returning
                if (typeof rule.price_per_minute_usd === 'number' && rule.price_per_minute_usd >= 0) {
                    return parseFloat(rule.price_per_minute_usd.toFixed(2)); // Ensure 2 decimal places
                } else {
                    console.warn(`Matching rule found (ID: ${rule.id}) but price_per_minute_usd is invalid: ${rule.price_per_minute_usd}`);
                    // If a rule is invalid, it's better to log and continue to the next rule,
                    // rather than failing or returning an incorrect price.
                }
            }
        }

        // 5. If no specific rule matches, return null or a platform-wide default
        // Consider a robust fallback here, e.g., a hardcoded default or a "no quote available" message.
        console.warn('No matching active pricing rule found for job parameters:', jobParams);
        // You might consider a very basic default rule here if no specific rules match
        // return 0.25; // Example: a very low default price if no rules match
        return null;
    } catch (error) {
        console.error('Error in calculatePricePerMinute:', error);
        return null;
    }
};

module.exports = {
    calculatePricePerMinute,
};
