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

async function checkPickup() {
    const email = env.SHIPROCKET_EMAIL;
    const password = env.SHIPROCKET_PASSWORD;

    const response = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    const data = await response.json();
    const token = data.token;

    const pickupRes = await fetch('https://apiv2.shiprocket.in/v1/external/settings/company/pickup', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const pickupData = await pickupRes.json();
    console.log('--- ALL REGISTERED PICKUP LOCATIONS IN USER SHIPROCKET ACCOUNT ---');
    const locations = pickupData.data?.shipping_address || [];
    locations.forEach((loc, idx) => {
        console.log(`Location #${idx + 1}:`);
        console.log(`  pickup_location (Name): "${loc.pickup_location}"`);
        console.log(`  name (Contact): "${loc.name}"`);
        console.log(`  address: "${loc.address}"`);
        console.log(`  city: "${loc.city}", state: "${loc.state}", pincode: "${loc.pin_code}"`);
        console.log(`  phone: "${loc.phone}"`);
    });

    console.log('\n--- Configured SHIPROCKET_PICKUP_LOCATION in .env ---');
    console.log(`"${env.SHIPROCKET_PICKUP_LOCATION}"`);
}

checkPickup();
