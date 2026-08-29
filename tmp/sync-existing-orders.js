const fs = require('fs');
const admin = require('firebase-admin');

try {
    const serviceAccount = require('c:/Users/gkt10/OneDrive/Desktop/Book-1-main/Book-1-main/firebaseServiceAccount.js');
    if (admin.apps.length === 0) { 
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }); 
    }
} catch (error) {
    if (admin.apps.length === 0) { admin.initializeApp(); }
}

const db = admin.firestore();
const { createShiprocketOrder, generateAwbCode } = require('c:/Users/gkt10/OneDrive/Desktop/Book-1-main/Book-1-main/api/services/shiprocketService.js');

async function syncOrders() {
    console.log('--- Syncing Existing Paid Orders to Shiprocket ---');
    try {
        const settingsDoc = await db.collection('settings').doc('shiprocket').get();
        const settings = settingsDoc.exists ? settingsDoc.data() : {};

        const ordersSnap = await db.collection('orders').get();
        let syncedCount = 0;
        let alreadySyncedCount = 0;
        let unpaidCount = 0;

        for (const doc of ordersSnap.docs) {
            const order = { id: doc.id, ...doc.data() };
            const isPaid = ['PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED'].includes(order.status);
            
            if (isPaid) {
                if (order.shiprocket_order_id) {
                    alreadySyncedCount++;
                    console.log(`Order ${order.id} is already synced to Shiprocket (ID: ${order.shiprocket_order_id}).`);
                } else {
                    console.log(`Syncing Order ${order.id} to Shiprocket...`);
                    const srRes = await createShiprocketOrder(order, settings);
                    if (srRes.success) {
                        const srUpdate = {
                            shiprocket_order_id: srRes.shiprocket_order_id,
                            shipment_id: srRes.shipment_id,
                            shiprocket_status: srRes.status || 'CREATED'
                        };
                        if (srRes.shipment_id) {
                            const awbRes = await generateAwbCode(srRes.shipment_id, settings);
                            if (awbRes.success) {
                                srUpdate.awb_code = awbRes.awb_code;
                                srUpdate.courier_name = awbRes.courier_name;
                                srUpdate.tracking_number = awbRes.awb_code;
                                srUpdate.status = 'IN_TRANSIT';
                            }
                        }
                        await db.collection('orders').doc(order.id).update(srUpdate);
                        syncedCount++;
                        console.log(`SUCCESS! Order ${order.id} synced. Shiprocket Order ID: ${srRes.shiprocket_order_id}`);
                    } else {
                        console.error(`FAILED to sync Order ${order.id}:`, srRes.error);
                    }
                }
            } else {
                unpaidCount++;
            }
        }
        console.log(`\n--- Summary: ${syncedCount} new orders synced, ${alreadySyncedCount} already synced, ${unpaidCount} unpaid/pending. ---`);
    } catch (err) {
        console.error('Error syncing orders:', err);
    }
}

syncOrders();
