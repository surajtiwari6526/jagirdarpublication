const fs = require('fs');

// Read .env file directly
const envPath = 'c:/Users/gkt10/OneDrive/Desktop/Book-1-main/Book-1-main/.env';
const envContent = fs.readFileSync(envPath, 'utf8');

const env = {};
envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const idx = trimmed.indexOf('=');
        const key = trimmed.substring(0, idx).trim();
        let val = trimmed.substring(idx + 1).trim();
        val = val.replace(/^["']|["']$/g, '');
        env[key] = val;
    }
});

async function testShiprocket() {
    console.log('--- Testing Shiprocket Credentials & Connection ---');
    console.log('Env Email:', env.SHIPROCKET_EMAIL);
    console.log('Env Password:', env.SHIPROCKET_PASSWORD ? '***' + env.SHIPROCKET_PASSWORD.slice(-3) : 'MISSING');
    console.log('Env Pickup Location:', env.SHIPROCKET_PICKUP_LOCATION);
    
    const email = env.SHIPROCKET_EMAIL;
    const password = env.SHIPROCKET_PASSWORD;

    try {
        const response = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();
        console.log('Auth Response Status:', response.status);
        console.log('Auth Response Data:', JSON.stringify(data, null, 2));

        if (!data.token) {
            console.error('Login FAILED!');
            return;
        }

        const token = data.token;
        console.log('\nSUCCESS! Shiprocket Token obtained.');

        // Test fetching Pickup Locations
        console.log('\n--- Fetching Pickup Locations from Shiprocket Account ---');
        const pickupRes = await fetch('https://apiv2.shiprocket.in/v1/external/settings/company/pickup', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const pickupData = await pickupRes.json();
        console.log('Pickup Locations Response:', JSON.stringify(pickupData, null, 2));

        // Test creating a dummy order to check error details if any
        console.log('\n--- Testing Order Creation Payload validation ---');
        const orderDateStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
        const testPayload = {
            order_id: "TEST-SHIPROCKET-" + Date.now(),
            order_date: orderDateStr,
            pickup_location: env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
            billing_customer_name: "Test",
            billing_last_name: "Customer",
            billing_address: "Test Address Line 1",
            billing_city: "Jodhpur",
            billing_pincode: "342001",
            billing_state: "Rajasthan",
            billing_country: "India",
            billing_email: email,
            billing_phone: "9900000000",
            shipping_is_billing: true,
            order_items: [
                {
                    name: "Test Book",
                    sku: "BOOK-TEST-01",
                    units: 1,
                    selling_price: 399,
                    discount: 0
                }
            ],
            payment_method: "Prepaid",
            sub_total: 399,
            length: 20,
            breadth: 14,
            height: 3,
            weight: 0.5
        };

        const createRes = await fetch('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(testPayload)
        });

        const createData = await createRes.json();
        console.log('Create Order Status Code:', createRes.status);
        console.log('Create Order Response:', JSON.stringify(createData, null, 2));

    } catch (err) {
        console.error('Error during test:', err);
    }
}

testShiprocket();
