// Creates the first (super) admin. Usage:
//   SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='a-strong-password' SEED_ADMIN_NAME='Your Name' node seed_admin.js
// Credentials come from the environment so no password is ever stored in the repository.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');
const serviceAccount = require('./firebaseServiceAccount.js');

const email = (process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD || '';
const name = process.env.SEED_ADMIN_NAME || 'Super Admin';
if (!email || password.length < 8) {
    console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 8 characters).');
    process.exit(1);
}

initializeApp({
    credential: cert(serviceAccount)
});
const db = getFirestore();

// Same salted scrypt format the API uses
function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

async function createSuperAdmin() {
    const adminId = 'ADM-' + crypto.randomBytes(3).toString('hex').toUpperCase();

    await db.collection('admins').doc(adminId).set({
        id: adminId,
        email,
        password_hash: hashPassword(password),
        name,
        mobile: '',
        created_at: new Date().toISOString(),
        is_blocked: 0
    });
    console.log('Super Admin successfully seeded into Firestore.');
}

createSuperAdmin().catch(console.error);
