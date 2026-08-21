const { sendWhatsAppOtp, sendWhatsAppOrderConfirmation } = require('../api/services/whatsappService');

/**
 * Sends real-time OTP via WhatsApp API (replacing SMS OTP for phone verification).
 * @param {string} mobile 10-digit Indian mobile number
 * @param {string} otp 6-digit OTP string
 * @param {string} [name] Customer name
 */
async function sendSmsOtp(mobile, otp, name) {
    return await sendWhatsAppOtp(mobile, otp, name);
}

/**
 * Sends a WhatsApp order confirmation message/bill using WhatsApp API
 * @param {Object} order The complete order object from DB
 * @param {string} mobile Target recipient mobile number
 */
async function sendWhatsAppBill(order, mobile) {
    return await sendWhatsAppOrderConfirmation(order, mobile);
}

module.exports = {
    sendSmsOtp,
    sendWhatsAppBill,
    sendWhatsAppOtp,
    sendWhatsAppOrderConfirmation
};
