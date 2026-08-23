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
        if (errorData && errorData.error && errorData.error.code === 190) {
            console.error('\n⚠️ [WHATSAPP API TOKEN EXPIRED] Meta Graph API returned Error 190 (Session/Token Expired).');
            console.error('👉 Please generate a fresh Meta Access Token from https://developers.facebook.com and update WHATSAPP_API_TOKEN in .env\n');
        } else {
            console.error('[Meta WhatsApp OTP Template Failed]:', errorData || err.message);
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
        const textErrorData = textErr.response ? textErr.response.data : null;
        if (textErrorData && textErrorData.error && textErrorData.error.code === 190) {
            console.error('\n⚠️ [WHATSAPP API TOKEN EXPIRED] Meta Graph API returned Error 190 (Session/Token Expired).\n');
        } else {
            console.error('[Meta WhatsApp OTP Text Failed]:', textErrorData || textErr.message);
        }
    }

    console.log('[WhatsApp Service Notice]: SMS disabled. OTP logged in console above.');
    return {
        success: true,
        provider: 'whatsapp_console_dev',
        otp: otp
    };
}

/**
 * Sends order confirmation message strictly via Meta WhatsApp Cloud API (SMS service disabled)
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
    console.log(`[STRICT WHATSAPP ORDER CONFIRMATION] Mobile: +91 ${cleanMobile} | Order: ${order.id}`);
    console.log(`==================================================\n`);

    const customerName = order.shipping_name || 'Customer';
    const orderDetailsText = `Order #${order.id} for "${order.book_title || 'Book'}" (Qty: ${order.quantity}, Total: ₹${order.total_amount}) is confirmed!`;

    if (!whatsappApiToken || whatsappApiToken.includes('YOUR_')) {
        console.log('[WhatsApp Service Notice]: whatsapp_api not set in .env. Preview of Order Confirmation:\n' + orderDetailsText);
        return { success: false, provider: 'whatsapp_console_dev', preview: orderDetailsText };
    }

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
        console.error('[Meta WhatsApp Order Confirmation Template Failed]:', err.response ? err.response.data : err.message);
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
        console.error('[Meta WhatsApp Order Confirmation Text Failed]:', err.response ? err.response.data : err.message);
        return { success: false, error: err.message };
    }
}

module.exports = {
    sendWhatsAppOtp,
    sendWhatsAppOrderConfirmation,
    sendWhatsAppBill: sendWhatsAppOrderConfirmation
};
