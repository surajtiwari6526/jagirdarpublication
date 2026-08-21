const { sendWhatsAppOtp, sendWhatsAppOrderConfirmation } = require('./api/services/whatsappService');
require('dotenv').config();

const testMobile = process.argv[2] || '9876543210';

async function runTests() {
    console.log(`Starting WhatsApp Integration Test for mobile: +91 ${testMobile}`);
    
    // 1. Test WhatsApp OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log('\n--- 1. Testing WhatsApp OTP Dispatch ---');
    try {
        const otpResult = await sendWhatsAppOtp(testMobile, otp, 'Test User');
        console.log('OTP Result:', otpResult);
    } catch (err) {
        console.error('OTP Test Error:', err);
    }

    // 2. Test WhatsApp Order Confirmation
    console.log('\n--- 2. Testing WhatsApp Order Confirmation ---');
    const mockOrder = {
        id: 'JP-TEST101',
        shipping_name: 'Suraj Tiwari',
        book_title: 'ब्रह्मांशावतार श्री खेतेश्वर दाता',
        quantity: 1,
        total_amount: 299, // (Sample test price - real orders use dynamic Admin price from DB)
        payment_method: 'Razorpay'
    };

    try {
        const orderResult = await sendWhatsAppOrderConfirmation(mockOrder, testMobile);
        console.log('Order Confirmation Result:', orderResult);
    } catch (err) {
        console.error('Order Confirmation Test Error:', err);
    }

    console.log('\n✅ WhatsApp Integration Test Execution Finished.');
}

runTests();
