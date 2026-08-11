const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');
const serviceAccount = require('./firebaseServiceAccount.js');

initializeApp({
    credential: cert(serviceAccount)
});
const db = getFirestore();

async function createSuperAdmin() {
    const passwordHash = crypto.createHash('sha256').update('@Mukesh2001').digest('hex');
    const adminId = 'ADM-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    
    await db.collection('admins').doc(adminId).set({
        id: adminId,
        email: 'mukeshd1008raj@gmail.com',
        password_hash: passwordHash,
        name: 'Mukesh Raj',
        mobile: '1234567890',
        created_at: new Date().toISOString(),
        is_blocked: 0
    });
    console.log('Super Admin successfully seeded into Firestore.');
}

createSuperAdmin().catch(console.error);
