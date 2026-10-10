const nodemailer = require('nodemailer');

/**
 * Sends Email Verification OTP via SMTP or logs to console for development
 * @param {string} email Target recipient email address
 * @param {string} otp 6-digit OTP string
 * @param {string} userName Recipient user name
 */
async function sendEmailOtp(email, otp, userName = 'Customer') {
    const cleanEmail = (email || '').trim().toLowerCase();
    
    console.log(`\n==================================================`);
    console.log(`[EMAIL OTP GENERATED] Recipient: ${cleanEmail} | Code: ${otp}`);
    console.log(`==================================================\n`);

    const smtpHost = process.env.SMTP_HOST || process.env.EMAIL_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || '587');
    const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER;
    const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.GMAIL_PASS;

    if (smtpUser && smtpPass) {
        try {
            const transporter = nodemailer.createTransport({
                host: smtpHost || 'smtp.gmail.com',
                port: smtpPort,
                secure: smtpPort === 465,
                auth: {
                    user: smtpUser,
                    pass: smtpPass
                }
            });

            const mailOptions = {
                from: `"Jagirdar Publications" <${smtpUser}>`,
                to: cleanEmail,
                subject: `${otp} is your Email Verification Code - Jagirdar Publications`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                        <div style="background-color: #7A1F1F; color: #ffffff; padding: 24px; text-align: center;">
                            <h1 style="margin: 0; font-size: 24px;">Jagirdar Publications</h1>
                            <p style="margin: 6px 0 0 0; font-size: 14px; color: #eedfc0;">Email Verification Request</p>
                        </div>
                        <div style="padding: 32px; color: #333333;">
                            <p style="font-size: 16px; margin-top: 0;">Namaste <strong>${userName}</strong>,</p>
                            <p style="font-size: 15px; color: #555555; line-height: 1.5;">You requested to verify your email address (<strong>${cleanEmail}</strong>) for your Jagirdar Publications account.</p>
                            
                            <div style="background-color: #fcf9f2; border: 2px dashed #c9a227; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0;">
                                <span style="font-size: 12px; text-transform: uppercase; letter-spacing: 2px; color: #7A1F1F; font-weight: bold;">Your Verification Code</span>
                                <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #7A1F1F; margin-top: 8px;">${otp}</div>
                                <span style="font-size: 12px; color: #888888; display: block; margin-top: 8px;">Valid for 10 minutes</span>
                            </div>

                            <p style="font-size: 13px; color: #777777; line-height: 1.5;">If you did not request this verification, please ignore this email.</p>
                        </div>
                        <div style="background-color: #f7f1e1; padding: 16px; text-align: center; font-size: 12px; color: #7A1F1F;">
                            &copy; 2026 Jagirdar Publications. All rights reserved.
                        </div>
                    </div>
                `
            };

            const info = await transporter.sendMail(mailOptions);
            console.log('[Email Sent Successfully]:', info.messageId);
            return { success: true, provider: 'smtp', messageId: info.messageId };
        } catch (error) {
            console.error('[Email SMTP Error]:', error.message);
        }
    } else {
        console.log('[Email Notice]: SMTP credentials not set in .env. Email OTP printed above in console.');
    }

    return {
        success: true,
        provider: 'console_dev',
        otp: otp
    };
}

/**
 * Sends Order Bill / Invoice via Email
 * @param {Object} order The complete order object from DB
 * @param {string} email Target recipient email address
 */
async function sendOrderBillEmail(order, email) {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail) return { success: false, error: 'No email provided' };

    console.log(`\n==================================================`);
    console.log(`[EMAIL INVOICE GENERATED] Recipient: ${cleanEmail} | Order: ${order.id}`);
    console.log(`==================================================\n`);

    const smtpHost = process.env.SMTP_HOST || process.env.EMAIL_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || '587');
    const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER;
    const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.GMAIL_PASS;

    if (smtpUser && smtpPass) {
        try {
            const transporter = nodemailer.createTransport({
                host: smtpHost || 'smtp.gmail.com',
                port: smtpPort,
                secure: smtpPort === 465,
                auth: { user: smtpUser, pass: smtpPass }
            });

            const htmlContent = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #7A1F1F; color: #ffffff; padding: 24px; text-align: center;">
                    <h1 style="margin: 0; font-size: 28px; text-transform: uppercase; letter-spacing: 1px;">Jagirdar Publications</h1>
                    <p style="margin: 8px 0 0 0; font-size: 16px; color: #f7e6c1;">Official Order Invoice</p>
                </div>
                <div style="padding: 24px; color: #333333;">
                    <p style="font-size: 16px;">Namaste <strong>${order.shipping_name || 'Customer'}</strong>,</p>
                    <p style="font-size: 14px; color: #555555; line-height: 1.5;">Thank you for your purchase! Your order <strong>#${order.id}</strong> has been confirmed. Below is your official bill.</p>
                    
                    <div style="margin-top: 24px; border: 1px solid #e5e5e5; border-radius: 6px; overflow: hidden;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <thead style="background-color: #f8f9fa;">
                                <tr>
                                    <th style="padding: 12px; text-align: left; font-size: 13px; color: #555; border-bottom: 1px solid #e5e5e5;">Item</th>
                                    <th style="padding: 12px; text-align: center; font-size: 13px; color: #555; border-bottom: 1px solid #e5e5e5;">Qty</th>
                                    <th style="padding: 12px; text-align: right; font-size: 13px; color: #555; border-bottom: 1px solid #e5e5e5;">Total</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td style="padding: 12px; font-size: 14px; border-bottom: 1px solid #eee;">
                                        <strong>${order.book_title || 'Book'}</strong>
                                    </td>
                                    <td style="padding: 12px; font-size: 14px; border-bottom: 1px solid #eee; text-align: center;">
                                        ${order.quantity}
                                    </td>
                                    <td style="padding: 12px; font-size: 14px; border-bottom: 1px solid #eee; text-align: right;">
                                        ₹${(order.unit_price * order.quantity)}
                                    </td>
                                </tr>
                                ${order.discount_amount > 0 ? `
                                <tr>
                                    <td colspan="2" style="padding: 12px; font-size: 13px; text-align: right; color: #7A1F1F;">Voucher Discount:</td>
                                    <td style="padding: 12px; font-size: 13px; text-align: right; color: #7A1F1F;">-₹${order.discount_amount}</td>
                                </tr>
                                ` : ''}
                                <tr>
                                    <td colspan="2" style="padding: 12px; font-size: 16px; font-weight: bold; text-align: right; background-color: #fafafa;">Grand Total:</td>
                                    <td style="padding: 12px; font-size: 16px; font-weight: bold; text-align: right; background-color: #fafafa; color: #7A1F1F;">₹${order.total_amount}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div style="margin-top: 24px; padding: 16px; background-color: #f8f9fa; border-radius: 6px;">
                        <p style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; color: #777; font-weight: bold;">Shipping Details</p>
                        <p style="margin: 0; font-size: 14px;"><strong>${order.shipping_name}</strong><br>${order.shipping_address}<br>${order.shipping_city ? order.shipping_city + ' - ' : ''}${order.shipping_pincode}<br>Phone: +91 ${order.shipping_mobile}</p>
                    </div>

                </div>
                <div style="background-color: #7A1F1F; padding: 16px; text-align: center; font-size: 12px; color: #f7e6c1;">
                    &copy; ${new Date().getFullYear()} Jagirdar Publications. All rights reserved.
                </div>
            </div>
            `;

            const mailOptions = {
                from: `"Jagirdar Publications" <${smtpUser}>`,
                to: cleanEmail,
                subject: `Invoice for Order #${order.id} - Jagirdar Publications`,
                html: htmlContent
            };

            const info = await transporter.sendMail(mailOptions);
            return { success: true, provider: 'smtp', messageId: info.messageId };
        } catch (error) {
            console.error('[Email Invoice SMTP Error]:', error.message);
        }
    } else {
        console.log('[Email Notice]: SMTP credentials not set. Invoice not sent.');
    }
    return { success: false, error: 'SMTP not configured' };
}

module.exports = { sendEmailOtp, sendOrderBillEmail };
