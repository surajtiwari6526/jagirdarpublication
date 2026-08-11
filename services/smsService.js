const axios = require('axios');

/**
 * Sends real-time OTP via Fast2SMS, Twilio, or logs to server console for development.
 * @param {string} mobile 10-digit Indian mobile number
 * @param {string} otp 6-digit OTP string
 */
async function sendSmsOtp(mobile, otp) {
    const cleanMobile = mobile.replace(/\D/g, '').slice(-10);
    const provider = (process.env.SMS_PROVIDER || 'fast2sms').toLowerCase();
    const fast2smsKey = process.env.FAST2SMS_API_KEY;
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFromPhone = process.env.TWILIO_PHONE_NUMBER;

    console.log(`\n==================================================`);
    console.log(`[REAL-TIME OTP GENERATED] Mobile: +91 ${cleanMobile} | Code: ${otp}`);
    console.log(`==================================================\n`);

    // 1. Fast2SMS Provider (India SMS Gateway)
    if (provider === 'fast2sms' && fast2smsKey && fast2smsKey !== 'YOUR_FAST2SMS_API_KEY_HERE') {
        try {
            // Try Fast2SMS GET OTP API
            const response = await axios({
                method: 'get',
                url: `https://www.fast2sms.com/dev/bulkV2?authorization=${fast2smsKey}&route=otp&variables_values=${otp}&flash=0&numbers=${cleanMobile}`,
                headers: { 'cache-control': 'no-cache' }
            });

            console.log('[Fast2SMS GET API Response]:', response.data);
            if (response.data && response.data.return) {
                return { success: true, provider: 'fast2sms', data: response.data };
            }
        } catch (error) {
            console.error('[Fast2SMS GET Failed]:', error.response ? error.response.data : error.message);
        }

        try {
            // Fallback: Fast2SMS Quick SMS API (route=q)
            const qResponse = await axios({
                method: 'post',
                url: 'https://www.fast2sms.com/dev/bulkV2',
                headers: {
                    'authorization': fast2smsKey,
                    'Content-Type': 'application/json'
                },
                data: {
                    "route": "q",
                    "message": `Your Jagirdar Publications verification OTP is: ${otp}. Valid for 5 minutes.`,
                    "language": "english",
                    "flash": 0,
                    "numbers": cleanMobile
                }
            });

            console.log('[Fast2SMS Quick SMS Response]:', qResponse.data);
            if (qResponse.data && qResponse.data.return) {
                return { success: true, provider: 'fast2sms_q', data: qResponse.data };
            }
        } catch (qError) {
            console.error('[Fast2SMS Quick SMS Failed]:', qError.response ? qError.response.data : qError.message);
        }
    }

    // 2. Twilio SMS Provider (Global SMS Gateway)
    if (provider === 'twilio' && twilioSid && twilioAuthToken && twilioFromPhone) {
        try {
            const auth = Buffer.from(`${twilioSid}:${twilioAuthToken}`).toString('base64');
            const params = new URLSearchParams();
            params.append('To', `+91${cleanMobile}`);
            params.append('From', twilioFromPhone);
            params.append('Body', `Your Jagirdar Publications verification OTP is: ${otp}. Valid for 5 minutes.`);

            const response = await axios.post(
                `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
                params.toString(),
                {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            console.log('[Twilio API Response]:', response.data.sid);
            return { success: true, provider: 'twilio', sid: response.data.sid };
        } catch (error) {
            console.error('[Twilio Error]:', error.response ? error.response.data : error.message);
        }
    }

    // Fallback: Console mode for development
    console.log('[SMS Notice]: No active SMS Gateway API key set in .env. OTP logged above in console.');
    return {
        success: true,
        provider: 'console_dev',
        otp: otp
    };
}

/**
 * Sends a WhatsApp text bill/invoice using Twilio WhatsApp API
 * @param {Object} order The complete order object from DB
 * @param {string} mobile Target recipient mobile number
 */
async function sendWhatsAppBill(order, mobile) {
    if (!mobile) return { success: false, error: 'No mobile number provided' };
    const cleanMobile = mobile.replace(/\D/g, '').slice(-10);

    console.log(`\n==================================================`);
    console.log(`[WHATSAPP INVOICE GENERATED] Mobile: +91 ${cleanMobile} | Order: ${order.id}`);
    console.log(`==================================================\n`);

    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    // Twilio WhatsApp numbers typically use the format 'whatsapp:+14155238886'
    const twilioWhatsAppFrom = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';

    const messageBody = `📚 *Jagirdar Publications* 📚\nNamaste ${order.shipping_name || 'Customer'}, your order is confirmed!\n\n*Order ID:* #${order.id}\n*Item:* ${order.book_title || 'Book Title'} (Qty: ${order.quantity})\n*Total Amount:* ₹${order.total_amount}\n\nYou can download your complete PDF invoice from your account dashboard on our website. Thank you for your purchase!`;

    if (twilioSid && twilioAuthToken) {
        try {
            const auth = Buffer.from(`${twilioSid}:${twilioAuthToken}`).toString('base64');
            const params = new URLSearchParams();
            params.append('To', `whatsapp:+91${cleanMobile}`);
            params.append('From', twilioWhatsAppFrom);
            params.append('Body', messageBody);

            const response = await axios.post(
                `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
                params.toString(),
                {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            console.log('[Twilio WhatsApp Response]:', response.data.sid);
            return { success: true, provider: 'twilio_whatsapp', sid: response.data.sid };
        } catch (error) {
            console.error('[Twilio WhatsApp Error]:', error.response ? error.response.data : error.message);
        }
    } else {
        console.log('[WhatsApp Notice]: Twilio credentials not set in .env. WhatsApp Bill not sent over API.');
        console.log('[WhatsApp Preview]:\n' + messageBody);
    }

    return { success: false, error: 'WhatsApp API not configured' };
}

module.exports = { sendSmsOtp, sendWhatsAppBill };

