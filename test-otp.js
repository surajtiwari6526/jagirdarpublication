const { sendSmsOtp } = require('./services/smsService');
require('dotenv').config();

const testMobile = process.argv[2];

if (!testMobile) {
    console.log("Please provide a mobile number to test. Usage: node test-otp.js <mobile_number>");
    process.exit(1);
}

const otp = Math.floor(100000 + Math.random() * 900000).toString();

async function runTest() {
    console.log(`Starting OTP test for number: ${testMobile}`);
    try {
        const result = await sendSmsOtp(testMobile, otp);
        console.log("Test result:", result);
        if (result && result.success) {
            console.log(`✅ Success! OTP ${otp} sent successfully via ${result.provider}.`);
        } else {
            console.log("❌ Failed to send OTP.");
        }
    } catch (err) {
        console.error("❌ Error during OTP test:", err);
    }
}

runTest();
