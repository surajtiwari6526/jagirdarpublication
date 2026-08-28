const fetch = require('node-fetch');

let shiprocketToken = null;
let tokenExpiryTime = 0;

/**
 * Authenticate with Shiprocket API to get JWT bearer token.
 * Caches token in memory until expiration.
 */
async function getShiprocketToken(customCredentials = {}) {
    let rawEmail = customCredentials.email || customCredentials.user || process.env.SHIPROCKET_EMAIL || process.env.SHIPROCKET_USER || '';
    let rawPassword = customCredentials.password || customCredentials.pass || process.env.SHIPROCKET_PASSWORD || process.env.SHIPROCKET_PASS || '';

    const email = rawEmail.replace(/^["']|["']$/g, '').trim();
    const password = rawPassword.replace(/^["']|["']$/g, '').trim();

    if (!email || !password) {
        throw new Error('Shiprocket credentials missing. Please enter your Shiprocket Email & Password in Admin Panel Settings or set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD in environment variables.');
    }

    // Return cached token if valid (valid for ~9 days)
    if (shiprocketToken && Date.now() < tokenExpiryTime) {
        return shiprocketToken;
    }

    try {
        const response = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (!response.ok || !data.token) {
            throw new Error(data.message || 'Shiprocket authentication failed. Please check your credentials.');
        }

        shiprocketToken = data.token;
        // Token expires in 10 days, cache for 9 days
        tokenExpiryTime = Date.now() + (9 * 24 * 60 * 60 * 1000);
        console.log('[Shiprocket API]: Successfully authenticated.');
        return shiprocketToken;
    } catch (err) {
        console.error('[Shiprocket Auth Error]:', err.message);
        throw err;
    }
}

/**
 * Create order / shipment in Shiprocket
 */
async function createShiprocketOrder(order, settings = {}) {
    try {
        const token = await getShiprocketToken(settings);

        let rawPickup = settings.pickup_location || process.env.SHIPROCKET_PICKUP_LOCATION || 'Gaj Ganesh';
        let pickupLocation = rawPickup.replace(/^["']|["']$/g, '').trim();
        if (!pickupLocation || pickupLocation.toLowerCase() === 'primary') {
            pickupLocation = 'Gaj Ganesh';
        }
        const orderDateStr = order.created_at ? new Date(order.created_at).toISOString().replace('T', ' ').substring(0, 16) : new Date().toISOString().replace('T', ' ').substring(0, 16);

        // Sanitize name
        const nameParts = (order.shipping_name || order.user_name || 'Customer').trim().split(' ');
        const firstName = nameParts[0] || 'Customer';
        const lastName = nameParts.slice(1).join(' ') || '';

        // Sanitize phone & pincode for Shiprocket API
        const cleanPhone = (order.shipping_mobile || order.user_mobile || '9900000000').toString().replace(/\D/g, '').slice(-10) || '9900000000';
        const cleanPincode = (order.shipping_pincode || order.pincode || '342001').toString().replace(/\D/g, '').slice(0, 6) || '342001';

        const payload = {
            order_id: order.id,
            order_date: orderDateStr,
            pickup_location: pickupLocation,
            billing_customer_name: firstName,
            billing_last_name: lastName,
            billing_address: order.shipping_address || 'Address',
            billing_city: order.shipping_city || 'City',
            billing_pincode: cleanPincode,
            billing_state: order.shipping_state || order.state || 'Rajasthan',
            billing_country: 'India',
            billing_email: order.user_email || 'customer@jagirdarpublication.in',
            billing_phone: cleanPhone,
            shipping_is_billing: true,
            order_items: [
                {
                    name: 'ब्रह्मांशावतार श्री खेतेश्वर दाता (Hardcover Book)',
                    sku: 'BOOK-KHETESHWAR-01',
                    units: order.quantity || 1,
                    selling_price: Math.round((order.total_amount || 399) / (order.quantity || 1)),
                    discount: 0
                }
            ],
            payment_method: order.payment_method === 'COD' ? 'COD' : 'Prepaid',
            sub_total: order.total_amount || 399,
            length: settings.length || 20,
            breadth: settings.breadth || 14,
            height: settings.height || 3,
            weight: settings.weight || 0.5
        };

        let response = await fetch('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });

        let data = await response.json();

        // Smart Retry: If Pickup Location failed, auto-detect pickup location from Shiprocket account
        if (!response.ok || data.status_code === 400 || data.status_code === 422) {
            const errStr = JSON.stringify(data).toLowerCase();
            if (errStr.includes('pickup') || errStr.includes('location') || errStr.includes('address')) {
                try {
                    const pickupRes = await fetch('https://apiv2.shiprocket.in/v1/external/settings/company/pickup', {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    const pickupData = await pickupRes.json();
                    const locations = pickupData.data?.shipping_address || [];
                    if (locations.length > 0) {
                        const detectedLocation = locations[0].pickup_location || locations[0].address_name;
                        if (detectedLocation && detectedLocation !== pickupLocation) {
                            console.log(`[Shiprocket Auto-Detect]: Retrying with detected pickup location '${detectedLocation}'`);
                            payload.pickup_location = detectedLocation;
                            response = await fetch('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${token}`
                                },
                                body: JSON.stringify(payload)
                            });
                            data = await response.json();
                        }
                    }
                } catch (retryErr) {
                    console.error('[Shiprocket Pickup Retry Error]:', retryErr);
                }
            }
        }

        if (!response.ok || data.status_code === 400 || data.status_code === 422 || !data.order_id) {
            console.error('[Shiprocket Create Order Failed]:', data);
            return {
                success: false,
                error: data.message || (data.errors ? JSON.stringify(data.errors) : 'Failed to create order on Shiprocket'),
                raw: data
            };
        }

        return {
            success: true,
            shipment_id: data.shipment_id,
            shiprocket_order_id: data.order_id,
            status: data.status,
            status_code: data.status_code,
            awb_code: data.awb_code || '',
            courier_name: data.courier_name || '',
            raw: data
        };
    } catch (err) {
        console.error('[Shiprocket Create Order Error]:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Generate AWB code for shipment
 */
async function generateAwbCode(shipmentId, settings = {}) {
    try {
        const token = await getShiprocketToken(settings);
        const response = await fetch('https://apiv2.shiprocket.in/v1/external/courier/assign/awb', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ shipment_id: shipmentId })
        });
        const data = await response.json();
        if (data.awb_assign_status === 1) {
            return {
                success: true,
                awb_code: data.response.data.awb_code,
                courier_name: data.response.data.courier_name,
                courier_company_id: data.response.data.courier_company_id
            };
        }
        return { success: false, error: data.message || 'AWB assignment failed' };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Track shipment by AWB code or Order ID
 */
async function trackShipment(awbCode, orderId = null, settings = {}) {
    try {
        const token = await getShiprocketToken(settings);
        let url = `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awbCode}`;
        if (!awbCode && orderId) {
            url = `https://apiv2.shiprocket.in/v1/external/courier/track?order_id=${orderId}`;
        }

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();

        if (response.ok && (data.tracking_data || data[awbCode])) {
            const trackObj = data.tracking_data || data[awbCode]?.tracking_data || {};
            const scans = trackObj.shipment_track_activities || [];
            return {
                success: true,
                current_status: trackObj.current_status || 'IN TRANSIT',
                awb_code: trackObj.track_status || awbCode,
                courier_name: trackObj.courier_name || '',
                etd: trackObj.etd || '',
                origin: trackObj.origin || '',
                destination: trackObj.destination || '',
                scans: scans.map(s => ({
                    date: s.date || s['sr-status-label'],
                    activity: s.activity || s.location || '',
                    location: s.location || ''
                })),
                raw: trackObj
            };
        }
        return { success: false, error: 'Tracking data unavailable' };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

module.exports = {
    getShiprocketToken,
    createShiprocketOrder,
    generateAwbCode,
    trackShipment
};
