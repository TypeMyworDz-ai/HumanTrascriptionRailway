// backend/utils/paymentUtils.js

/**
 * Calculates the transcriber's earning from a given payment amount in USD.
 * Assumes a fixed commission rate for the platform.
 * @param {number} totalPaymentUsd The total amount paid by the client in USD.
 * @returns {number} The amount the transcriber earns in USD.
 */
const calculateTranscriberEarning = (totalPaymentUsd) => {
    // Example: Transcriber earns 80% of the total payment
    const transcriberCommissionRate = 0.80;
    return parseFloat((totalPaymentUsd * transcriberCommissionRate).toFixed(2)); // Round to 2 decimal places for currency
};

// Placeholder for USD to KES exchange rate.
// In a production environment, this should be fetched from a reliable, real-time API.
const EXCHANGE_RATE_USD_TO_KES = 145.00; // Example: 1 USD = 145 KES

/**
 * Converts an amount from USD to KES using a predefined exchange rate.
 * @param {number} amountUsd The amount in USD.
 * @returns {number} The converted amount in KES.
 */
const convertUsdToKes = (amountUsd) => {
    return parseFloat((amountUsd * EXCHANGE_RATE_USD_TO_KES).toFixed(2)); // Round to 2 decimal places for currency
};

module.exports = {
    calculateTranscriberEarning,
    convertUsdToKes, // Export the new conversion utility
    EXCHANGE_RATE_USD_TO_KES // Export the exchange rate for potential use elsewhere (e.g., in verifyPayment for reverse conversion)
};
