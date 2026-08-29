const fs = require('fs');

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

async function testOrderCreation() {
    const email = env.SHIPROCKET_EMAIL;
    const password = env.SHIPROCKET_PASSWORD;

    const response = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    const data = await response.json();
    const token = data.token;

    console.log('Testing Order Creation with pickup_location = "Gaj Ganesh"...');
    const orderDateStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
    const testPayload = {
        order_id: "JP-TEST-" + Math.floor(100000 + Math.random() * 900000),
        order_date: orderDateStr,
        pickup_location: "Gaj Ganesh",
        billing_customer_name: "Test User",
        billing_last_name: "Verification",
        billing_address: "123 Test Street",
        billing_city: "Jodhpur",
        billing_pincode: "342001",
        billing_state: "Rajasthan",
        billing_country: "India",
        billing_email: "info@jagirdarpublication.in",
        billing_phone: "9904499394",
        shipping_is_billing: true,
        order_items: [
            {
                name: "ब्रह्मांशावतार श्री खेतेश्वर दाता (Hardcover Book)",
                sku: "BOOK-KHETESHWAR-01",
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
    console.log('Create Order Result:', JSON.stringify(createData, null, 2));
}

testOrderCreation();
