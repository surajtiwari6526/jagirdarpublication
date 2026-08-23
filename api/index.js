const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const path = require('path');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const Razorpay = require('razorpay');
require('dotenv').config();

try {
    const serviceAccount = require('../firebaseServiceAccount.js');
    if (getApps().length === 0) { 
        initializeApp({
            credential: cert(serviceAccount)
        }); 
    }
} catch (error) {
    console.warn("No serviceAccount found. Trying default initialization.", error);
    if (getApps().length === 0) { initializeApp(); }
}

const db = getFirestore();
const { sendSmsOtp, sendWhatsAppBill, sendWhatsAppOtp, sendWhatsAppOrderConfirmation } = require('./services/smsService');
const { sendEmailOtp, sendOrderBillEmail } = require('./services/emailService');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'jagirdar_publications_secret_jwt_key_2026';

// Middleware - Robust CORS Configuration
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

const corsOptions = {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true,
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));


app.use(express.json());
app.use(express.static(__dirname));

// JWT Auth Middleware for Users
const authenticateUser = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Authorization token required.' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
    }
};

// --- In-Memory Settings Cache for 0ms Latency ---
let cachedFrontendSettings = null;
let lastSettingsFetchTime = 0;
const SETTINGS_CACHE_TTL = 30000; // 30 seconds TTL

async function fetchSettingsFromDb() {
    try {
        const doc = await db.collection('settings').doc('frontend').get();
        let data = { isOrderNowEnabled: false, bookPrice: 399 };
        if (doc.exists && doc.data()) {
            const dbData = doc.data();
            data = {
                isOrderNowEnabled: dbData.isOrderNowEnabled !== undefined ? dbData.isOrderNowEnabled : false,
                bookPrice: dbData.bookPrice !== undefined ? parseInt(dbData.bookPrice, 10) || 399 : 399
            };
        }
        cachedFrontendSettings = data;
        lastSettingsFetchTime = Date.now();
        return data;
    } catch (err) {
        console.error('[Fetch Settings DB Error]:', err);
        return cachedFrontendSettings || { isOrderNowEnabled: false, bookPrice: 399 };
    }
}

// Helper: Get active store book price
async function getStoreBookPrice() {
    if (cachedFrontendSettings && cachedFrontendSettings.bookPrice !== undefined && (Date.now() - lastSettingsFetchTime < SETTINGS_CACHE_TTL)) {
        return cachedFrontendSettings.bookPrice;
    }
    const settings = await fetchSettingsFromDb();
    return settings.bookPrice || 399;
}

// Settings GET Endpoint (Serves instantly from Memory Cache)
app.get('/api/settings/frontend', async (req, res) => {
    if (cachedFrontendSettings && (Date.now() - lastSettingsFetchTime < SETTINGS_CACHE_TTL)) {
        res.json({ success: true, settings: cachedFrontendSettings });
        // Background refresh if older than 5 seconds
        if (Date.now() - lastSettingsFetchTime > 5000) {
            fetchSettingsFromDb().catch(() => {});
        }
        return;
    }
    const settings = await fetchSettingsFromDb();
    return res.json({ success: true, settings });
});

// Settings PUT Endpoint (Updates Memory Cache instantly + Persists to DB)
app.put('/api/settings/frontend', async (req, res) => {
    try {
        const { isOrderNowEnabled, bookPrice } = req.body;
        const currentSettings = cachedFrontendSettings || await fetchSettingsFromDb();
        const updateData = { ...currentSettings };

        if (isOrderNowEnabled !== undefined) {
            updateData.isOrderNowEnabled = !!isOrderNowEnabled;
        }
        if (bookPrice !== undefined) {
            const parsedPrice = parseInt(bookPrice, 10);
            if (!isNaN(parsedPrice) && parsedPrice > 0) {
                updateData.bookPrice = parsedPrice;
            }
        }

        // 1. Immediately update in-memory cache for 0ms response on subsequent GETs
        cachedFrontendSettings = updateData;
        lastSettingsFetchTime = Date.now();

        // 2. Persist to Firestore DB
        await db.collection('settings').doc('frontend').set(updateData, { merge: true });

        return res.json({ success: true, settings: updateData });
    } catch (err) {
        console.error('[Settings Update Error]:', err);
        return res.json({ success: false, error: 'Failed to update settings.' });
    }
});

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'Jagirdar Publications Full Backend', time: new Date().toISOString() });
});

// Meta WhatsApp Cloud API Webhook Verification & Listener
app.get('/api/whatsapp/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'jagirdar_whatsapp_webhook_secret_2026';

    if (mode && token) {
        if (mode === 'subscribe' && token === expectedToken) {
            console.log('[Meta Webhook Verified Successfully]');
            return res.status(200).send(challenge);
        } else {
            console.warn('[Meta Webhook Verification Failed]: Invalid Token');
            return res.sendStatus(403);
        }
    }
    return res.sendStatus(400);
});

app.post('/api/whatsapp/webhook', (req, res) => {
    const body = req.body;
    if (body.object) {
        console.log('[Meta Webhook Incoming Event]:', JSON.stringify(body, null, 2));
        return res.status(200).send('EVENT_RECEIVED');
    }
    return res.sendStatus(404);
});

// ==========================================
// 1. AUTHENTICATION MODULE (/api/auth)
// ==========================================

// Send OTP
app.post('/api/auth/send-otp', async (req, res) => {
    try {
        const { mobile, name } = req.body;
        const cleanMobile = (mobile || '').replace(/\D/g, '').slice(-10);

        if (!/^[6-9]\d{9}$/.test(cleanMobile)) {
            return res.status(400).json({ success: false, error: 'Please enter a valid 10-digit Indian mobile number.' });
        }

        // Check if user is blocked by Admin
        const userQuery = await db.collection('users').where('mobile', '==', cleanMobile).limit(1).get();
        let user = userQuery.empty ? null : { id: userQuery.docs[0].id, ...userQuery.docs[0].data() };

        if (user && user.is_blocked === 1) {
            return res.status(403).json({ success: false, error: 'Your account has been blocked by administrator. Please contact support.' });
        }

        // Immediately save or update user in database when OTP is requested
        if (!user) {
            const userId = 'USR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
            const now = new Date().toISOString();
            user = { id: userId, name: (name || 'Customer').trim(), mobile: cleanMobile, email: '', address: '', city: '', pincode: '', is_blocked: 0, created_at: now };
            await db.collection('users').doc(userId).set(user);
        } else if (name && name.trim() && user.name !== name.trim()) {
            await db.collection('users').doc(user.id).update({ name: name.trim() });
            user.name = name.trim();
        }

        // Generate 6-digit random WhatsApp OTP
        const otp = crypto.randomInt(100000, 999999).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 mins

        await db.collection('otp_sessions').doc(cleanMobile).set({
            mobile: cleanMobile,
            otp_code: otp,
            attempts: 0,
            expires_at: expiresAt,
            name: (name || '').trim(),
            created_at: Date.now()
        }, { merge: true });

        const smsResult = await sendWhatsAppOtp(cleanMobile, otp, (name || '').trim());

        res.json({
            success: true,
            message: `OTP sent successfully to WhatsApp (+91 ${cleanMobile})`,
            mobile: cleanMobile,
            expiresInSeconds: 300,
            provider: smsResult.provider
        });
    } catch (err) {
        console.error('[Send OTP Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to send OTP. Please try again.' });
    }
});

// Verify OTP
app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        const { mobile, otp, name } = req.body;
        const cleanMobile = (mobile || '').replace(/\D/g, '').slice(-10);
        const enteredOtp = (otp || '').trim();

        if (!cleanMobile || !enteredOtp) {
            return res.status(400).json({ success: false, error: 'Mobile number and OTP are required.' });
        }

        const userQuery = await db.collection('users').where('mobile', '==', cleanMobile).limit(1).get();
        let user = userQuery.empty ? null : { id: userQuery.docs[0].id, ...userQuery.docs[0].data() };

        if (user && user.is_blocked === 1) {
            return res.status(403).json({ success: false, error: 'Your account has been blocked by administrator. Please contact support.' });
        }

        const sessionDoc = await db.collection('otp_sessions').doc(cleanMobile).get();
        const session = sessionDoc.exists ? sessionDoc.data() : null;

        if (!session) {
            return res.status(400).json({ success: false, error: 'No active OTP found. Please click Resend OTP.' });
        }

        if (Date.now() > session.expires_at) {
            await db.collection('otp_sessions').doc(cleanMobile).delete();
            return res.status(400).json({ success: false, error: 'OTP has expired. Please request a new OTP.' });
        }

        if (session.attempts >= 3) {
            await db.collection('otp_sessions').doc(cleanMobile).delete();
            return res.status(400).json({ success: false, error: 'Too many incorrect attempts. Please request a new OTP.' });
        }

        if (session.otp_code !== enteredOtp) {
            const nextAttempts = session.attempts + 1;
            await db.collection('otp_sessions').doc(cleanMobile).update({ attempts: nextAttempts });
            return res.status(400).json({
                success: false,
                error: `Incorrect OTP! ${3 - nextAttempts} attempt(s) remaining.`
            });
        }

        await db.collection('otp_sessions').doc(cleanMobile).delete();

        const userName = (name || session.name || (user ? user.name : 'Customer')).trim();

        if (!user) {
            const userId = 'USR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
            const now = new Date().toISOString();
            user = { id: userId, name: userName, mobile: cleanMobile, email: '', address: '', city: '', pincode: '', is_blocked: 0, created_at: now, is_mobile_verified: 1, is_email_verified: 0 };
            await db.collection('users').doc(userId).set(user);
        } else if (name && name.trim()) {
            await db.collection('users').doc(user.id).update({ name: name.trim() });
            user.name = name.trim();
        }

        const token = jwt.sign(
            { id: user.id, mobile: user.mobile, name: user.name },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            success: true,
            message: 'OTP verified successfully!',
            token: token,
            user: {
                id: user.id,
                name: user.name,
                mobile: user.mobile,
                email: user.email || '',
                address: user.address || '',
                city: user.city || '',
                pincode: user.pincode || '',
                is_mobile_verified: user.is_mobile_verified || 0,
                is_email_verified: user.is_email_verified || 0,
                loggedIn: true
            }
        });
    } catch (err) {
        console.error('[Verify OTP Error]:', err);
        res.status(500).json({ success: false, error: 'OTP verification failed.' });
    }
});

// --- NEW AUTHENTICATION FLOW (SIGNUP & PASSWORD LOGIN) ---

const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};

// Signup - Send OTP
app.post('/api/auth/send-signup-otp', async (req, res) => {
    try {
        const { mobile, email } = req.body;
        const cleanMobile = (mobile || '').replace(/\D/g, '').slice(-10);

        if (!/^[6-9]\d{9}$/.test(cleanMobile)) {
            return res.status(400).json({ success: false, error: 'Please enter a valid 10-digit Indian mobile number.' });
        }

        const userByMobileQuery = await db.collection('users').where('mobile', '==', cleanMobile).limit(1).get();
        let existingUser = false;
        if (!userByMobileQuery.empty) {
            const uData = userByMobileQuery.docs[0].data();
            if (uData.account_status !== 'deleted') {
                existingUser = true;
            }
        }
        if (!existingUser && email) {
            const userByEmailQuery = await db.collection('users').where('email', '==', email.trim().toLowerCase()).limit(1).get();
            if (!userByEmailQuery.empty) {
                const uData = userByEmailQuery.docs[0].data();
                if (uData.account_status !== 'deleted') {
                    existingUser = true;
                }
            }
        }

        if (existingUser) {
            return res.status(400).json({ success: false, error: 'User with this mobile number or email already exists. Please login.' });
        }

        const otp = crypto.randomInt(100000, 999999).toString();
        const emailOtp = crypto.randomInt(100000, 999999).toString();
        
        console.log(`\n==================================================`);
        console.log(`[DEVELOPMENT MODE] SIGNUP MOBILE OTP FOR ${cleanMobile}: ${otp}`);
        if (email) console.log(`[DEVELOPMENT MODE] SIGNUP EMAIL OTP FOR ${email}: ${emailOtp}`);
        console.log(`==================================================\n`);
        const expiresAt = Date.now() + 5 * 60 * 1000;

        await db.collection('otp_sessions').doc(cleanMobile).set({
            mobile: cleanMobile,
            otp_code: otp,
            attempts: 0,
            expires_at: expiresAt,
            created_at: Date.now()
        }, { merge: true });

        await sendSmsOtp(cleanMobile, otp);
        if (email && email.trim() !== '') {
            await db.collection('email_otp_sessions').doc(email.trim().toLowerCase()).set({
                email: email.trim().toLowerCase(),
                otp_code: emailOtp,
                attempts: 0,
                expires_at: expiresAt,
                created_at: Date.now()
            }, { merge: true });
            
            await sendEmailOtp(email.trim(), emailOtp, 'New User');
        }

        res.json({ success: true, message: 'Signup OTP sent successfully to your mobile and email.' });
    } catch (err) {
        console.error('[Send Signup OTP Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to send OTP.' });
    }
});

// Inline Mobile OTP
app.post('/api/auth/send-signup-mobile-otp', async (req, res) => {
    try {
        const { mobile } = req.body;
        const cleanMobile = (mobile || '').replace(/\D/g, '').slice(-10);

        if (!/^[6-9]\d{9}$/.test(cleanMobile)) {
            return res.status(400).json({ success: false, error: 'Please enter a valid 10-digit Indian mobile number.' });
        }

        const userByMobileQuery = await db.collection('users').where('mobile', '==', cleanMobile).limit(1).get();
        if (!userByMobileQuery.empty) {
            const uData = userByMobileQuery.docs[0].data();
            if (uData.account_status !== 'deleted') {
                return res.status(400).json({ success: false, error: 'User with this mobile number already exists. Please login.' });
            }
        }

        const otp = crypto.randomInt(100000, 999999).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000;

        await db.collection('otp_sessions').doc(cleanMobile).set({
            mobile: cleanMobile,
            otp_code: otp,
            attempts: 0,
            expires_at: expiresAt,
            created_at: Date.now()
        }, { merge: true });

        await sendSmsOtp(cleanMobile, otp);
        res.json({ success: true, message: 'Signup OTP sent successfully to your mobile.' });
    } catch (err) {
        console.error('[Send Mobile OTP Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to send OTP.' });
    }
});

app.post('/api/auth/check-signup-mobile-otp', async (req, res) => {
    try {
        const { mobile, otp } = req.body;
        const cleanMobile = (mobile || '').replace(/\D/g, '').slice(-10);

        const sessionDoc = await db.collection('otp_sessions').doc(cleanMobile).get();
        const session = sessionDoc.exists ? sessionDoc.data() : null;
        
        if (!session || session.otp_code !== otp || Date.now() > session.expires_at) {
            return res.status(400).json({ success: false, error: 'Invalid or expired Mobile OTP.' });
        }

        // Mark as verified but don't delete yet
        await db.collection('otp_sessions').doc(cleanMobile).update({ is_verified: true });
        res.json({ success: true, message: 'Mobile verified.' });
    } catch (err) {
        console.error('[Check Mobile OTP Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to verify OTP.' });
    }
});

// Inline Email OTP
app.post('/api/auth/send-signup-email-otp', async (req, res) => {
    try {
        const { email } = req.body;
        const cleanEmail = (email || '').trim().toLowerCase();

        if (!cleanEmail) {
            return res.status(400).json({ success: false, error: 'Valid email is required.' });
        }

        const userByEmailQuery = await db.collection('users').where('email', '==', cleanEmail).limit(1).get();
        if (!userByEmailQuery.empty) {
            const uData = userByEmailQuery.docs[0].data();
            if (uData.account_status !== 'deleted') {
                return res.status(400).json({ success: false, error: 'User with this email already exists.' });
            }
        }

        const emailOtp = crypto.randomInt(100000, 999999).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000;

        await db.collection('email_otp_sessions').doc(cleanEmail).set({
            email: cleanEmail,
            otp_code: emailOtp,
            attempts: 0,
            expires_at: expiresAt,
            created_at: Date.now()
        }, { merge: true });
        
        await sendEmailOtp(cleanEmail, emailOtp, 'New User');
        res.json({ success: true, message: 'Signup OTP sent successfully to your email.' });
    } catch (err) {
        console.error('[Send Email OTP Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to send OTP.' });
    }
});

app.post('/api/auth/check-signup-email-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;
        const cleanEmail = (email || '').trim().toLowerCase();

        const sessionDoc = await db.collection('email_otp_sessions').doc(cleanEmail).get();
        const session = sessionDoc.exists ? sessionDoc.data() : null;
        
        if (!session || session.otp_code !== otp || Date.now() > session.expires_at) {
            return res.status(400).json({ success: false, error: 'Invalid or expired Email OTP.' });
        }

        // Mark as verified
        await db.collection('email_otp_sessions').doc(cleanEmail).update({ is_verified: true });
        res.json({ success: true, message: 'Email verified.' });
    } catch (err) {
        console.error('[Check Email OTP Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to verify OTP.' });
    }
});

// Signup - Verify & Create User
app.post('/api/auth/verify-signup', async (req, res) => {
    try {
        const { firstName, lastName, mobile, email, password } = req.body;
        const cleanMobile = (mobile || '').replace(/\D/g, '').slice(-10);
        const name = `${firstName} ${lastName}`.trim();
        const cleanEmail = (email || '').trim().toLowerCase();

        if (!cleanMobile || !password || !firstName) {
            return res.status(400).json({ success: false, error: 'All fields are required.' });
        }

        const { otp, emailOtp } = req.body;

        // Validate Mobile OTP
        const sessionDoc = await db.collection('otp_sessions').doc(cleanMobile).get();
        const session = sessionDoc.exists ? sessionDoc.data() : null;
        if (!session || Date.now() > session.expires_at) {
            return res.status(400).json({ success: false, error: 'Mobile OTP expired or not found. Please request a new OTP.' });
        }
        if (!session.is_verified && session.otp_code !== (otp || '').trim()) {
            return res.status(400).json({ success: false, error: 'Invalid Mobile OTP code.' });
        }

        // Validate Email OTP if email provided
        if (cleanEmail) {
            const emailSessionDoc = await db.collection('email_otp_sessions').doc(cleanEmail).get();
            const emailSession = emailSessionDoc.exists ? emailSessionDoc.data() : null;
            if (!emailSession || Date.now() > emailSession.expires_at) {
                return res.status(400).json({ success: false, error: 'Email OTP expired or not found. Please request a new OTP.' });
            }
            const providedEmailOtp = (emailOtp || otp || '').trim();
            if (!emailSession.is_verified && emailSession.otp_code !== providedEmailOtp) {
                return res.status(400).json({ success: false, error: 'Invalid Email OTP code.' });
            }
            await db.collection('email_otp_sessions').doc(cleanEmail).delete();
        }

        await db.collection('otp_sessions').doc(cleanMobile).delete();

        const passwordHash = hashPassword(password);
        const now = new Date().toISOString();

        // Check if an existing user record exists (active or deleted)
        let userId;
        const userByMobile = await db.collection('users').where('mobile', '==', cleanMobile).limit(1).get();
        let existingDoc = !userByMobile.empty ? userByMobile.docs[0] : null;

        if (!existingDoc && cleanEmail) {
            const userByEmail = await db.collection('users').where('email', '==', cleanEmail).limit(1).get();
            if (!userByEmail.empty) existingDoc = userByEmail.docs[0];
        }

        if (existingDoc) {
            const existingData = existingDoc.data();
            if (existingData.account_status !== 'deleted') {
                return res.status(400).json({ success: false, error: 'User with this mobile or email already exists. Please login.' });
            }
            userId = existingDoc.id;
        } else {
            userId = 'USR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        }

        const user = {
            id: userId,
            name: name,
            mobile: cleanMobile,
            email: cleanEmail,
            password_hash: passwordHash,
            address: '',
            city: '',
            pincode: '',
            is_blocked: 0,
            account_status: 'active',
            created_at: now,
            is_email_verified: 1,
            is_mobile_verified: 1
        };
        await db.collection('users').doc(userId).set(user, { merge: true });

        const token = jwt.sign({ id: user.id, mobile: user.mobile, name: user.name }, JWT_SECRET, { expiresIn: '30d' });

        res.json({ success: true, message: 'Signup successful!', token, user: { id: user.id, name: user.name, mobile: user.mobile, email: user.email, is_mobile_verified: user.is_mobile_verified || 0, is_email_verified: user.is_email_verified || 0, loggedIn: true } });
    } catch (err) {
        console.error('[Verify Signup Error]:', err);
        res.status(500).json({ success: false, error: 'Signup failed.' });
    }
});

// Login with Password
app.post('/api/auth/login-password', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        
        if (!identifier || !password) {
            return res.status(400).json({ success: false, error: 'Email/Mobile and Password are required.' });
        }

        const trimmedIdentifier = identifier.trim();
        const cleanEmail = trimmedIdentifier.toLowerCase();
        let user = null;

        if (trimmedIdentifier.includes('@')) {
            // Search strictly by email
            const userQ = await db.collection('users').where('email', '==', cleanEmail).limit(1).get();
            if (!userQ.empty) user = { id: userQ.docs[0].id, ...userQ.docs[0].data() };
        } else {
            // Search strictly by 10-digit mobile number
            let cleanMobile = trimmedIdentifier.replace(/\D/g, '').slice(-10);
            if (/^[6-9]\d{9}$/.test(cleanMobile)) {
                const userQ = await db.collection('users').where('mobile', '==', cleanMobile).limit(1).get();
                if (!userQ.empty) user = { id: userQ.docs[0].id, ...userQ.docs[0].data() };
            }
        }

        // Fallback: If not found yet, try querying email directly
        if (!user) {
            const userQ = await db.collection('users').where('email', '==', cleanEmail).limit(1).get();
            if (!userQ.empty) user = { id: userQ.docs[0].id, ...userQ.docs[0].data() };
        }

        if (!user) {
            return res.status(400).json({ success: false, error: 'Invalid credentials.' });
        }
        if (user.is_blocked === 1) {
            return res.status(403).json({ success: false, error: 'Account blocked.' });
        }
        if (user.account_status === 'deleted') {
            return res.status(403).json({ success: false, error: 'Account not found or deleted.' });
        }
        if (!user.password_hash) {
            return res.status(400).json({ success: false, error: 'Password not set for this Google account. Please click "Sign in with Google" or use "Forgot Password".' });
        }

        const passwordHash = hashPassword(password);
        if (user.password_hash !== passwordHash) {
            return res.status(400).json({ success: false, error: 'Invalid credentials.' });
        }

        const token = jwt.sign({ id: user.id, mobile: user.mobile || '', name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, message: 'Login successful!', token, user: { id: user.id, name: user.name, mobile: user.mobile || '', email: user.email, is_mobile_verified: user.is_mobile_verified || 0, is_email_verified: user.is_email_verified || 0, loggedIn: true } });
    } catch (err) {
        console.error('[Login Error]:', err);
        res.status(500).json({ success: false, error: 'Login failed.' });
    }
});

// Google Login Endpoint
app.post('/api/auth/google-login', async (req, res) => {
    try {
        const { email, name, firebaseUid } = req.body;
        if (!email) return res.status(400).json({ success: false, error: 'Google email is required.' });

        const cleanEmail = email.trim().toLowerCase();
        let user = null;
        const userQ = await db.collection('users').where('email', '==', cleanEmail).limit(1).get();
        
        if (!userQ.empty) {
            user = { id: userQ.docs[0].id, ...userQ.docs[0].data() };
        } else {
            // Auto-create user account for Google Signup instantly
            const userId = 'USR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
            const now = new Date().toISOString();
            user = {
                id: userId,
                name: (name || 'Google User').trim(),
                email: cleanEmail,
                mobile: '',
                password_hash: '',
                address: '',
                city: '',
                pincode: '',
                is_blocked: 0,
                account_status: 'active',
                is_email_verified: 1,
                is_mobile_verified: 0,
                auth_provider: 'google',
                firebase_uid: firebaseUid || '',
                created_at: now
            };
            await db.collection('users').doc(userId).set(user);
        }

        if (user.is_blocked === 1) {
            return res.status(403).json({ success: false, error: 'Account blocked.' });
        }
        if (user.account_status === 'deleted') {
            return res.status(403).json({ success: false, error: 'Account not found or deleted.' });
        }

        const token = jwt.sign({ id: user.id, mobile: user.mobile || '', name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, message: 'Google login successful!', token, user: { id: user.id, name: user.name, mobile: user.mobile || '', email: user.email, is_mobile_verified: user.is_mobile_verified || 0, is_email_verified: user.is_email_verified || 1, loggedIn: true } });
    } catch (err) {
        console.error('[Google Login Error]:', err);
        res.status(500).json({ success: false, error: 'Server error during Google login.' });
    }
});

// Complete Google Signup (Set Password & Mobile)
app.post('/api/auth/google-signup-complete', async (req, res) => {
    try {
        const { email, name, mobile, password, otp } = req.body;
        const cleanMobile = (mobile || '').replace(/\D/g, '').slice(-10);
        const cleanEmail = (email || '').trim().toLowerCase();

        if (!cleanEmail || !password || !cleanMobile || !otp) {
            return res.status(400).json({ success: false, error: 'Email, password, mobile, and OTP are required.' });
        }

        // Verify OTP
        const sessionDoc = await db.collection('otp_sessions').doc(cleanMobile).get();
        const session = sessionDoc.exists ? sessionDoc.data() : null;
        if (!session || session.otp_code !== otp || Date.now() > session.expires_at) {
            return res.status(400).json({ success: false, error: 'Invalid or expired OTP.' });
        }

        // Delete OTP session after successful verification
        await db.collection('otp_sessions').doc(cleanMobile).delete();

        const passwordHash = hashPassword(password);
        const userQ = await db.collection('users').where('email', '==', cleanEmail).limit(1).get();
        
        let userId;
        let userDoc;

        if (!userQ.empty) {
            // Update existing Google user record with mobile & password
            userId = userQ.docs[0].id;
            userDoc = {
                ...userQ.docs[0].data(),
                mobile: cleanMobile,
                password_hash: passwordHash,
                is_mobile_verified: 1,
                is_email_verified: 1
            };
            await db.collection('users').doc(userId).update({
                mobile: cleanMobile,
                password_hash: passwordHash,
                is_mobile_verified: 1,
                is_email_verified: 1
            });
        } else {
            // Create new user record
            userId = 'USR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
            const now = new Date().toISOString();
            userDoc = { 
                id: userId, 
                name: (name || 'User').trim(), 
                mobile: cleanMobile, 
                email: cleanEmail, 
                password_hash: passwordHash,
                address: '', 
                city: '', 
                pincode: '', 
                is_blocked: 0, 
                account_status: 'active',
                is_email_verified: 1,
                is_mobile_verified: 1,
                auth_provider: 'google',
                created_at: now 
            };
            await db.collection('users').doc(userId).set(userDoc);
        }
        
        const token = jwt.sign({ id: userDoc.id, mobile: userDoc.mobile, name: userDoc.name, email: userDoc.email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, message: 'Account updated successfully!', token, user: { id: userDoc.id, name: userDoc.name, mobile: userDoc.mobile, email: userDoc.email, is_mobile_verified: userDoc.is_mobile_verified || 0, is_email_verified: userDoc.is_email_verified || 0, loggedIn: true } });
    } catch (err) {
        console.error('[Google Signup Complete Error]:', err);
        res.status(500).json({ success: false, error: 'Server error during signup completion.' });
    }
});

// Forgot Password - Send OTP to Email
app.post('/api/auth/forgot-password-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, error: 'Email is required.' });

        let user = null;
        const userQ = await db.collection('users').where('email', '==', email.trim().toLowerCase()).limit(1).get();
        if (!userQ.empty) user = { id: userQ.docs[0].id, ...userQ.docs[0].data() };

        if (!user) {
            return res.status(400).json({ success: false, error: 'No account found with that email address.' });
        }

        const otp = crypto.randomInt(100000, 999999).toString();
        console.log(`\n==================================================`);
        console.log(`[DEVELOPMENT MODE] PASSWORD RESET OTP FOR ${email.trim().toLowerCase()}: ${otp}`);
        console.log(`==================================================\n`);
        const expiresAt = Date.now() + 10 * 60 * 1000;

        await db.collection('email_otp_sessions').doc(email.trim().toLowerCase()).set({
            user_id: user.id,
            email: email.trim().toLowerCase(),
            otp_code: otp,
            attempts: 0,
            expires_at: expiresAt,
            created_at: Date.now()
        }, { merge: true });

        await sendEmailOtp(email.trim().toLowerCase(), otp, user.name);

        res.json({ success: true, message: 'Password reset OTP sent to email.' });
    } catch (err) {
        console.error('[Forgot Password Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to process request.' });
    }
});

// Verify Reset OTP (Step 1)
app.post('/api/auth/verify-reset-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ success: false, error: 'Email and OTP are required.' });

        const sessionDoc = await db.collection('email_otp_sessions').doc(email.trim().toLowerCase()).get();
        const session = sessionDoc.exists ? sessionDoc.data() : null;
        if (!session || session.otp_code !== otp || Date.now() > session.expires_at) {
            return res.status(400).json({ success: false, error: 'Invalid or expired OTP.' });
        }

        // Keep session alive for the final reset-password call
        res.json({ success: true, message: 'OTP verified successfully.' });
    } catch (err) {
        console.error('[Verify Reset OTP Error]:', err);
        res.status(500).json({ success: false, error: 'Verification failed.' });
    }
});

// Reset Password (Step 2)
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        if (!email || !otp || !newPassword) {
            return res.status(400).json({ success: false, error: 'All fields are required.' });
        }

        const sessionDoc = await db.collection('email_otp_sessions').doc(email.trim().toLowerCase()).get();
        const session = sessionDoc.exists ? sessionDoc.data() : null;
        if (!session || session.otp_code !== otp || Date.now() > session.expires_at) {
            return res.status(400).json({ success: false, error: 'Invalid or expired OTP.' });
        }

        await db.collection('email_otp_sessions').doc(email.trim().toLowerCase()).delete();

        const passwordHash = hashPassword(newPassword);
        await db.collection('users').doc(session.user_id).update({ password_hash: passwordHash });

        res.json({ success: true, message: 'Password reset successfully. You can now login.' });
    } catch (err) {
        console.error('[Reset Password Error]:', err);
        res.status(500).json({ success: false, error: 'Password reset failed.' });
    }
});

// Firebase Authenticated Login Endpoint
app.post('/api/auth/firebase-login', async (req, res) => {
    try {
        const { mobile, name, firebaseUid } = req.body;
        const cleanMobile = (mobile || '').replace(/\D/g, '').slice(-10);

        if (!cleanMobile) {
            return res.status(400).json({ success: false, error: 'Mobile number is required.' });
        }

        const userQ = await db.collection('users').where('mobile', '==', cleanMobile).limit(1).get();
        let user = userQ.empty ? null : { id: userQ.docs[0].id, ...userQ.docs[0].data() };

        if (user && user.is_blocked === 1) {
            return res.status(403).json({ success: false, error: 'Your account has been blocked by administrator. Please contact support.' });
        }
        if (user && user.account_status === 'deleted') {
            return res.status(403).json({ success: false, error: 'Account not found or deleted.' });
        }

        const userName = (name || (user ? user.name : 'Customer')).trim();

        if (!user) {
            const userId = 'USR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
            const now = new Date().toISOString();
            user = { id: userId, name: userName, mobile: cleanMobile, email: '', address: '', city: '', pincode: '', is_blocked: 0, account_status: 'active', created_at: now, is_mobile_verified: 1, is_email_verified: 0 };
            await db.collection('users').doc(userId).set(user);
        } else if (name && name.trim() && user.name !== name.trim()) {
            await db.collection('users').doc(user.id).update({ name: name.trim() });
            user.name = name.trim();
        }

        const token = jwt.sign(
            { id: user.id, mobile: user.mobile, name: user.name, firebaseUid: firebaseUid || '' },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            success: true,
            message: 'Firebase OTP verification successful!',
            token,
            user: {
                id: user.id,
                name: user.name,
                mobile: user.mobile,
                email: user.email,
                address: user.address,
                city: user.city,
                pincode: user.pincode
            }
        });
    } catch (err) {
        console.error('[Firebase Login Error]:', err);
        res.status(500).json({ success: false, error: 'Server error during Firebase user registration/login.' });
    }
});

// Get Profile
app.get('/api/auth/profile', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, error: 'User not found.' });
        }
        const user = { id: userDoc.id, ...userDoc.data() };
        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                mobile: user.mobile,
                email: user.email || '',
                address: user.address || '',
                city: user.city || '',
                pincode: user.pincode || '',
                is_mobile_verified: user.is_mobile_verified || 0,
                is_email_verified: user.is_email_verified || 0,
                loggedIn: true
            }
        });
    } catch (err) {
        console.error('[Get Profile Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch profile.' });
    }
});

// Update Profile
app.put('/api/auth/profile', authenticateUser, async (req, res) => {
    try {
        const { name, email, mobile, address, city, pincode } = req.body;
        const userId = req.user.id;

        let cleanMobile = (mobile || '').replace(/\D/g, '').slice(-10);
        
        const userDoc = await db.collection('users').doc(userId).get();
        const existingUser = userDoc.exists ? userDoc.data() : null;
        const emailChanged = existingUser && existingUser.email !== email;
        const isEmailVerified = emailChanged ? 0 : (existingUser ? existingUser.is_email_verified : 0);
        
        const mobileChanged = existingUser && existingUser.mobile !== cleanMobile;
        const isMobileVerified = mobileChanged ? 0 : (existingUser ? existingUser.is_mobile_verified : 0);

        await db.collection('users').doc(userId).update({
            name, email, mobile: cleanMobile, address, city, pincode, is_email_verified: isEmailVerified, is_mobile_verified: isMobileVerified
        });

        const updatedDoc = await db.collection('users').doc(userId).get();
        const updatedData = updatedDoc.data();
        const updatedUser = { 
            id: updatedDoc.id, 
            name: updatedData.name, 
            mobile: updatedData.mobile, 
            email: updatedData.email || '', 
            address: updatedData.address || '', 
            city: updatedData.city || '', 
            pincode: updatedData.pincode || '',
            is_mobile_verified: updatedData.is_mobile_verified || 0,
            is_email_verified: updatedData.is_email_verified || 0,
            loggedIn: true
        };
        res.json({ success: true, message: 'Profile updated successfully', user: updatedUser });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to update profile.' });
    }
});

// Send Email Verification OTP
app.post('/api/auth/send-email-otp', authenticateUser, async (req, res) => {
    try {
        const { email } = req.body;
        const cleanEmail = (email || '').trim().toLowerCase();

        if (!cleanEmail || !cleanEmail.includes('@')) {
            return res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
        }

        const userId = req.user.id;
        const userDoc = await db.collection('users').doc(userId).get();
        const user = userDoc.exists ? userDoc.data() : null;
        if (!user) {
            return res.status(404).json({ success: false, error: 'User account not found.' });
        }

        const otp = crypto.randomInt(100000, 999999).toString();
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

        await db.collection('email_otp_sessions').doc(cleanEmail).set({
            user_id: userId,
            email: cleanEmail,
            otp_code: otp,
            attempts: 0,
            expires_at: expiresAt,
            created_at: Date.now()
        }, { merge: true });

        const emailResult = await sendEmailOtp(cleanEmail, otp, user.name || 'Customer');

        res.json({
            success: true,
            message: `Verification code sent to ${cleanEmail}`,
            email: cleanEmail,
            provider: emailResult.provider
        });
    } catch (err) {
        console.error('[Send Email OTP Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to send email verification OTP.' });
    }
});

// Verify Email OTP
app.post('/api/auth/verify-email-otp', authenticateUser, async (req, res) => {
    try {
        const { email, otp } = req.body;
        const cleanEmail = (email || '').trim().toLowerCase();
        const enteredOtp = (otp || '').trim();
        const userId = req.user.id;

        if (!cleanEmail || !enteredOtp) {
            return res.status(400).json({ success: false, error: 'Email and verification code are required.' });
        }

        const sessionDoc = await db.collection('email_otp_sessions').doc(cleanEmail).get();
        const session = sessionDoc.exists ? sessionDoc.data() : null;
        if (!session || session.user_id !== userId) {
            return res.status(400).json({ success: false, error: 'No pending email verification found. Please request a new OTP.' });
        }

        if (Date.now() > session.expires_at) {
            await db.collection('email_otp_sessions').doc(cleanEmail).delete();
            return res.status(400).json({ success: false, error: 'Email OTP has expired. Please request a new code.' });
        }

        if (session.attempts >= 3) {
            await db.collection('email_otp_sessions').doc(cleanEmail).delete();
            return res.status(400).json({ success: false, error: 'Too many failed attempts. Please request a new code.' });
        }

        if (session.otp_code !== enteredOtp) {
            const nextAttempts = session.attempts + 1;
            await db.collection('email_otp_sessions').doc(cleanEmail).update({ attempts: nextAttempts });
            return res.status(400).json({ success: false, error: `Incorrect Email OTP! ${3 - nextAttempts} attempt(s) remaining.` });
        }

        // Verification successful -> Update user email & set is_email_verified = 1
        await db.collection('users').doc(userId).update({ email: cleanEmail, is_email_verified: 1 });
        await db.collection('email_otp_sessions').doc(cleanEmail).delete();

        const updatedDoc = await db.collection('users').doc(userId).get();
        const updatedUser = { id: updatedDoc.id, ...updatedDoc.data() };

        res.json({
            success: true,
            message: '🎉 Email verified successfully!',
            user: updatedUser
        });
    } catch (err) {
        console.error('[Verify Email OTP Error]:', err);
        res.status(500).json({ success: false, error: 'Server error verifying email OTP.' });
    }
});

// --- USER ADDRESSES API ---

// Get all saved addresses for user
app.get('/api/auth/addresses', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const snapshot = await db.collection('user_addresses').where('user_id', '==', userId).get();
        let addresses = snapshot.empty ? [] : snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        addresses.sort((a, b) => {
            if (b.is_default !== a.is_default) return b.is_default - a.is_default;
            return new Date(b.created_at) - new Date(a.created_at);
        });
        res.json({ success: true, addresses });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch addresses.' });
    }
});

// Add a new address
app.post('/api/auth/addresses', authenticateUser, async (req, res) => {
    try {
        const { name, mobile, address, city, pincode } = req.body;
        const userId = req.user.id;

        if (!name || !mobile || !address || !city || !pincode) {
            return res.status(400).json({ success: false, error: 'All fields are required.' });
        }

        // Check if user has any existing addresses. If not, make this default.
        const existing = await db.collection('user_addresses').where('user_id', '==', userId).limit(1).get();
        const isDefault = existing.empty ? 1 : 0;

        const addressId = 'ADDR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const now = new Date().toISOString();

        const newAddress = { id: addressId, user_id: userId, name, mobile, address, city, pincode, is_default: isDefault, created_at: now };
        await db.collection('user_addresses').doc(addressId).set(newAddress);
        res.json({ success: true, message: 'Address saved successfully', address: newAddress });
    } catch (err) {
        console.error('[Add Address Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to add address.' });
    }
});

// Set address as default
app.put('/api/auth/addresses/:id/default', authenticateUser, async (req, res) => {
    try {
        const addressId = req.params.id;
        const userId = req.user.id;

        // Reset all to 0
        const batch = db.batch();
        const userAddrs = await db.collection('user_addresses').where('user_id', '==', userId).get();
        userAddrs.forEach(doc => {
            batch.update(doc.ref, { is_default: doc.id === addressId ? 1 : 0 });
        });
        await batch.commit();

        res.json({ success: true, message: 'Default address updated.' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to update default address.' });
    }
});

// Delete an address
app.delete('/api/auth/addresses/:id', authenticateUser, async (req, res) => {
    try {
        const addressId = req.params.id;
        const userId = req.user.id;
        
        // We only want to delete if it belongs to the user
        const addrDoc = await db.collection('user_addresses').doc(addressId).get();
        if (addrDoc.exists && addrDoc.data().user_id === userId) {
            await db.collection('user_addresses').doc(addressId).delete();
        }
        res.json({ success: true, message: 'Address deleted.' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to delete address.' });
    }
});

// ==========================================
// 2. VOUCHER MODULE (/api/vouchers)
// ==========================================

// Get Available Vouchers for User
app.get('/api/vouchers/my-vouchers', authenticateUser, async (req, res) => {
    try {
        const mobile = req.user.mobile;
        const snapshot = await db.collection('vouchers').where('is_active', '==', 1).where('assigned_mobile', '==', mobile).get();
        let vouchers = snapshot.empty ? [] : snapshot.docs.map(d => ({ id: d.id, ...d.data(), is_personal: 1 }));
        vouchers.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({
            success: true,
            count: vouchers.length,
            hasPersonalVoucher: vouchers.some(v => v.is_personal === 1),
            vouchers
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch vouchers.' });
    }
});

// Apply & Validate Voucher Code with Usage & Expiry Checks
app.post('/api/vouchers/apply', async (req, res) => {
    try {
        const { code, cartAmount, mobile, userId } = req.body;
        const cleanCode = (code || '').trim().toUpperCase();
        const userMobile = (mobile || '').replace(/\D/g, '').slice(-10);

        if (!cleanCode) {
            return res.status(400).json({ success: false, error: 'Please enter a valid voucher code.' });
        }

        // 1. Query for exact matching assigned personal voucher
        const vQuery = await db.collection('vouchers')
            .where('is_active', '==', 1)
            .where('assigned_mobile', '==', userMobile)
            .get();
        
        let voucher = null;
        vQuery.forEach(doc => {
            if (doc.data().code.toUpperCase() === cleanCode) {
                voucher = { id: doc.id, ...doc.data() };
            }
        });

        if (!voucher) {
            return res.status(400).json({ success: false, error: 'Invalid voucher code or it is not assigned to your account.' });
        }

        // 3. Check if User Has Already Used This Voucher in a Previous Order
        if (userMobile || userId) {
            // Firestore doesn't support complex OR with LIKE. We fetch all non-cancelled orders for user and check in memory
            let userOrders = [];
            if (userMobile) {
                const q1 = await db.collection('orders').where('shipping_mobile', '==', userMobile).get();
                q1.forEach(d => { if (d.data().status !== 'CANCELLED') userOrders.push({id: d.id, ...d.data()}) });
            }
            if (userId) {
                const q2 = await db.collection('orders').where('user_id', '==', userId).get();
                q2.forEach(d => { if (d.data().status !== 'CANCELLED' && !userOrders.find(o => o.id === d.id)) userOrders.push({id: d.id, ...d.data()}) });
            }

            const previousUsage = userOrders.find(o => o.applied_voucher && o.applied_voucher.toUpperCase().includes(cleanCode));

            if (previousUsage) {
                return res.status(400).json({
                    success: false,
                    error: `You have already used voucher "${cleanCode}" in a previous order (#${previousUsage.id}).`
                });
            }
        }

        // 4. Check Minimum Order Amount
        const defaultBookPrice = await getStoreBookPrice();
        const amount = parseInt(cartAmount || defaultBookPrice, 10);
        if (amount < voucher.min_order_amount) {
            return res.status(400).json({
                success: false,
                error: `Voucher "${voucher.code}" requires a minimum order of ₹${voucher.min_order_amount}.`
            });
        }

        // 5. Calculate Discount
        let discount = 0;
        if (voucher.discount_type === 'FLAT') {
            discount = voucher.discount_value;
        } else if (voucher.discount_type === 'PERCENT') {
            discount = Math.round((amount * voucher.discount_value) / 100);
        }

        res.json({
            success: true,
            code: voucher.code,
            rawCode: cleanCode,
            discount: discount,
            finalAmount: Math.max(0, amount - discount),
            message: `Voucher ${cleanCode} applied! You saved ₹${discount}.`
        });
    } catch (err) {
        console.error('[Apply Voucher Error]:', err);
        res.status(500).json({ success: false, error: 'Voucher evaluation failed.' });
    }
});

// ==========================================
// 3. ORDERS MODULE (/api/orders)
// ==========================================

// Create Draft Order
app.post('/api/orders/create', async (req, res) => {
    try {
        const { quantity, shippingName, shippingMobile, shippingAddress, shippingCity, shippingPincode, voucherCode, paymentMethod } = req.body;
        
        // Optional auth
        let userId = 'GUEST-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        let userName = 'Guest';
        let userMobile = '';
        
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                userId = decoded.id;
                userName = decoded.name;
                userMobile = decoded.mobile;
            } catch (err) {}
        }

        const qty = Math.max(1, parseInt(quantity || 1, 10));
        const unitPrice = await getStoreBookPrice();
        const subtotal = qty * unitPrice;

        let discount = 0;
        if (voucherCode) {
            const vQuery = await db.collection('vouchers').where('is_active', '==', 1).get();
            let v = null;
            vQuery.forEach(doc => {
                if (doc.data().code.toUpperCase() === voucherCode.toUpperCase()) {
                    v = { id: doc.id, ...doc.data() };
                }
            });
            if (v && subtotal >= v.min_order_amount) {
                discount = v.discount_type === 'FLAT' ? v.discount_value : Math.round((subtotal * v.discount_value) / 100);
            }
        }

        const totalAmount = Math.max(0, subtotal - discount);
        
        // Firestore: Since we cannot do ORDER BY CAST easily, we'll just query all orders, or use a counter document
        const counterDocRef = db.collection('metadata').doc('order_counter');
        const counterDoc = await counterDocRef.get();
        let currentSeq = 2101;
        if (counterDoc.exists) {
            currentSeq = counterDoc.data().last_seq + 1;
        }
        await counterDocRef.set({ last_seq: currentSeq });
        let orderId = 'JP-KD' + currentSeq;
        
        const now = new Date().toISOString();

        const createdOrder = {
            id: orderId, user_id: userId, book_title: 'ब्रह्मांशावतार श्री खेतेश्वर दाता', quantity: qty, unit_price: unitPrice, discount_amount: discount, total_amount: totalAmount,
            applied_voucher: voucherCode || '', shipping_name: shippingName || userName, shipping_mobile: shippingMobile || userMobile, shipping_address: shippingAddress || '', shipping_city: shippingCity || '',
            shipping_pincode: shippingPincode || '', payment_method: paymentMethod || 'UPI', status: 'PENDING', created_at: now
        };

        await db.collection('orders').doc(orderId).set(createdOrder);
        res.json({ success: true, order: createdOrder });
    } catch (err) {
        console.error('[Create Order Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to create order.' });
    }
});

// Get User Orders
app.get('/api/orders/my-orders', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const snapshot = await db.collection('orders').where('user_id', '==', userId).get();
        let orders = snapshot.empty ? [] : snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        
        // Fetch transactions for these orders
        if (orders.length > 0) {
            const orderIds = orders.map(o => o.id);
            // Firestore 'in' query supports max 10, so we just fetch all transactions for this user's orders or chunk it
            const tSnapshot = await db.collection('transactions').get(); // simplistic for now, or we can loop
            const txns = tSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            orders = orders.map(o => {
                const t = txns.find(tx => tx.order_id === o.id);
                return { ...o, transaction_id: t ? t.id : null };
            });
        }
        
        orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json({ success: true, orders });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch user orders.' });
    }
});

// Get Specific Order Details (for User)
app.get('/api/orders/:id', authenticateUser, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const userMobile = req.user.mobile || '';
        
        const orderDoc = await db.collection('orders').doc(id).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const orderData = orderDoc.data();
        const isOwner = orderData.user_id === userId || (userMobile && orderData.shipping_mobile === userMobile);
        const isAdmin = req.user.role === 'admin';
        
        if (!isAdmin && !isOwner) {
            return res.status(403).json({ success: false, error: 'Unauthorized to view this order.' });
        }
        
        let order = { id: orderDoc.id, ...orderData };
        const tSnapshot = await db.collection('transactions').where('order_id', '==', id).limit(1).get();
        order.transaction_id = tSnapshot.empty ? null : tSnapshot.docs[0].id;
        res.json({ success: true, order });
    } catch (err) {
        console.error('[Fetch Order Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch order details.' });
    }
});

// Get Public Order Details (For Invoice/Bill viewing - STRICT PAID CHECK)
app.get('/api/orders/:id/public', async (req, res) => {
    try {
        const { id } = req.params;
        const orderDoc = await db.collection('orders').doc(id).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const orderData = orderDoc.data();
        const isPaid = ['PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED'].includes(orderData.status);

        if (!isPaid) {
            return res.status(400).json({ 
                success: false, 
                isPaid: false, 
                orderId: id,
                status: orderData.status,
                error: 'Official bill/invoice can only be generated for confirmed orders with verified payment.' 
            });
        }

        let order = { id: orderDoc.id, ...orderData };
        const tSnapshot = await db.collection('transactions').where('order_id', '==', id).limit(1).get();
        order.transaction_id = tSnapshot.empty ? null : tSnapshot.docs[0].id;
        res.json({ success: true, isPaid: true, order });
    } catch (err) {
        console.error('[Fetch Public Order Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch order details.' });
    }
});

// Get Public Order Status (For Order Confirmation Verification)
app.get('/api/orders/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const orderDoc = await db.collection('orders').doc(id).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const order = { id: orderDoc.id, ...orderDoc.data() };
        const isPaid = ['PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED'].includes(order.status);
        res.json({
            success: true,
            orderId: id,
            status: order.status,
            isPaid,
            totalAmount: order.total_amount,
            quantity: order.quantity,
            paymentMethod: order.payment_method,
            razorpayPaymentId: order.razorpay_payment_id || null,
            createdAt: order.created_at
        });
    } catch (err) {
        console.error('[Order Status Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch order status.' });
    }
});

// Update Order with Manual UTR (Direct UPI) - SECURE PENDING_VERIFICATION FLOW
app.put('/api/orders/:id/utr', async (req, res) => {
    try {
        const { id } = req.params;
        const { utr, paymentMethod } = req.body;

        if (!utr || String(utr).trim().length < 6) {
            return res.status(400).json({ success: false, error: 'Invalid UTR reference number.' });
        }

        const orderDoc = await db.collection('orders').doc(id).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const order = { id: orderDoc.id, ...orderDoc.data() };

        // Create a transaction record manually for this UTR marked PENDING_VERIFICATION
        const txnId = 'TXN-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        await db.collection('transactions').doc(txnId).set({
            id: txnId, 
            order_id: id, 
            razorpay_order_id: 'DIRECT_UPI', 
            razorpay_payment_id: String(utr).trim(), 
            razorpay_signature: 'MANUAL_VERIFICATION_PENDING', 
            payment_method: paymentMethod || 'Direct UPI', 
            amount: order.total_amount, 
            status: 'PENDING_VERIFICATION', 
            created_at: new Date().toISOString()
        });

        // Set Order status to PENDING_VERIFICATION (Requires Admin Approval before marking PAID / generating Bill)
        await db.collection('orders').doc(id).update({ 
            status: 'PENDING_VERIFICATION',
            utr: String(utr).trim(),
            payment_method: paymentMethod || 'Direct UPI',
            utr_submitted_at: new Date().toISOString()
        });

        res.json({ 
            success: true, 
            status: 'PENDING_VERIFICATION',
            message: 'UTR reference submitted successfully. Order is pending admin payment verification.' 
        });
    } catch (err) {
        console.error('[Submit UTR Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to submit UTR.' });
    }
});

// ==========================================
// 4. RAZERPAY & PAYMENT GATEWAY (/api/payment)
// ==========================================

// Create Razorpay Order
app.post('/api/payment/razorpay/create-order', async (req, res) => {
    try {
        const { orderId } = req.body;
        const orderDoc = await db.collection('orders').doc(orderId).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const order = { id: orderDoc.id, ...orderDoc.data() };

        const amountPaise = Math.round(order.total_amount * 100);
        const rzpKeyId = process.env.RAZORPAY_KEY_ID || 'rzp_live_TOk3EEZaStpxe9';
        const rzpKeySecret = process.env.RAZORPAY_KEY_SECRET || 'MVnpUGCcb74FITZs4iXfWlZu';

        if (!rzpKeyId || !rzpKeySecret || rzpKeySecret === 'YOUR_RAZORPAY_SECRET_HERE') {
            return res.status(500).json({ success: false, error: 'Razorpay API credentials not configured properly in server environment.' });
        }

        let rzpOrderId = null;
        try {
            const razorpay = new Razorpay({
                key_id: rzpKeyId,
                key_secret: rzpKeySecret
            });

            const rzpOrder = await razorpay.orders.create({
                amount: amountPaise,
                currency: 'INR',
                receipt: order.id,
                notes: { orderId: order.id, customerMobile: order.shipping_mobile || '' }
            });
            rzpOrderId = rzpOrder.id;
        } catch (rzpErr) {
            console.error('[Razorpay Order Creation Error]:', rzpErr);
            const errMsg = (rzpErr && rzpErr.error && rzpErr.error.description) ? rzpErr.error.description : (rzpErr.message || 'Razorpay order creation failed.');
            return res.status(400).json({ success: false, error: errMsg });
        }

        res.json({
            success: true,
            key: rzpKeyId,
            amount: amountPaise,
            currency: 'INR',
            razorpayOrderId: rzpOrderId,
            orderId: order.id,
            customerName: order.shipping_name,
            customerMobile: order.shipping_mobile
        });
    } catch (err) {
        console.error('[Razorpay Create Order Server Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to create payment order.' });
    }
});

// Verify Payment HMAC Signature
app.post('/api/payment/razorpay/verify', async (req, res) => {
    try {
        const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
        const rzpSecret = process.env.RAZORPAY_KEY_SECRET || 'MVnpUGCcb74FITZs4iXfWlZu';

        if (!orderId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
            return res.status(400).json({ success: false, error: 'Missing required payment response details.' });
        }

        const orderRef = db.collection('orders').doc(orderId);
        const orderDoc = await orderRef.get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const orderData = orderDoc.data();

        // Verify Razorpay Order ID matches if stored
        if (orderData.razorpay_order_id && orderData.razorpay_order_id !== razorpayOrderId) {
            return res.status(400).json({ success: false, error: 'Payment order ID mismatch.' });
        }

        let isValid = false;

        if (rzpSecret && rzpSecret !== 'YOUR_RAZORPAY_SECRET_HERE') {
            const generatedSignature = crypto
                .createHmac('sha256', rzpSecret)
                .update(`${razorpayOrderId}|${razorpayPaymentId}`)
                .digest('hex');

            isValid = (generatedSignature === razorpaySignature);
        }

        if (!isValid) {
            return res.status(400).json({ success: false, error: 'Cryptographic payment signature verification failed.' });
        }

        // Update Order to PAID in Database
        const trackingNo = 'PENDING';
        const now = new Date().toISOString();
        await orderRef.update({ 
            status: 'PAID', 
            tracking_number: trackingNo,
            razorpay_payment_id: razorpayPaymentId,
            razorpay_order_id: razorpayOrderId,
            razorpay_signature: razorpaySignature,
            paid_at: now
        });

        // Insert Transaction Record
        const txnId = 'TXN-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const updatedOrderDoc = await orderRef.get();
        const order = { id: updatedOrderDoc.id, ...updatedOrderDoc.data() };
        
        await db.collection('transactions').doc(txnId).set({
            id: txnId, order_id: orderId, razorpay_order_id: razorpayOrderId || '', razorpay_payment_id: razorpayPaymentId || '', razorpay_signature: razorpaySignature || '', payment_method: order.payment_method || 'Razorpay', amount: order.total_amount, status: 'SUCCESS', created_at: new Date().toISOString()
        });

        // Fetch user email to send bill
        if (order.user_id && !order.user_id.startsWith('GUEST-')) {
            try {
                const userDoc = await db.collection('users').doc(order.user_id).get();
                if (userDoc.exists && userDoc.data().email) {
                    await sendOrderBillEmail(order, userDoc.data().email);
                }
            } catch (emailErr) {
                console.error('[Send Bill Email Error]:', emailErr);
            }
        }

        // Also send WhatsApp Bill if mobile is available
        if (order.shipping_mobile) {
            try {
                await sendWhatsAppBill(order, order.shipping_mobile);
            } catch (waErr) {
                console.error('[Send WhatsApp Bill Error]:', waErr);
            }
        }

        res.json({
            success: true,
            message: 'Payment verified successfully!',
            orderId: orderId,
            trackingNumber: trackingNo
        });
    } catch (err) {
        console.error('[Payment Verify Error]:', err);
        res.status(500).json({ success: false, error: 'Payment verification failed.' });
    }
});

// ==========================================
// 5. ADMIN PANEL MODULE (/api/admin)
// ==========================================

// Admin Login (Step 1: Check credentials & send OTP)
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const cleanEmail = (email || '').trim().toLowerCase();
        const inputHash = crypto.createHash('sha256').update(password || '').digest('hex');

        // Firestore doesn't support case-insensitive querying easily. We assume email is stored in lowercase, or we just fetch and compare
        const adminQ = await db.collection('admins').where('email', '==', cleanEmail).limit(1).get();
        const admin = adminQ.empty ? null : { id: adminQ.docs[0].id, ...adminQ.docs[0].data() };

        if (!admin || admin.password_hash !== inputHash) {
            return res.status(401).json({ success: false, error: 'Invalid admin email or password.' });
        }
        if (admin.is_blocked) {
            return res.status(403).json({ success: false, error: 'Your admin account has been blocked by the Super Admin.' });
        }

        // Generate and store OTP
        const otp = crypto.randomInt(100000, 999999).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000;
        
        await db.collection('email_otp_sessions').doc(cleanEmail).set({
            user_id: admin.id,
            email: cleanEmail,
            otp_code: otp,
            attempts: 0,
            expires_at: expiresAt,
            created_at: Date.now()
        }, { merge: true });

        await sendEmailOtp(cleanEmail, otp, admin.name);

        res.json({
            success: true,
            requireOtp: true,
            message: 'OTP sent to your email.'
        });
    } catch (err) {
        console.error('[Admin Login Error]:', err);
        res.status(500).json({ success: false, error: 'Admin login failed.' });
    }
});

// Admin Verify Login OTP (Step 2)
app.post('/api/admin/verify-login-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;
        const cleanEmail = (email || '').trim().toLowerCase();
        
        const sessionDoc = await db.collection('email_otp_sessions').doc(cleanEmail).get();
        const session = sessionDoc.exists ? sessionDoc.data() : null;
        if (!session) {
            return res.status(400).json({ success: false, error: 'OTP session expired or not found. Please login again.' });
        }
        
        if (Date.now() > session.expires_at) {
            await db.collection('email_otp_sessions').doc(cleanEmail).delete();
            return res.status(400).json({ success: false, error: 'OTP has expired. Please login again.' });
        }
        
        if (session.otp_code !== otp) {
            const nextAttempts = (session.attempts || 0) + 1;
            if (nextAttempts >= 3) {
                await db.collection('email_otp_sessions').doc(cleanEmail).delete();
                return res.status(400).json({ success: false, error: 'Too many failed attempts. Please login again.' });
            }
            await db.collection('email_otp_sessions').doc(cleanEmail).update({ attempts: nextAttempts });
            return res.status(400).json({ success: false, error: 'Invalid OTP code.' });
        }
        
        // OTP Success! Get admin details and issue token
        await db.collection('email_otp_sessions').doc(cleanEmail).delete();
        
        const adminQ = await db.collection('admins').where('email', '==', cleanEmail).limit(1).get();
        const admin = adminQ.empty ? null : { id: adminQ.docs[0].id, ...adminQ.docs[0].data() };
        if (!admin) {
             return res.status(404).json({ success: false, error: 'Admin account not found.' });
        }
        if (admin.is_blocked) {
            return res.status(403).json({ success: false, error: 'Your admin account has been blocked by the Super Admin.' });
        }

        const token = jwt.sign(
            { id: admin.id, email: admin.email, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            token,
            admin: { id: admin.id, name: admin.name, email: admin.email }
        });

    } catch (err) {
        console.error('[Admin Verify OTP Error]:', err);
        res.status(500).json({ success: false, error: 'OTP verification failed.' });
    }
});

// Create New Admin (Only existing admins can do this)
app.post('/api/admin/create-admin', authenticateUser, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Forbidden. Only admins can create new admins.' });
        }
        
        // ONLY SUPER ADMIN (Mukesh) can create new admins
        if (req.user.email !== 'mukeshd1008raj@gmail.com') {
            return res.status(403).json({ success: false, error: 'Forbidden. Only the Super Admin (Mukesh) can add new admins.' });
        }
        
        const { name, email, password, mobile } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ success: false, error: 'Name, email, and password are required.' });
        }

        const cleanEmail = email.trim().toLowerCase();
        const cleanMobile = mobile ? mobile.trim() : null;
        
        const existingAdminQ = await db.collection('admins').where('email', '==', cleanEmail).limit(1).get();
        if (!existingAdminQ.empty) {
            return res.status(400).json({ success: false, error: 'An admin with this email already exists.' });
        }

        const adminId = 'ADM-' + crypto.randomBytes(3).toString('hex').toUpperCase();
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

        await db.collection('admins').doc(adminId).set({
            id: adminId, email: cleanEmail, password_hash: passwordHash, name: name.trim(), mobile: cleanMobile, created_at: new Date().toISOString(), is_blocked: 0
        });

        res.json({ success: true, message: 'New admin created successfully.' });
    } catch (err) {
        console.error('[Create Admin Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to create new admin.' });
    }
});

const superAdminOnly = (req, res, next) => {
    if (req.user.role !== 'admin' || req.user.email !== 'mukeshd1008raj@gmail.com') {
        return res.status(403).json({ success: false, error: 'Forbidden. Super Admin access required.' });
    }
    next();
};

app.get('/api/admin/admins', authenticateUser, superAdminOnly, async (req, res) => {
    try {
        const snapshot = await db.collection('admins').get();
        let admins = snapshot.docs.map(d => {
            const data = d.data();
            return { id: d.id, name: data.name, email: data.email, mobile: data.mobile, is_blocked: data.is_blocked, created_at: data.created_at };
        });
        admins.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json({ success: true, admins });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch admins.' });
    }
});

app.post('/api/admin/admins/:id/toggle-block', authenticateUser, superAdminOnly, async (req, res) => {
    try {
        const { id } = req.params;
        const adminDoc = await db.collection('admins').doc(id).get();
        if (!adminDoc.exists) return res.status(404).json({ success: false, error: 'Admin not found.' });
        const admin = adminDoc.data();
        if (admin.email === 'mukeshd1008raj@gmail.com') return res.status(403).json({ success: false, error: 'Cannot block Super Admin.' });
        
        const newStatus = admin.is_blocked ? 0 : 1;
        await db.collection('admins').doc(id).update({ is_blocked: newStatus });
        res.json({ success: true, message: newStatus ? 'Admin blocked.' : 'Admin unblocked.' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to toggle block status.' });
    }
});

app.delete('/api/admin/admins/:id', authenticateUser, superAdminOnly, async (req, res) => {
    try {
        const { id } = req.params;
        const adminDoc = await db.collection('admins').doc(id).get();
        if (!adminDoc.exists) return res.status(404).json({ success: false, error: 'Admin not found.' });
        const admin = adminDoc.data();
        if (admin.email === 'mukeshd1008raj@gmail.com') return res.status(403).json({ success: false, error: 'Cannot delete Super Admin.' });
        
        await db.collection('admins').doc(id).delete();
        res.json({ success: true, message: 'Admin deleted successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to delete admin.' });
    }
});

app.post('/api/admin/admins/:id/change-password', authenticateUser, superAdminOnly, async (req, res) => {
    try {
        const { id } = req.params;
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 6) return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
        
        const adminDoc = await db.collection('admins').doc(id).get();
        if (!adminDoc.exists) return res.status(404).json({ success: false, error: 'Admin not found.' });
        
        const newHash = crypto.createHash('sha256').update(newPassword).digest('hex');
        await db.collection('admins').doc(id).update({ password_hash: newHash });
        res.json({ success: true, message: 'Admin password changed successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to change password.' });
    }
});

// Admin Stats
app.get('/api/admin/stats', async (req, res) => {
    try {
        // Since we can't easily do aggregations in Firestore client without fetching, we fetch and aggregate
        const ordersSnap = await db.collection('orders').get();
        let totalRevenue = 0, confirmedOrdersCount = 0, pendingShipping = 0, totalBooks = 0;
        ordersSnap.forEach(doc => {
            const data = doc.data();
            const isConfirmedPaid = ['PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED'].includes(data.status);
            if (isConfirmedPaid) {
                totalRevenue += data.total_amount || 0;
                totalBooks += data.quantity || 0;
                confirmedOrdersCount++;
            }
            if (['PAID', 'PROCESSING'].includes(data.status)) {
                pendingShipping++;
            }
        });

        const usersSnap = await db.collection('users').count().get();
        const totalUsers = usersSnap.data().count;

        res.json({
            success: true,
            stats: {
                totalRevenue: totalRevenue,
                totalOrders: confirmedOrdersCount,
                totalUsers: totalUsers,
                pendingShipping: pendingShipping,
                totalBooksSold: totalBooks
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch admin stats.' });
    }
});

// Admin Get All Orders with Advanced Search & Date Range Filtering (Excludes Unpaid Abandoned Checkouts by Default)
app.get('/api/admin/orders', async (req, res) => {
    try {
        const { search, startDate, endDate, status } = req.query;
        const snapshot = await db.collection('orders').get();
        let orders = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

        const VALID_ADMIN_STATUSES = ['PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED', 'PENDING_VERIFICATION'];

        // Filter by Status
        if (!status || status === 'ALL') {
            // Default: Only show verified paid orders or orders awaiting payment verification
            orders = orders.filter(o => VALID_ADMIN_STATUSES.includes(o.status));
        } else if (status === 'UNPAID_ABANDONED') {
            // Show abandoned checkouts (PENDING / CANCELLED)
            orders = orders.filter(o => o.status === 'PENDING' || o.status === 'CANCELLED');
        } else {
            // Filter by specific status requested
            orders = orders.filter(o => o.status === status);
        }

        if (search && search.trim()) {
            const term = search.trim().toLowerCase();
            orders = orders.filter(o => 
                (o.id && o.id.toLowerCase().includes(term)) || 
                (o.shipping_name && o.shipping_name.toLowerCase().includes(term)) || 
                (o.shipping_mobile && o.shipping_mobile.includes(term))
            );
        }

        if (startDate) {
            orders = orders.filter(o => new Date(o.created_at) >= new Date(startDate));
        }

        if (endDate) {
            orders = orders.filter(o => new Date(o.created_at) <= new Date(endDate));
        }

        orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        // Fetch transactions and users for these orders
        if (orders.length > 0) {
            const tSnapshot = await db.collection('transactions').get(); // simplistic for now
            const txns = tSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

            const uSnapshot = await db.collection('users').get();
            const allUsers = uSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

            orders = orders.map(o => {
                const t = txns.find(tx => tx.order_id === o.id);
                const u = allUsers.find(user => user.id === o.user_id);
                return { 
                    ...o, 
                    razorpay_payment_id: t ? t.razorpay_payment_id : null, 
                    txn_status: t ? t.status : null,
                    customer_email: u ? u.email : 'N/A',
                    customer_registered_mobile: u ? u.mobile : 'N/A',
                    customer_registered_name: u ? u.name : 'N/A'
                };
            });
        }

        res.json({ success: true, orders });
    } catch (err) {
        console.error('[Admin Orders Query Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch filtered orders.' });
    }
});



// Admin Update Order Status & Tracking Number
app.put('/api/admin/orders/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, trackingNumber } = req.body;

        await db.collection('orders').doc(id).update({ status, tracking_number: trackingNumber });

        const updatedDoc = await db.collection('orders').doc(id).get();
        const updated = { id: updatedDoc.id, ...updatedDoc.data() };

        if (status === 'PAID' && updated.shipping_mobile) {
            try {
                await sendWhatsAppOrderConfirmation(updated, updated.shipping_mobile);
            } catch (waErr) {
                console.error('[Admin Status Update - WhatsApp Confirmation Error]:', waErr);
            }
        }

        res.json({ success: true, message: 'Order status updated', order: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to update order status.' });
    }
});

// Admin Quick Mark as Shipped (IN_TRANSIT) Checkbox Handler
app.put('/api/admin/orders/:id/ship', async (req, res) => {
    try {
        const { id } = req.params;
        const { isShipped } = req.body;

        const existingDoc = await db.collection('orders').doc(id).get();
        if (!existingDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const existing = existingDoc.data();

        const newStatus = isShipped ? 'IN_TRANSIT' : 'PAID';
        let trackingNo = existing.tracking_number;
        if (isShipped && (!trackingNo || trackingNo === 'PENDING' || trackingNo === 'Not Assigned' || trackingNo === id)) {
            trackingNo = ''; // Leave empty for manual entry
        }

        await db.collection('orders').doc(id).update({ status: newStatus, tracking_number: trackingNo });
        const updatedDoc = await db.collection('orders').doc(id).get();
        const updated = { id: updatedDoc.id, ...updatedDoc.data() };

        res.json({ success: true, message: `Order status updated to ${newStatus}`, order: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to update shipping status.' });
    }
});

// Admin Get All Users
const getUsersHandler = async (req, res) => {
    try {
        const snapshot = await db.collection('users').get();
        let rawUsers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

        const ordersSnap = await db.collection('orders').get();
        const allOrders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const users = rawUsers.map(u => {
            const userMobile = u.mobile || u.phone || u.shipping_mobile || '';
            const userId = u.id || '';

            // Match orders by user_id or mobile number
            const userOrders = allOrders.filter(o => 
                !['CANCELLED', 'PENDING'].includes(o.status) && (
                    (userId && o.user_id === userId) || 
                    (userMobile && (o.user_id === userMobile || o.shipping_mobile === userMobile))
                )
            );

            return {
                ...u,
                id: userId,
                name: u.name || u.fullName || u.displayName || 'Customer',
                mobile: userMobile,
                email: u.email || 'N/A',
                address: u.address || u.shipping_address || 'N/A',
                city: u.city || u.shipping_city || '',
                pincode: u.pincode || u.shipping_pincode || '',
                created_at: u.created_at || u.createdAt || new Date().toISOString(),
                total_orders: userOrders.length,
                total_spent: userOrders.reduce((acc, o) => acc + (o.total_amount || 0), 0),
                is_blocked: u.is_blocked || 0,
                account_status: u.account_status || 'active'
            };
        });

        users.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({ success: true, users });
    } catch (err) {
        console.error('[Admin Get Users Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch users.' });
    }
};

app.get('/api/admin/users', getUsersHandler);
app.get('/api/users', getUsersHandler);

// Admin Get Single User Details + Order History
const getUserDetailsHandler = async (req, res) => {
    try {
        const { id } = req.params;
        const userDoc = await db.collection('users').doc(id).get();
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, error: 'User not found.' });
        }
        const u = { id: userDoc.id, ...userDoc.data() };
        const userMobile = u.mobile || u.phone || '';

        const ordersSnap = await db.collection('orders').get();
        const allOrders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const userOrders = allOrders.filter(o => 
            (u.id && o.user_id === u.id) || 
            (userMobile && (o.user_id === userMobile || o.shipping_mobile === userMobile))
        );

        userOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({
            success: true,
            user: {
                ...u,
                name: u.name || u.fullName || u.displayName || 'Customer',
                mobile: userMobile,
                email: u.email || 'N/A',
                address: u.address || u.shipping_address || 'N/A',
                city: u.city || u.shipping_city || '',
                pincode: u.pincode || u.shipping_pincode || ''
            },
            orders: userOrders
        });
    } catch (err) {
        console.error('[Admin Get User Details Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch user details.' });
    }
};

app.get('/api/admin/users/:id', getUserDetailsHandler);
app.get('/api/users/:id', getUserDetailsHandler);

// Admin Block / Unblock User
const blockUserHandler = async (req, res) => {
    try {
        const { id } = req.params;
        const { isBlocked } = req.body;

        await db.collection('users').doc(id).update({ is_blocked: isBlocked ? 1 : 0 });
        const updatedDoc = await db.collection('users').doc(id).get();
        const updated = { id: updatedDoc.id, ...updatedDoc.data() };

        res.json({
            success: true,
            message: isBlocked ? 'User account blocked.' : 'User account unblocked.',
            user: updated
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to update user block status.' });
    }
};

app.put('/api/admin/users/:id/block', blockUserHandler);
app.put('/api/users/:id/block', blockUserHandler);

// Admin Delete User Endpoint
const deleteUserHandler = async (req, res) => {
    try {
        const { id } = req.params;
        await db.collection('users').doc(id).delete();
        res.json({ success: true, message: 'User deleted successfully.' });
    } catch (err) {
        console.error('[Admin Delete User Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to delete user.' });
    }
};

app.delete('/api/admin/users/:id', deleteUserHandler);
app.delete('/api/users/:id', deleteUserHandler);

// Admin Create Voucher (Standard)
app.post('/api/admin/vouchers', async (req, res) => {
    try {
        const { code, discountType, discountValue, minOrderAmount, assignedMobile } = req.body;
        const voucherId = 'VOUCH-' + crypto.randomBytes(3).toString('hex').toUpperCase();

        await db.collection('vouchers').doc(voucherId).set({
            id: voucherId, code: code.trim().toUpperCase(), discount_type: discountType, discount_value: discountValue,
            min_order_amount: minOrderAmount || 0, assigned_mobile: assignedMobile || null, is_active: 1, created_at: new Date().toISOString()
        });

        res.json({ success: true, message: 'Voucher created successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to create voucher (code may already exist).' });
    }
});

// Admin Smart Bulk Voucher Targeting Engine API
app.post('/api/admin/vouchers/smart-assign', async (req, res) => {
    try {
        const {
            code, discountType, discountValue, minOrderAmount,
            targetMode,
            specificMobile, startDate, endDate, lastDays, minOrders, minSpent
        } = req.body;

        const cleanCode = (code || '').trim().toUpperCase();
        if (!cleanCode || !discountValue) {
            return res.status(400).json({ success: false, error: 'Voucher code and discount value are required.' });
        }

        let targetMobiles = [];

        if (targetMode === 'SPECIFIC_USER') {
            if (specificMobile) targetMobiles.push(specificMobile.trim());
        } else {
            const usersSnap = await db.collection('users').get();
            const allUsers = usersSnap.docs.map(d => ({id: d.id, ...d.data()}));
            
            if (targetMode === 'DATE_RANGE') {
                targetMobiles = allUsers.filter(u => new Date(u.created_at) >= new Date(startDate) && new Date(u.created_at) <= new Date(endDate)).map(u => u.mobile);
            } else if (targetMode === 'LAST_DAYS') {
                const days = parseInt(lastDays || '7', 10);
                const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
                targetMobiles = allUsers.filter(u => new Date(u.created_at) >= cutoffDate).map(u => u.mobile);
            } else if (targetMode === 'MIN_ORDERS' || targetMode === 'ZERO_ORDERS' || targetMode === 'MIN_SPENT') {
                const ordersSnap = await db.collection('orders').where('status', '!=', 'CANCELLED').get();
                const allOrders = ordersSnap.docs.map(d => d.data());
                
                allUsers.forEach(u => {
                    const userOrders = allOrders.filter(o => o.user_id === u.id);
                    const count = userOrders.length;
                    const spent = userOrders.reduce((acc, o) => acc + (o.total_amount || 0), 0);
                    
                    if (targetMode === 'MIN_ORDERS' && count >= parseInt(minOrders || '1', 10)) {
                        targetMobiles.push(u.mobile);
                    } else if (targetMode === 'ZERO_ORDERS' && count === 0) {
                        targetMobiles.push(u.mobile);
                    } else if (targetMode === 'MIN_SPENT' && spent >= parseInt(minSpent || '500', 10)) {
                        targetMobiles.push(u.mobile);
                    }
                });
            }
        }

        const now = new Date().toISOString();
        let insertedCount = 0;

        if (targetMode === 'ALL' || (targetMode !== 'SPECIFIC_USER' && targetMobiles.length === 0)) {
            const voucherId = 'VOUCH-' + crypto.randomBytes(3).toString('hex').toUpperCase();
            await db.collection('vouchers').doc(voucherId).set({
                id: voucherId, code: cleanCode, discount_type: discountType, discount_value: discountValue,
                min_order_amount: minOrderAmount || 0, assigned_mobile: null, is_active: 1, created_at: now
            });
            insertedCount = 1;
        } else {
            const batch = db.batch();
            for (const mobile of targetMobiles) {
                if (!mobile) continue;
                const voucherId = 'VOUCH-' + crypto.randomBytes(3).toString('hex').toUpperCase();
                const userCode = targetMobiles.length === 1 ? cleanCode : `${cleanCode}-${mobile.slice(-4)}`;
                batch.set(db.collection('vouchers').doc(voucherId), {
                    id: voucherId, code: userCode, discount_type: discountType, discount_value: discountValue,
                    min_order_amount: minOrderAmount || 0, assigned_mobile: mobile, is_active: 1, created_at: now
                });
                insertedCount++;
            }
            if (insertedCount > 0) {
                await batch.commit();
            }
        }

        res.json({
            success: true,
            message: targetMode === 'ALL'
                ? `Public voucher "${cleanCode}" created for all customers!`
                : `Smart targeting complete! Voucher code "${cleanCode}" assigned to ${insertedCount} targeted user(s).`,
            targetCount: insertedCount
        });
    } catch (err) {
        console.error('[Smart Voucher Creation Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to create targeted vouchers.' });
    }
});

// Admin Get All Vouchers
app.get('/api/admin/vouchers', async (req, res) => {
    try {
        const snapshot = await db.collection('vouchers').get();
        let vouchers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        vouchers.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json({ success: true, vouchers });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch vouchers.' });
    }
});

// GET /api/vouchers alias
app.get('/api/vouchers', async (req, res) => {
    try {
        const snapshot = await db.collection('vouchers').get();
        let vouchers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        vouchers.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json({ success: true, vouchers });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch vouchers.' });
    }
});

// Toggle Voucher Active/Inactive Status
const toggleVoucherStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;

        await db.collection('vouchers').doc(id).update({
            is_active: (isActive === true || isActive === 1) ? 1 : 0
        });

        res.json({
            success: true,
            message: (isActive === true || isActive === 1) ? 'Voucher activated.' : 'Voucher deactivated.'
        });
    } catch (err) {
        console.error('[Toggle Voucher Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to update voucher status.' });
    }
};

app.put('/api/admin/vouchers/:id/status', toggleVoucherStatus);
app.put('/api/vouchers/:id/status', toggleVoucherStatus);

// Delete Voucher
const deleteVoucher = async (req, res) => {
    try {
        const { id } = req.params;
        await db.collection('vouchers').doc(id).delete();
        res.json({ success: true, message: 'Voucher deleted successfully.' });
    } catch (err) {
        console.error('[Delete Voucher Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to delete voucher.' });
    }
};

app.delete('/api/admin/vouchers/:id', deleteVoucher);
app.delete('/api/vouchers/:id', deleteVoucher);

// Delete Account Endpoint (Soft Delete)
app.delete('/api/account/delete', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) {
            return res.status(400).json({ success: false, error: 'User ID missing from token.' });
        }

        // Soft Delete user in Firestore
        await db.collection('users').doc(userId).update({
            account_status: 'deleted'
        });

        res.json({ success: true, message: 'Account deleted successfully.' });
    } catch (err) {
        console.error('[Delete Account Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to delete account.' });
    }
});

// Export API for Vercel
module.exports = app;

