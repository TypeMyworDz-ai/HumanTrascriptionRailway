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

module.exports = {
    calculateTranscriberEarning,
};
