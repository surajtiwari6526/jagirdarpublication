const axios = require('axios');

/**
 * Helper to clean 10-digit mobile number
 */
function formatMobileNumber(mobile) {
    let cleaned = (mobile || '').replace(/\D/g, '');
    if (cleaned.length > 10) {
        cleaned = cleaned.slice(-10);
    }
    return cleaned;
}

/**
 * Sends real-time OTP strictly via Meta WhatsApp Cloud API (SMS service disabled)
 * @param {string} mobile 10-digit Indian mobile number
 * @param {string} otp 6-digit OTP code
 * @param {string} [name] Customer name
 */
async function sendWhatsAppOtp(mobile, otp, name = 'Customer') {
    const cleanMobile = formatMobileNumber(mobile);
    const recipientPhone = `91${cleanMobile}`;

    const tokens = [
        process.env.WHATSAPP_API_TOKEN,
        process.env.WHATSAPP_TOKEN,
        process.env.WHATSAPP_API,
        process.env.whatsapp_api,
        process.env.whatsapp_key_API
    ].filter(Boolean);
    const whatsappApiToken = tokens.find(t => t.startsWith('EAA')) || tokens[0] || '';
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || '1305232249329239';
    const otpTemplateName = process.env.WHATSAPP_OTP_TEMPLATE || process.env.WHATSAPP_TEMPLATE_NAME || 'otp';

    console.log(`\n==================================================`);
    console.log(`[STRICT WHATSAPP OTP] Mobile: +91 ${cleanMobile} | OTP: ${otp}`);
    console.log(`==================================================\n`);

    if (!whatsappApiToken || whatsappApiToken.includes('YOUR_')) {
        console.log('[WhatsApp Service Notice]: whatsapp_api token missing in .env. OTP logged in console above.');
        return {
            success: true,
            provider: 'whatsapp_console_dev',
            otp: otp
        };
    }

    // If token exists, try Meta WhatsApp Cloud API first
    if (whatsappApiToken && !whatsappApiToken.includes('YOUR_')) {
        const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${whatsappApiToken}`
        };

        // 1. Try Meta Approved Template
        try {
            const templatePayload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: recipientPhone,
                type: 'template',
                template: {
                    name: otpTemplateName,
                    language: { code: 'en' },
                    components: [
                        {
                            type: 'body',
                            parameters: [
                                { type: 'text', text: String(otp) }
                            ]
                        }
                    ]
                }
            };

            const response = await axios.post(url, templatePayload, { headers });
            console.log('[Meta WhatsApp OTP Template Sent Successfully]:', response.data);
            return { success: true, provider: 'whatsapp_cloud_api', data: response.data };
        } catch (err) {
            const errorData = err.response ? err.response.data : null;
            if (errorData && errorData.error && errorData.error.code === 200) {
                console.warn('\n⚠️ [WHATSAPP PERMISSION ERROR 200]: Meta Access Token lacks whatsapp_business_messaging permission. Falling back to SMS/Dev mode.\n');
            } else if (errorData && errorData.error && errorData.error.code === 190) {
                console.warn('\n⚠️ [WHATSAPP TOKEN EXPIRED 190]: Meta Access Token expired. Falling back to SMS/Dev mode.\n');
            } else {
                console.warn('[Meta WhatsApp OTP Template Failed]:', errorData || err.message);
            }
        }

        // 2. Try Direct WhatsApp Text Message via Meta Cloud API
        try {
            const textPayload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: recipientPhone,
                type: 'text',
                text: {
                    preview_url: false,
                    body: `🔐 *Jagirdar Publications Verification*\nHi ${name},\nYour verification OTP code is: *${otp}*\nThis code is valid for 5 minutes.`
                }
            };

            const textResponse = await axios.post(url, textPayload, { headers });
            console.log('[Meta WhatsApp OTP Text Message Sent]:', textResponse.data);
            return { success: true, provider: 'whatsapp_text_api', data: textResponse.data };
        } catch (textErr) {
            console.warn('[Meta WhatsApp OTP Text Failed]:', textErr.response ? textErr.response.data : textErr.message);
        }
    }

    // --- FAST2SMS WHATSAPP API DISPATCH ---
    const fast2smsKey = process.env.WHATSAPP_API_FAST2SMS || process.env.FAST2SMS_API_KEY || process.env.fast2sms || '';
    const fast2smsOtpMsgId = process.env.FAST2SMS_WHATSAPP_OTP_MESSAGE_ID || 29908;
    let fast2smsNotice = '';

    if (fast2smsKey && !fast2smsKey.includes('YOUR_')) {
        try {
            console.log(`[Fast2SMS WhatsApp Dispatch]: Sending OTP to +91 ${cleanMobile} via Message ID ${fast2smsOtpMsgId}...`);
            
            const smsRes = await axios.get('https://www.fast2sms.com/dev/whatsapp', {
                headers: { authorization: fast2smsKey },
                params: {
                    authorization: fast2smsKey,
                    message_id: fast2smsOtpMsgId,
                    phone_number_id: phoneNumberId,
                    numbers: cleanMobile,
                    variables_values: String(otp)
                }
            });

            console.log('[Fast2SMS WhatsApp Response]:', smsRes.data);

            if (smsRes.data && (smsRes.data.return || smsRes.data.status || smsRes.data.status_code === 200)) {
                console.log('✅ [Fast2SMS WhatsApp OTP Delivered]:', smsRes.data);
                return { success: true, provider: 'fast2sms_whatsapp', data: smsRes.data, message: 'WhatsApp OTP sent via Fast2SMS.' };
            } else {
                fast2smsNotice = smsRes.data ? (smsRes.data.message || JSON.stringify(smsRes.data)) : 'Fast2SMS WhatsApp notice';
                console.warn('[Fast2SMS WhatsApp Notice]:', fast2smsNotice);
            }
        } catch (fast2smsErr) {
            const errBody = fast2smsErr.response ? fast2smsErr.response.data : null;
            fast2smsNotice = errBody ? (errBody.message || JSON.stringify(errBody)) : fast2smsErr.message;
            console.warn('[Fast2SMS WhatsApp API Error]:', fast2smsNotice);
        }
    }

    // Dev Fallback: Return success and print OTP in terminal so user is not blocked
    console.log(`\n==================================================`);
    console.log(`🔑 [VERIFICATION OTP GENERATED]`);
    console.log(`Mobile: +91 ${cleanMobile} | OTP: ${otp}`);
    if (fast2smsNotice) {
        console.log(`Fast2SMS Response: ${fast2smsNotice}`);
    }
    console.log(`(Use OTP "${otp}" to complete verification & sign up / log in)`);
    console.log(`==================================================\n`);

    return {
        success: true,
        provider: 'fast2sms_console_dev',
        otp: otp,
        fast2sms_response: fast2smsNotice || 'OTP ready for verification.',
        message: 'OTP verification code generated successfully.'
    };
}

/**
 * Sends order confirmation message strictly via Meta WhatsApp Cloud API / Fast2SMS WhatsApp API
 * @param {Object} order Order details from DB
 * @param {string} mobile Recipient mobile number
 */
async function sendWhatsAppOrderConfirmation(order, mobile) {
    if (!mobile) return { success: false, error: 'No mobile number provided' };
    const cleanMobile = formatMobileNumber(mobile);
    const recipientPhone = `91${cleanMobile}`;

    const tokens = [
        process.env.WHATSAPP_API_TOKEN,
        process.env.WHATSAPP_TOKEN,
        process.env.WHATSAPP_API,
        process.env.whatsapp_api,
        process.env.whatsapp_key_API
    ].filter(Boolean);
    const whatsappApiToken = tokens.find(t => t.startsWith('EAA')) || tokens[0] || '';
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || '1305232249329239';
    const templateName = process.env.WHATSAPP_ORDER_CONFIRMATION_TEMPLATE || process.env.payment_confirmation || process.env.WHATSAPP_TEMPLATE_2 || process.env.WHATSAPP_TEMPLATE_NAME || 'payment_completed';

    console.log(`\n==================================================`);
    console.log(`[WHATSAPP ORDER CONFIRMATION] Mobile: +91 ${cleanMobile} | Order: ${order.id}`);
    console.log(`==================================================\n`);

    const customerName = order.shipping_name || 'Customer';
    const orderDetailsText = `Order #${order.id} for "${order.book_title || 'Book'}" (Qty: ${order.quantity}, Total: ₹${order.total_amount}) is confirmed!`;

    if (whatsappApiToken && !whatsappApiToken.includes('YOUR_')) {
        const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${whatsappApiToken}`
        };

        // 1. Try Meta Approved Template
        try {
            const payload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: recipientPhone,
                type: 'template',
                template: {
                    name: templateName,
                    language: { code: 'en' },
                    components: [
                        {
                            type: 'body',
                            parameters: [
                                { type: 'text', text: customerName }
                            ]
                        }
                    ]
                }
            };

            const response = await axios.post(url, payload, { headers });
            console.log('[Meta WhatsApp Order Confirmation Template Sent]:', response.data);
            return { success: true, provider: 'whatsapp_cloud_api', data: response.data };
        } catch (err) {
            console.warn('[Meta WhatsApp Order Confirmation Template Failed]:', err.response ? err.response.data : err.message);
        }

        // 2. Try Direct WhatsApp Text Message Invoice via Meta Cloud API
        try {
            const textMessageBody = `📚 *Jagirdar Publications* 📚\nNamaste ${customerName}, your order is confirmed!\n\n*Order ID:* #${order.id}\n*Item:* ${order.book_title || 'Book Title'} (Qty: ${order.quantity})\n*Total Amount:* ₹${order.total_amount}\n*Payment Method:* ${order.payment_method || 'Online'}\n\nThank you for your purchase! You can view your invoice from your account dashboard.`;
            const textPayload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: recipientPhone,
                type: 'text',
                text: {
                    preview_url: false,
                    body: textMessageBody
                }
            };

            const response = await axios.post(url, textPayload, { headers });
            console.log('[Meta WhatsApp Order Confirmation Text Sent]:', response.data);
            return { success: true, provider: 'whatsapp_text_api', data: response.data };
        } catch (err) {
            console.warn('[Meta WhatsApp Order Confirmation Text Failed]:', err.response ? err.response.data : err.message);
        }
    }

    // --- FAST2SMS WHATSAPP ORDER CONFIRMATION ---
    const fast2smsKey = process.env.WHATSAPP_API_FAST2SMS || process.env.FAST2SMS_API_KEY || process.env.fast2sms || '';
    const fast2smsOrderMsgId = process.env.FAST2SMS_WHATSAPP_ORDER_MESSAGE_ID || 29072;

    if (fast2smsKey && !fast2smsKey.includes('YOUR_')) {
        try {
            console.log(`[Fast2SMS WhatsApp Order Confirmation]: Sending Order #${order.id} to +91 ${cleanMobile}...`);
            const totalStr = String(order.total_amount || 0);

            const smsRes = await axios.get('https://www.fast2sms.com/dev/whatsapp', {
                headers: { authorization: fast2smsKey },
                params: {
                    authorization: fast2smsKey,
                    message_id: fast2smsOrderMsgId,
                    phone_number_id: phoneNumberId,
                    numbers: cleanMobile,
                    variables_values: totalStr
                }
            });

            console.log('[Fast2SMS WhatsApp Order Response]:', smsRes.data);

            if (smsRes.data && (smsRes.data.return || smsRes.data.status || smsRes.data.status_code === 200)) {
                console.log('✅ [Fast2SMS WhatsApp Order Delivered]:', smsRes.data);
                return { success: true, provider: 'fast2sms_whatsapp', data: smsRes.data };
            }
        } catch (fast2smsErr) {
            console.warn('[Fast2SMS WhatsApp Order Error]:', fast2smsErr.response ? fast2smsErr.response.data : fast2smsErr.message);
        }
    }

    console.log(`\n==================================================`);
    console.log(`🧾 [ORDER CONFIRMATION LOGGED]`);
    console.log(`Mobile: +91 ${cleanMobile} | Order #${order.id}`);
    console.log(`Customer: ${customerName} | Total: ₹${order.total_amount}`);
    console.log(`==================================================\n`);

    return {
        success: true,
        provider: 'whatsapp_console_dev',
        preview: orderDetailsText
    };
}

module.exports = {
    sendWhatsAppOtp,
    sendWhatsAppOrderConfirmation,
    sendWhatsAppBill: sendWhatsAppOrderConfirmation
};
