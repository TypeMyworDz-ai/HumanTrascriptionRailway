// backend/utils/paymentUtils.js

/**
 * Calculates the transcriber's earning share (80%) from a given total payment amount.
 * @param {number} totalAmount - The total amount paid by the client.
 * @returns {number} The calculated 80% share for the transcriber, rounded to two decimal places.
 */
const calculateTranscriberEarning = (totalAmount) => {
    // Assuming 80% share for the transcriber
    const earning = totalAmount * 0.8;
    return parseFloat(earning.toFixed(2));
};

module.exports = {
    calculateTranscriberEarning,
};
