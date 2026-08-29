require('dotenv').config({ path: 'c:/Users/gkt10/OneDrive/Desktop/Book-1-main/Book-1-main/.env' });
const { createShiprocketOrder } = require('c:/Users/gkt10/OneDrive/Desktop/Book-1-main/Book-1-main/api/services/shiprocketService.js');

async function testSync() {
    console.log('--- Testing Live Order Sync to Shiprocket ---');
    const dummyOrder = {
        id: 'JP-LIVE-TEST-' + Math.floor(100000 + Math.random() * 900000),
        shipping_name: 'Test Customer',
        shipping_mobile: '9904499394',
        shipping_address: '123 Main Street',
        shipping_city: 'Jodhpur',
        shipping_pincode: '342001',
        shipping_state: 'Rajasthan',
        quantity: 1,
        total_amount: 399,
        payment_method: 'Prepaid',
        created_at: new Date().toISOString()
    };

    const res = await createShiprocketOrder(dummyOrder, { pickup_location: 'Gaj Ganesh' });
    console.log('Sync Result:', JSON.stringify(res, null, 2));
}

testSync();
