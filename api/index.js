const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const path = require('path');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const Razorpay = require('razorpay');
require('dotenv').config();

// Firebase Admin credentials: FIREBASE_SERVICE_ACCOUNT (JSON string) -> local file -> default credentials
try {
    if (getApps().length === 0) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        } else {
            initializeApp({ credential: cert(require('../firebaseServiceAccount.js')) });
        }
    }
} catch (error) {
    console.warn('No service account found. Trying default initialization.', error.message);
    if (getApps().length === 0) { initializeApp(); }
}

const db = getFirestore();
const { sendWhatsAppOtp, sendWhatsAppOrderConfirmation, sendWhatsAppBill } = require('./services/whatsappService');
const { sendEmailOtp, sendOrderBillEmail } = require('./services/emailService');
const { createShiprocketOrder, generateAwbCode, trackShipment } = require('./services/shiprocketService');

const app = express();
const PORT = process.env.PORT || 5000;

// Secrets must come from the environment - never from source code.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required.');
}
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'mukeshd1008raj@gmail.com').toLowerCase();

// CORS: only our own sites (plus localhost for development)
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const isAllowedOrigin = (origin) =>
    !origin ||
    EXTRA_ORIGINS.includes(origin) ||
    /^https?:\/\/(www\.)?jagirdarpublication\.in$/.test(origin) ||
    /^https:\/\/jagirdar[a-z0-9-]*\.vercel\.app$/.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

app.use(cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    optionsSuccessStatus: 200
}));

// Keep the raw body for webhook signature checks (Razorpay)
app.use(express.json({
    limit: '200kb',
    verify: (req, res, buf) => { req.rawBody = buf; }
}));

// --- Input hygiene ---
// Strips HTML tags/control characters from free text. Secrets (passwords, tokens, OTPs) are left
// untouched so they are never altered. Output is escaped where it is displayed.
const RAW_KEYS = new Set(['password', 'newPassword', 'oldPassword', 'currentPassword', 'token', 'idToken', 'otp', 'emailOtp', 'razorpaySignature', 'razorpayPaymentId', 'razorpayOrderId']);
function sanitizeInput(value, key) {
    if (typeof value === 'string') {
        if (RAW_KEYS.has(key)) return value;
        return value
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<[^>]*>/g, '')
            .replace(/[\0\x08\x1a]/g, '')
            .trim();
    } else if (Array.isArray(value)) {
        return value.map(v => sanitizeInput(v, key));
    } else if (typeof value === 'object' && value !== null) {
        const sanitized = {};
        for (const [k, val] of Object.entries(value)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            sanitized[k] = sanitizeInput(val, k);
        }
        return sanitized;
    }
    return value;
}

app.use((req, res, next) => {
    if (req.body && typeof req.body === 'object') req.body = sanitizeInput(req.body);
    next();
});

// --- Passwords: salted scrypt (legacy unsalted SHA-256 hashes still verify, then upgrade on login) ---
const hashPassword = (password) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
};
const verifyPassword = (password, stored) => {
    if (!stored || typeof password !== 'string') return { ok: false };
    if (stored.startsWith('scrypt$')) {
        const [, salt, hash] = stored.split('$');
        const test = crypto.scryptSync(password, salt, 64);
        const expected = Buffer.from(hash, 'hex');
        return { ok: expected.length === test.length && crypto.timingSafeEqual(test, expected) };
    }
    const legacy = crypto.createHash('sha256').update(password).digest('hex');
    return { ok: legacy === stored, needsUpgrade: legacy === stored };
};

// --- Brute-force protection for password logins (per account/identifier) ---
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
async function checkLoginLock(scope, identifier) {
    const ref = db.collection('login_attempts').doc(`${scope}_${crypto.createHash('sha1').update(String(identifier)).digest('hex')}`);
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : null;
    if (data && data.locked_until && data.locked_until > Date.now()) {
        const mins = Math.ceil((data.locked_until - Date.now()) / 60000);
        return { locked: true, ref, error: `Too many failed attempts. Try again in ${mins} minute(s).` };
    }
    return { locked: false, ref, data };
}
async function recordLoginFailure(lock) {
    const fails = ((lock.data && lock.data.locked_until && lock.data.locked_until <= Date.now()) ? 0 : (lock.data && lock.data.fails) || 0) + 1;
    const update = { fails, last_fail_at: Date.now() };
    if (fails >= LOGIN_MAX_FAILS) { update.locked_until = Date.now() + LOGIN_LOCK_MS; update.fails = 0; }
    await lock.ref.set(update);
}
async function clearLoginFailures(lock) {
    if (lock.data) await lock.ref.delete().catch(() => {});
}

// Check an OTP against its stored session, locking the session after too many wrong guesses
async function checkOtpWithLimit(collection, docId, session, entered, maxAttempts = 5) {
    const ref = db.collection(collection).doc(docId);
    if (!session || Date.now() > (session.expires_at || 0)) return { ok: false, error: 'Invalid or expired OTP.' };
    if ((session.attempts || 0) >= maxAttempts) {
        await ref.delete().catch(() => {});
        return { ok: false, error: 'Too many incorrect attempts. Please request a new OTP.' };
    }
    if (session.otp_code !== String(entered || '').trim()) {
        await ref.update({ attempts: (session.attempts || 0) + 1 }).catch(() => {});
        return { ok: false, error: 'Invalid or expired OTP.' };
    }
    return { ok: true };
}

// --- Encrypt secrets we must store (e.g. Shiprocket password) ---
const ENC_KEY = crypto.createHash('sha256').update(process.env.DATA_ENCRYPTION_KEY || JWT_SECRET).digest();
const encryptSecret = (plain) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return `enc:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
};
const decryptSecret = (value) => {
    if (typeof value !== 'string' || !value.startsWith('enc:')) return value; // legacy plain value
    const [, iv, tag, data] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
};

// Access key that lets a customer (or the admin) open one specific invoice/status link without logging in
const orderAccessKey = (orderId) => crypto.createHmac('sha256', JWT_SECRET).update(`order:${orderId}`).digest('hex').slice(0, 24);
const validOrderKey = (orderId, key) => {
    if (typeof key !== 'string' || !key) return false;
    const expected = orderAccessKey(orderId);
    return key.length === expected.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
};

// --- Security: Strict OTP Rate Limiting (Max 3 requests per 12 hours) ---
async function checkOtpRateLimit(identifier) {
    if (!identifier) return { allowed: true };
    const rawKey = String(identifier).trim().toLowerCase();
    const key = rawKey.replace(/\D/g, '').slice(-10) || rawKey;
    const docRef = db.collection('otp_rate_limits').doc(key);
    const docSnap = await docRef.get();
    const now = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;

    if (docSnap.exists) {
        const data = docSnap.data();
        const firstReqTime = data.first_request_at || now;
        const timePassed = now - firstReqTime;

        if (timePassed < TWELVE_HOURS) {
            if (data.count >= 3) {
                const hoursLeft = Math.ceil((TWELVE_HOURS - timePassed) / (60 * 60 * 1000));
                return {
                    allowed: false,
                    error: `OTP limit reached. You can request OTP maximum 3 times. Please try again after ${hoursLeft} hour(s).`
                };
            }
            await docRef.update({
                count: data.count + 1,
                last_request_at: now
            });
        } else {
            await docRef.set({
                identifier: key,
                count: 1,
                first_request_at: now,
                last_request_at: now
            });
        }
    } else {
        await docRef.set({
            identifier: key,
            count: 1,
            first_request_at: now,
            last_request_at: now
        });
    }

    return { allowed: true };
}

const rootDir = path.join(__dirname, '..');
// Serve only the public website files - never source, config, database or package files.
const PUBLIC_PATH = /^\/(?:[A-Za-z0-9_-]+\.html|assets\/.+|images\/.+|favicon\.[a-z]+|robots\.txt|sitemap\.xml)$/;
const staticFiles = express.static(rootDir, { dotfiles: 'deny', index: false });
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next(); // API routes only - never serve files from /api
    if (req.path === '/' || PUBLIC_PATH.test(req.path)) return staticFiles(req, res, next);
    return res.status(404).sendFile(path.join(rootDir, '404.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(rootDir, 'index.html'));
});

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

// Admin-only guard: valid admin token AND the admin account still exists and is not blocked
const adminOnly = [authenticateUser, async (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Forbidden. Admin access required.' });
    }
    try {
        const adminDoc = await db.collection('admins').doc(req.user.id).get();
        if (!adminDoc.exists || adminDoc.data().is_blocked) {
            return res.status(403).json({ success: false, error: 'Admin account is not active.' });
        }
        next();
    } catch (err) {
        console.error('[Admin Guard Error]:', err);
        res.status(500).json({ success: false, error: 'Authorization check failed.' });
    }
}];

// --- In-Memory Settings Cache for 0ms Latency ---
let cachedFrontendSettings = null;
let lastSettingsFetchTime = 0;
// Serverless runs several instances, each with its own memory, so keep the cache very short-lived
const SETTINGS_CACHE_TTL = 3000; // 3 seconds TTL

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
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, settings: cachedFrontendSettings });
    }
    const settings = await fetchSettingsFromDb();
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, settings });
});

// Settings PUT Endpoint (Updates Memory Cache instantly + Persists to DB)
app.put('/api/settings/frontend', adminOnly, async (req, res) => {
    try {
        const { isOrderNowEnabled, bookPrice } = req.body;
        // Only write the fields that were actually sent. Writing the whole cached object
        // would overwrite the other setting (e.g. price) with this instance's stale copy.
        const changes = {};
        if (isOrderNowEnabled !== undefined) {
            changes.isOrderNowEnabled = !!isOrderNowEnabled;
        }
        if (bookPrice !== undefined) {
            const parsedPrice = parseInt(bookPrice, 10);
            if (!isNaN(parsedPrice) && parsedPrice > 0) {
                changes.bookPrice = parsedPrice;
            }
        }

        // 1. Persist to Firestore DB (source of truth)
        await db.collection('settings').doc('frontend').set(changes, { merge: true });

        // 2. Reload the merged result so the cache and response reflect the stored values
        const updateData = await fetchSettingsFromDb();

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

        // Strict 12-Hour Rate Limit (Max 3 OTP requests)
        const rateLimit = await checkOtpRateLimit(cleanMobile);
        if (!rateLimit.allowed) {
            return res.status(429).json({ success: false, error: rateLimit.error });
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

        if (!smsResult.success) {
            return res.status(400).json({
                success: false,
                error: smsResult.error || 'Failed to send WhatsApp OTP. Please ensure your WhatsApp access token is valid.',
                provider: smsResult.provider
            });
        }

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

// Signup - Send OTP
app.post('/api/auth/send-signup-otp', async (req, res) => {
    try {
        const { mobile, email } = req.body;
        const cleanMobile = (mobile || '').replace(/\D/g, '').slice(-10);

        if (!/^[6-9]\d{9}$/.test(cleanMobile)) {
            return res.status(400).json({ success: false, error: 'Please enter a valid 10-digit Indian mobile number.' });
        }

        const rateLimit = await checkOtpRateLimit(cleanMobile);
        if (!rateLimit.allowed) {
            return res.status(429).json({ success: false, error: rateLimit.error });
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

        const rateLimit = await checkOtpRateLimit(cleanMobile);
        if (!rateLimit.allowed) {
            return res.status(429).json({ success: false, error: rateLimit.error });
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

        const smsResult = await sendWhatsAppOtp(cleanMobile, otp);
        if (!smsResult.success) {
            return res.status(400).json({
                success: false,
                error: smsResult.error || 'Failed to send WhatsApp OTP. Check Meta Access Token in .env.'
            });
        }
        res.json({ success: true, message: 'Signup OTP sent successfully to your WhatsApp.' });
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
        
        const chk = await checkOtpWithLimit('otp_sessions', cleanMobile, session, otp);
        if (!chk.ok) {
            return res.status(400).json({ success: false, error: chk.error });
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

        const rateLimit = await checkOtpRateLimit(cleanEmail);
        if (!rateLimit.allowed) {
            return res.status(429).json({ success: false, error: rateLimit.error });
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
        
        const chk = await checkOtpWithLimit('email_otp_sessions', cleanEmail, session, otp);
        if (!chk.ok) {
            return res.status(400).json({ success: false, error: chk.error });
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

        // Validate Email OTP if email provided and email OTP was generated
        if (cleanEmail) {
            const emailSessionDoc = await db.collection('email_otp_sessions').doc(cleanEmail).get();
            const emailSession = emailSessionDoc.exists ? emailSessionDoc.data() : null;
            if (!emailSession || Date.now() > (emailSession.expires_at || 0)) {
                return res.status(400).json({ success: false, error: 'Email OTP expired or not found. Please verify your email again.' });
            }
            if (!emailSession.is_verified) {
                const providedEmailOtp = String(emailOtp || '').trim();
                if (emailSession.otp_code !== providedEmailOtp) {
                    return res.status(400).json({ success: false, error: 'Invalid Email OTP code.' });
                }
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

        const lockKey = trimmedIdentifier.includes('@') ? cleanEmail : (cleanEmail.replace(/\D/g, '').slice(-10) || cleanEmail);
        const lock = await checkLoginLock('user', lockKey);
        if (lock.locked) {
            return res.status(429).json({ success: false, error: lock.error });
        }

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

        const pw = verifyPassword(password, user.password_hash);
        if (!pw.ok) {
            await recordLoginFailure(lock);
            return res.status(400).json({ success: false, error: 'Invalid credentials.' });
        }
        await clearLoginFailures(lock);
        if (pw.needsUpgrade) {
            await db.collection('users').doc(user.id).update({ password_hash: hashPassword(password) }).catch(() => {});
        }

        const token = jwt.sign({ id: user.id, mobile: user.mobile || '', name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, message: 'Login successful!', token, user: { id: user.id, name: user.name, mobile: user.mobile || '', email: user.email, is_mobile_verified: user.is_mobile_verified || 0, is_email_verified: user.is_email_verified || 0, loggedIn: true } });
    } catch (err) {
        console.error('[Login Error]:', err);
        res.status(500).json({ success: false, error: 'Login failed.' });
    }
});

// Verify a Firebase ID token (from Google sign-in) and return the Google-verified email
async function verifyGoogleIdToken(idToken) {
    if (!idToken || typeof idToken !== 'string') return null;
    try {
        const decoded = await getAuth().verifyIdToken(idToken);
        if (!decoded.email || decoded.email_verified === false) return null;
        return { email: decoded.email.toLowerCase(), name: decoded.name || '', uid: decoded.uid };
    } catch (err) {
        console.warn('[Google ID token rejected]:', err.message);
        return null;
    }
}

// Google Login Endpoint
app.post('/api/auth/google-login', async (req, res) => {
    try {
        const { name, idToken } = req.body;
        const google = await verifyGoogleIdToken(idToken);
        if (!google) return res.status(401).json({ success: false, error: 'Google sign-in could not be verified. Please try again.' });

        const cleanEmail = google.email;
        const firebaseUid = google.uid;
        const userQ = await db.collection('users').where('email', '==', cleanEmail).limit(1).get();
        
        if (!userQ.empty) {
            const userDoc = userQ.docs[0].data();
            const userId = userQ.docs[0].id;

            if (userDoc.is_blocked === 1) {
                return res.status(403).json({ success: false, error: 'Your account has been blocked by administrator.' });
            }
            if (userDoc.account_status === 'deleted') {
                return res.status(403).json({ success: false, error: 'Account not found or deleted.' });
            }

            // IF ACCOUNT ALREADY EXISTS & HAS A VERIFIED MOBILE NUMBER -> LOGIN DIRECTLY!
            if (userDoc.mobile && (userDoc.is_mobile_verified === 1 || userDoc.is_mobile_verified === true)) {
                const token = jwt.sign(
                    { id: userId, mobile: userDoc.mobile, name: userDoc.name, email: userDoc.email },
                    JWT_SECRET,
                    { expiresIn: '30d' }
                );
                return res.json({
                    success: true,
                    isNewUser: false,
                    message: 'Google login successful!',
                    token,
                    user: {
                        id: userId,
                        name: userDoc.name,
                        mobile: userDoc.mobile,
                        email: userDoc.email,
                        is_mobile_verified: 1,
                        is_email_verified: 1,
                        loggedIn: true
                    }
                });
            }
        }

        // IF ACCOUNT IS NEW OR MOBILE NUMBER IS NOT YET VERIFIED -> ASK FOR PHONE NUMBER VERIFICATION!
        res.json({
            success: true,
            isNewUser: true,
            email: cleanEmail,
            name: name || google.name || 'Google User',
            firebaseUid: firebaseUid || ''
        });
    } catch (err) {
        console.error('[Google Login Error]:', err);
        res.status(500).json({ success: false, error: 'Server error during Google login.' });
    }
});

// Complete Google Signup (Set Password & Mobile)
app.post('/api/auth/google-signup-complete', async (req, res) => {
    try {
        const { name, mobile, password, otp, idToken } = req.body;
        const google = await verifyGoogleIdToken(idToken);
        if (!google) return res.status(401).json({ success: false, error: 'Google sign-in could not be verified. Please sign in with Google again.' });
        const cleanMobile = (mobile || '').replace(/\D/g, '').slice(-10);
        const cleanEmail = google.email;

        if (!cleanEmail || !password || !cleanMobile || !otp) {
            return res.status(400).json({ success: false, error: 'Email, password, mobile, and OTP are required.' });
        }

        // Verify OTP from otp_sessions
        const sessionDoc = await db.collection('otp_sessions').doc(cleanMobile).get();
        const session = sessionDoc.exists ? sessionDoc.data() : null;
        if (!session || Date.now() > session.expires_at) {
            return res.status(400).json({ success: false, error: 'Invalid or expired OTP.' });
        }
        if (session.otp_code !== otp) {
            const nextAttempts = (session.attempts || 0) + 1;
            if (nextAttempts >= 3) {
                await db.collection('otp_sessions').doc(cleanMobile).delete();
                return res.status(400).json({ success: false, error: 'Too many incorrect attempts. Please request a new OTP.' });
            }
            await db.collection('otp_sessions').doc(cleanMobile).update({ attempts: nextAttempts });
            return res.status(400).json({ success: false, error: 'Invalid or expired OTP.' });
        }

        // Delete OTP session after successful verification
        await db.collection('otp_sessions').doc(cleanMobile).delete();

        const passwordHash = hashPassword(password);
        const userQ = await db.collection('users').where('email', '==', cleanEmail).limit(1).get();
        
        let userId;
        let userDoc;

        if (!userQ.empty) {
            // Update existing Google user record with verified mobile & password
            userId = userQ.docs[0].id;
            const existingData = userQ.docs[0].data();
            userDoc = {
                ...existingData,
                mobile: cleanMobile,
                password_hash: passwordHash,
                is_mobile_verified: 1,
                is_email_verified: 1,
                auth_provider: 'google'
            };
            await db.collection('users').doc(userId).update({
                mobile: cleanMobile,
                password_hash: passwordHash,
                is_mobile_verified: 1,
                is_email_verified: 1,
                auth_provider: 'google'
            });
        } else {
            // Create new user record
            userId = 'USR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
            const now = new Date().toISOString();
            userDoc = { 
                id: userId, 
                name: (name || 'Google User').trim(), 
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

        const token = jwt.sign(
            { id: userId, mobile: cleanMobile, name: userDoc.name, email: cleanEmail },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            success: true,
            message: 'Google profile complete and logged in!',
            token,
            user: {
                id: userId,
                name: userDoc.name,
                mobile: cleanMobile,
                email: cleanEmail,
                is_mobile_verified: 1,
                is_email_verified: 1,
                loggedIn: true
            }
        });
    } catch (err) {
        console.error('[Google Signup Complete Error]:', err);
        res.status(500).json({ success: false, error: 'Server error completing Google signup.' });
    }
});

// Forgot Password - Send OTP to WhatsApp / Email
app.post('/api/auth/forgot-password-otp', async (req, res) => {
    try {
        const { email, identifier, mobile } = req.body;
        const inputId = (identifier || email || mobile || '').trim();
        if (!inputId) return res.status(400).json({ success: false, error: 'Email or Mobile number is required.' });

        const rateLimit = await checkOtpRateLimit(inputId);
        if (!rateLimit.allowed) {
            return res.status(429).json({ success: false, error: rateLimit.error });
        }

        let user = null;
        const cleanEmail = inputId.toLowerCase();
        const cleanMobile = inputId.replace(/\D/g, '').slice(-10);

        if (inputId.includes('@')) {
            const userQ = await db.collection('users').where('email', '==', cleanEmail).limit(1).get();
            if (!userQ.empty) user = { id: userQ.docs[0].id, ...userQ.docs[0].data() };
        } else if (/^[6-9]\d{9}$/.test(cleanMobile)) {
            const userQ = await db.collection('users').where('mobile', '==', cleanMobile).limit(1).get();
            if (!userQ.empty) user = { id: userQ.docs[0].id, ...userQ.docs[0].data() };
        }

        if (!user) {
            const uQ1 = await db.collection('users').where('email', '==', cleanEmail).limit(1).get();
            if (!uQ1.empty) {
                user = { id: uQ1.docs[0].id, ...uQ1.docs[0].data() };
            } else if (cleanMobile) {
                const uQ2 = await db.collection('users').where('mobile', '==', cleanMobile).limit(1).get();
                if (!uQ2.empty) user = { id: uQ2.docs[0].id, ...uQ2.docs[0].data() };
            }
        }

        if (!user) {
            return res.status(400).json({ success: false, error: 'No account found with that email or mobile number.' });
        }

        const otp = crypto.randomInt(100000, 999999).toString();
        console.log(`\n==================================================`);
        console.log(`[STRICT WHATSAPP FORGOT PASSWORD OTP] User: ${user.name || user.email} | OTP: ${otp}`);
        console.log(`==================================================\n`);
        const expiresAt = Date.now() + 10 * 60 * 1000;
        const sessionKey = (user.email || user.mobile || cleanEmail).toLowerCase();

        await db.collection('email_otp_sessions').doc(sessionKey).set({
            user_id: user.id,
            email: user.email || '',
            mobile: user.mobile || '',
            otp_code: otp,
            attempts: 0,
            expires_at: expiresAt,
            created_at: Date.now()
        }, { merge: true });

        let whatsappSent = false;
        if (user.mobile) {
            try {
                await sendWhatsAppOtp(user.mobile, otp, user.name);
                whatsappSent = true;
            } catch (waErr) {
                console.error('[Forgot Password WhatsApp OTP Error]:', waErr);
            }
        }

        if (user.email) {
            try {
                await sendEmailOtp(user.email, otp, user.name);
            } catch (eErr) {
                console.error('[Forgot Password Email OTP Error]:', eErr);
            }
        }

        res.json({
            success: true,
            message: whatsappSent
                ? `Password reset OTP sent successfully to your WhatsApp (+91 ${user.mobile})${user.email ? ' and Email' : ''}.`
                : 'Password reset OTP sent to email.'
        });
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
        const chk = await checkOtpWithLimit('email_otp_sessions', email.trim().toLowerCase(), session, otp);
        if (!chk.ok) {
            return res.status(400).json({ success: false, error: chk.error });
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

        if (String(newPassword).length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
        }

        const sessionDoc = await db.collection('email_otp_sessions').doc(email.trim().toLowerCase()).get();
        const session = sessionDoc.exists ? sessionDoc.data() : null;
        const chk = await checkOtpWithLimit('email_otp_sessions', email.trim().toLowerCase(), session, otp);
        if (!chk.ok || !session.user_id) {
            return res.status(400).json({ success: false, error: chk.error || 'Invalid or expired OTP.' });
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
// (removed) /api/auth/firebase-login: it issued tokens for any mobile number without verification.

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
        const { name, mobile, address, city, state, pincode } = req.body;
        const userId = req.user.id;

        if (!name || !mobile || !address || !city || !pincode) {
            return res.status(400).json({ success: false, error: 'All fields are required.' });
        }

        // Check if user has any existing addresses. If not, make this default.
        const existing = await db.collection('user_addresses').where('user_id', '==', userId).limit(1).get();
        const isDefault = existing.empty ? 1 : 0;

        const addressId = 'ADDR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const now = new Date().toISOString();

        const newAddress = { id: addressId, user_id: userId, name, mobile, address, city, state: state || '', pincode, is_default: isDefault, created_at: now };
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
// Shared voucher check: assigned to this customer, active, not used before, minimum order met
async function evaluateVoucher({ code, subtotal, mobile, userId }) {
    const cleanCode = String(code || '').trim().toUpperCase();
    const userMobile = String(mobile || '').replace(/\D/g, '').slice(-10);
    if (!cleanCode) return { error: 'Please enter a valid voucher code.' };
    if (!userMobile) return { error: 'Invalid voucher code or it is not assigned to your account.' };

    const vQuery = await db.collection('vouchers')
        .where('is_active', '==', 1)
        .where('assigned_mobile', '==', userMobile)
        .get();
    let voucher = null;
    vQuery.forEach(doc => {
        if (String(doc.data().code || '').toUpperCase() === cleanCode) voucher = { id: doc.id, ...doc.data() };
    });
    if (!voucher) return { error: 'Invalid voucher code or it is not assigned to your account.' };

    // Already used in a previous (non-cancelled) order?
    const used = new Map();
    const q1 = await db.collection('orders').where('shipping_mobile', '==', userMobile).get();
    q1.forEach(d => used.set(d.id, d.data()));
    if (userId) {
        const q2 = await db.collection('orders').where('user_id', '==', userId).get();
        q2.forEach(d => used.set(d.id, d.data()));
    }
    for (const [id, o] of used) {
        if (o.status === 'CANCELLED' || !o.applied_voucher) continue;
        const codes = String(o.applied_voucher).split(',').map(c => c.trim().toUpperCase());
        if (codes.includes(cleanCode)) {
            return { error: `You have already used voucher "${cleanCode}" in a previous order (#${id}).` };
        }
    }

    if (subtotal < (voucher.min_order_amount || 0)) {
        return { error: `Voucher "${voucher.code}" requires a minimum order of ₹${voucher.min_order_amount}.` };
    }

    let discount = 0;
    if (voucher.discount_type === 'FLAT') discount = Number(voucher.discount_value) || 0;
    else if (voucher.discount_type === 'PERCENT') discount = Math.round((subtotal * (Number(voucher.discount_value) || 0)) / 100);
    discount = Math.max(0, Math.min(discount, subtotal));

    return { voucher, cleanCode, discount };
}

// Apply a voucher (preview only - the price is always recalculated on the server when the order is created)
app.post('/api/vouchers/apply', authenticateUser, async (req, res) => {
    try {
        const { code, cartAmount } = req.body;
        const defaultBookPrice = await getStoreBookPrice();
        const requested = parseInt(cartAmount || defaultBookPrice, 10);
        const amount = Number.isFinite(requested) && requested > 0 ? requested : defaultBookPrice;

        const result = await evaluateVoucher({ code, subtotal: amount, mobile: req.user.mobile, userId: req.user.id });
        if (result.error) {
            return res.status(400).json({ success: false, error: result.error });
        }
        res.json({
            success: true,
            code: result.voucher.code,
            rawCode: result.cleanCode,
            discount: result.discount,
            finalAmount: Math.max(0, amount - result.discount),
            message: `Voucher ${result.cleanCode} applied! You saved ₹${result.discount}.`
        });
    } catch (err) {
        console.error('[Apply Voucher Error]:', err);
        res.status(500).json({ success: false, error: 'Voucher evaluation failed.' });
    }
});

// ==========================================
// 3. ORDERS MODULE (/api/orders)
// ==========================================

// Create Draft Order (login required; price and discount are always computed on the server)
app.post('/api/orders/create', authenticateUser, async (req, res) => {
    try {
        const { quantity, shippingName, shippingMobile, shippingAddress, shippingCity, shippingState, shippingPincode, voucherCode, paymentMethod } = req.body;

        const userId = req.user.id;
        const userName = req.user.name || 'Customer';
        const userMobile = req.user.mobile || '';

        const qty = Math.min(100, Math.max(1, parseInt(quantity || 1, 10) || 1));
        const unitPrice = await getStoreBookPrice();
        const subtotal = qty * unitPrice;

        let discount = 0;
        let appliedVoucher = '';
        if (voucherCode) {
            const result = await evaluateVoucher({ code: voucherCode, subtotal, mobile: userMobile, userId });
            if (result.error) {
                return res.status(400).json({ success: false, error: result.error });
            }
            discount = result.discount;
            appliedVoucher = result.voucher.code;
        }

        const totalAmount = Math.max(0, subtotal - discount);

        // Atomic order number (two simultaneous orders can never get the same number)
        const counterDocRef = db.collection('metadata').doc('order_counter');
        const orderId = await db.runTransaction(async (t) => {
            const counterDoc = await t.get(counterDocRef);
            const nextSeq = counterDoc.exists ? counterDoc.data().last_seq + 1 : 2101;
            t.set(counterDocRef, { last_seq: nextSeq });
            return 'JP-KD' + nextSeq;
        });

        const now = new Date().toISOString();

        const createdOrder = {
            id: orderId, user_id: userId, book_title: 'ब्रह्मांशावतार श्री खेतेश्वर दाता', quantity: qty, unit_price: unitPrice, discount_amount: discount, total_amount: totalAmount,
            applied_voucher: appliedVoucher, shipping_name: shippingName || userName, shipping_mobile: shippingMobile || userMobile, shipping_address: shippingAddress || '', shipping_city: shippingCity || '',
            shipping_state: shippingState || 'Rajasthan', shipping_pincode: shippingPincode || '', payment_method: paymentMethod || 'UPI', status: 'PENDING', created_at: now
        };

        await db.collection('orders').doc(orderId).set(createdOrder);
        res.json({ success: true, order: { ...createdOrder, access_key: orderAccessKey(orderId) } });
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
        
        // Fetch transactions for these orders only (Firestore 'in' allows 10 ids per query)
        if (orders.length > 0) {
            const txnByOrder = {};
            for (let i = 0; i < orders.length; i += 10) {
                const chunk = orders.slice(i, i + 10).map(o => o.id);
                const tSnapshot = await db.collection('transactions').where('order_id', 'in', chunk).get();
                tSnapshot.forEach(d => { if (!txnByOrder[d.data().order_id]) txnByOrder[d.data().order_id] = d.id; });
            }
            orders = orders.map(o => ({ ...o, transaction_id: txnByOrder[o.id] || null, access_key: orderAccessKey(o.id) }));
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

// Optional login: returns the decoded token or null
function optionalUser(req) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return null;
    try { return jwt.verify(h.split(' ')[1], JWT_SECRET); } catch (e) { return null; }
}
// Who may see an order: its owner, an admin, or someone holding the order's access key
function canAccessOrder(orderData, orderId, user, key) {
    if (user && user.role === 'admin') return true;
    if (user && (orderData.user_id === user.id || (user.mobile && orderData.shipping_mobile === user.mobile))) return true;
    return validOrderKey(orderId, key);
}
const isPaidStatus = (status) => ['PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED'].includes(status);

// Get Order Details for Invoice/Bill viewing (paid orders only; owner, admin or access key)
app.get('/api/orders/:id/public', async (req, res) => {
    try {
        const { id } = req.params;
        const orderDoc = await db.collection('orders').doc(id).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const orderData = orderDoc.data();
        if (!canAccessOrder(orderData, id, optionalUser(req), req.query.key)) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const isPaid = isPaidStatus(orderData.status);

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

// Get Order Status (For Order Confirmation Verification; owner, admin or access key)
app.get('/api/orders/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const orderDoc = await db.collection('orders').doc(id).get();
        if (!orderDoc.exists || !canAccessOrder(orderDoc.data(), id, optionalUser(req), req.query.key)) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const order = { id: orderDoc.id, ...orderDoc.data() };
        const isPaid = isPaidStatus(order.status);
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

// Update Order with Manual UTR (Direct UPI) - only the order's owner, only while the order is unpaid
app.put('/api/orders/:id/utr', authenticateUser, async (req, res) => {
    try {
        const { id } = req.params;
        const { utr, paymentMethod } = req.body;

        if (!utr || !/^[A-Za-z0-9]{6,30}$/.test(String(utr).trim())) {
            return res.status(400).json({ success: false, error: 'Invalid UTR reference number.' });
        }

        const orderDoc = await db.collection('orders').doc(id).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const order = { id: orderDoc.id, ...orderDoc.data() };
        if (order.user_id !== req.user.id) {
            return res.status(403).json({ success: false, error: 'Unauthorized for this order.' });
        }
        if (!['PENDING', 'PENDING_VERIFICATION'].includes(order.status)) {
            return res.status(400).json({ success: false, error: 'This order is not awaiting payment.' });
        }

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
// 4. RAZORPAY & PAYMENT GATEWAY (/api/payment)
// ==========================================

const getRazorpayCreds = () => ({
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET
});

// Create Razorpay Order (owner only; amount comes from our stored order, never from the browser)
app.post('/api/payment/razorpay/create-order', authenticateUser, async (req, res) => {
    try {
        const { orderId } = req.body;
        const orderDoc = await db.collection('orders').doc(String(orderId || '')).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const order = { id: orderDoc.id, ...orderDoc.data() };
        if (order.user_id !== req.user.id) {
            return res.status(403).json({ success: false, error: 'Unauthorized for this order.' });
        }
        if (order.status !== 'PENDING') {
            return res.status(400).json({ success: false, error: 'This order cannot be paid (already paid or closed).' });
        }

        const amountPaise = Math.round(order.total_amount * 100);
        const { keyId: rzpKeyId, keySecret: rzpKeySecret } = getRazorpayCreds();

        if (!rzpKeyId || !rzpKeySecret) {
            return res.status(500).json({ success: false, error: 'Razorpay API credentials not configured properly in server environment.' });
        }
        if (amountPaise < 100) {
            return res.status(400).json({ success: false, error: 'Order total is too low to pay online.' });
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

        // Remember which Razorpay order belongs to this order, so a payment can't be reused elsewhere
        await db.collection('orders').doc(order.id).update({ razorpay_order_id: rzpOrderId });

        res.json({
            success: true,
            key: rzpKeyId,
            amount: amountPaise,
            currency: 'INR',
            razorpayOrderId: rzpOrderId,
            orderId: order.id,
            customerName: order.shipping_name,
            customerMobile: order.shipping_mobile,
            accessKey: orderAccessKey(order.id)
        });
    } catch (err) {
        console.error('[Razorpay Create Order Server Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to create payment order.' });
    }
});

// Shiprocket settings with the stored password decrypted for use
function readShiprocketSettings(doc) {
    const data = doc.exists ? { ...doc.data() } : {};
    if (data.password) {
        try { data.password = decryptSecret(data.password); } catch (e) { delete data.password; }
    }
    return data;
}

// Marks an order PAID exactly once, then sends bill/WhatsApp and syncs Shiprocket.
// Safe to call from both the browser verify step and the Razorpay webhook.
async function finalizePaidOrder(orderId, payment) {
    const orderRef = db.collection('orders').doc(orderId);
    const now = new Date().toISOString();

    const claimed = await db.runTransaction(async (t) => {
        const snap = await t.get(orderRef);
        if (!snap.exists) return false;
        const status = snap.data().status;
        if (isPaidStatus(status) || status === 'CANCELLED') return false;
        t.update(orderRef, {
            status: 'PAID',
            tracking_number: 'PENDING',
            razorpay_payment_id: payment.razorpayPaymentId,
            razorpay_order_id: payment.razorpayOrderId,
            razorpay_signature: payment.razorpaySignature || '',
            paid_at: now
        });
        return true;
    });
    if (!claimed) return { alreadyProcessed: true };

    const txnId = 'TXN-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const updatedOrderDoc = await orderRef.get();
    const order = { id: updatedOrderDoc.id, ...updatedOrderDoc.data() };

    await db.collection('transactions').doc(txnId).set({
        id: txnId, order_id: orderId, razorpay_order_id: payment.razorpayOrderId || '', razorpay_payment_id: payment.razorpayPaymentId || '', razorpay_signature: payment.razorpaySignature || '', payment_method: order.payment_method || 'Razorpay', amount: order.total_amount, status: 'SUCCESS', created_at: new Date().toISOString()
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

        // Auto Sync with Shiprocket if credentials configured
        await (async () => {
            try {
                const settingsDoc = await db.collection('settings').doc('shiprocket').get();
                const settings = readShiprocketSettings(settingsDoc);
                const hasCreds = settings.email || settings.user || process.env.SHIPROCKET_EMAIL || process.env.SHIPROCKET_USER;
                if (hasCreds) {
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
                        await orderRef.update(srUpdate);
                        console.log(`[Auto Shiprocket]: Order ${orderId} synced to Shiprocket (ID: ${srRes.shiprocket_order_id})`);
                    } else {
                        console.warn(`[Auto Shiprocket Warning]: ${srRes.error}`);
                    }
                }
            } catch (srErr) {
                console.warn('[Auto Shiprocket Order Error]:', srErr.message);
            }
        })();

    return { alreadyProcessed: false };
}

const safeEqualHex = (a, b) => {
    const x = Buffer.from(String(a || ''), 'utf8');
    const y = Buffer.from(String(b || ''), 'utf8');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Verify Payment HMAC Signature (called by the browser right after payment)
app.post('/api/payment/razorpay/verify', authenticateUser, async (req, res) => {
    try {
        const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
        const { keySecret: rzpSecret } = getRazorpayCreds();

        if (!orderId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
            return res.status(400).json({ success: false, error: 'Missing required payment response details.' });
        }
        if (!rzpSecret) {
            return res.status(500).json({ success: false, error: 'Payment gateway is not configured.' });
        }

        const orderRef = db.collection('orders').doc(String(orderId));
        const orderDoc = await orderRef.get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }
        const orderData = orderDoc.data();
        if (orderData.user_id !== req.user.id) {
            return res.status(403).json({ success: false, error: 'Unauthorized for this order.' });
        }

        // The payment must belong to the Razorpay order we created for THIS order
        if (!orderData.razorpay_order_id || orderData.razorpay_order_id !== razorpayOrderId) {
            return res.status(400).json({ success: false, error: 'Payment order ID mismatch.' });
        }

        const generatedSignature = crypto
            .createHmac('sha256', rzpSecret)
            .update(`${razorpayOrderId}|${razorpayPaymentId}`)
            .digest('hex');
        if (!safeEqualHex(generatedSignature, razorpaySignature)) {
            return res.status(400).json({ success: false, error: 'Cryptographic payment signature verification failed.' });
        }

        await finalizePaidOrder(orderId, { razorpayOrderId, razorpayPaymentId, razorpaySignature });

        res.json({
            success: true,
            message: 'Payment verified successfully!',
            orderId: orderId,
            trackingNumber: 'PENDING'
        });
    } catch (err) {
        console.error('[Payment Verify Error]:', err);
        res.status(500).json({ success: false, error: 'Payment verification failed.' });
    }
});

// Razorpay webhook: confirms payments even if the customer closes the tab before verify runs.
// Set RAZORPAY_WEBHOOK_SECRET and point the Razorpay dashboard webhook (payment.captured / order.paid) here.
app.post('/api/payment/razorpay/webhook', async (req, res) => {
    try {
        const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!secret) return res.status(503).json({ success: false, error: 'Webhook not configured.' });

        const signature = req.headers['x-razorpay-signature'];
        const expected = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('hex');
        if (!safeEqualHex(expected, signature)) {
            return res.status(400).json({ success: false, error: 'Invalid signature.' });
        }

        const event = req.body && req.body.event;
        if (event !== 'payment.captured' && event !== 'order.paid') {
            return res.json({ success: true, ignored: true });
        }
        const payment = req.body.payload && req.body.payload.payment && req.body.payload.payment.entity;
        if (!payment || !payment.order_id) return res.json({ success: true, ignored: true });

        const snap = await db.collection('orders').where('razorpay_order_id', '==', payment.order_id).limit(1).get();
        if (snap.empty) return res.json({ success: true, ignored: true });
        const orderDoc = snap.docs[0];
        const order = orderDoc.data();

        // Only accept a payment that matches the exact amount we asked for
        if (Number(payment.amount) !== Math.round(order.total_amount * 100)) {
            console.warn(`[Razorpay Webhook]: amount mismatch for ${orderDoc.id}`);
            return res.json({ success: true, ignored: true });
        }

        await finalizePaidOrder(orderDoc.id, { razorpayOrderId: payment.order_id, razorpayPaymentId: payment.id, razorpaySignature: 'WEBHOOK' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Razorpay Webhook Error]:', err);
        res.status(500).json({ success: false });
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
        const lock = await checkLoginLock('admin', cleanEmail);
        if (lock.locked) {
            return res.status(429).json({ success: false, error: lock.error });
        }

        // Firestore doesn't support case-insensitive querying easily. We assume email is stored in lowercase, or we just fetch and compare
        const adminQ = await db.collection('admins').where('email', '==', cleanEmail).limit(1).get();
        const admin = adminQ.empty ? null : { id: adminQ.docs[0].id, ...adminQ.docs[0].data() };

        const pw = admin ? verifyPassword(String(password || ''), admin.password_hash) : { ok: false };
        if (!admin || !pw.ok) {
            await recordLoginFailure(lock);
            return res.status(401).json({ success: false, error: 'Invalid admin email or password.' });
        }
        await clearLoginFailures(lock);
        if (pw.needsUpgrade) {
            await db.collection('admins').doc(admin.id).update({ password_hash: hashPassword(String(password)) }).catch(() => {});
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
        if (String(req.user.email || '').toLowerCase() !== SUPER_ADMIN_EMAIL) {
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
        const passwordHash = hashPassword(password);

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
    if (req.user.role !== 'admin' || String(req.user.email || '').toLowerCase() !== SUPER_ADMIN_EMAIL) {
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
        
        const newHash = hashPassword(newPassword);
        await db.collection('admins').doc(id).update({ password_hash: newHash });
        res.json({ success: true, message: 'Admin password changed successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to change password.' });
    }
});

// Admin Stats
app.get('/api/admin/stats', adminOnly, async (req, res) => {
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
app.get('/api/admin/orders', adminOnly, async (req, res) => {
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
app.put('/api/admin/orders/:id/status', adminOnly, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, trackingNumber } = req.body;

        const ALLOWED_STATUSES = ['PENDING', 'PENDING_VERIFICATION', 'PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'REFUNDED'];
        if (!ALLOWED_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, error: 'Invalid order status.' });
        }
        const orderCheck = await db.collection('orders').doc(id).get();
        if (!orderCheck.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }

        const statusUpdate = { status };
        if (trackingNumber !== undefined) statusUpdate.tracking_number = trackingNumber;
        await db.collection('orders').doc(id).update(statusUpdate);

        const updatedDoc = await db.collection('orders').doc(id).get();
        const updated = { id: updatedDoc.id, ...updatedDoc.data() };

        if (status === 'PAID') {
            if (updated.shipping_mobile) {
                try {
                    await sendWhatsAppOrderConfirmation(updated, updated.shipping_mobile);
                } catch (waErr) {
                    console.error('[Admin Status Update - WhatsApp Confirmation Error]:', waErr);
                }
            }

            // Auto-Sync to Shiprocket if not already synced
            if (!updated.shiprocket_order_id) {
                (async () => {
                    try {
                        const settingsDoc = await db.collection('settings').doc('shiprocket').get();
                        const settings = readShiprocketSettings(settingsDoc);
                        const srRes = await createShiprocketOrder(updated, settings);
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
                            await db.collection('orders').doc(id).update(srUpdate);
                            console.log(`[Admin Auto Shiprocket]: Order ${id} synced to Shiprocket (ID: ${srRes.shiprocket_order_id})`);
                        }
                    } catch (srErr) {
                        console.warn('[Admin Auto Shiprocket Error]:', srErr.message);
                    }
                })();
            }
        }

        res.json({ success: true, message: 'Order status updated', order: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to update order status.' });
    }
});

// Admin Quick Mark as Shipped (IN_TRANSIT) Checkbox Handler
app.put('/api/admin/orders/:id/ship', adminOnly, async (req, res) => {
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

app.get('/api/admin/users', adminOnly, getUsersHandler);
app.get('/api/users', adminOnly, getUsersHandler);

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

app.get('/api/admin/users/:id', adminOnly, getUserDetailsHandler);
app.get('/api/users/:id', adminOnly, getUserDetailsHandler);

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

app.put('/api/admin/users/:id/block', adminOnly, blockUserHandler);
app.put('/api/users/:id/block', adminOnly, blockUserHandler);

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

app.delete('/api/admin/users/:id', adminOnly, deleteUserHandler);
app.delete('/api/users/:id', adminOnly, deleteUserHandler);

// Admin Create Voucher (Standard)
app.post('/api/admin/vouchers', adminOnly, async (req, res) => {
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
app.post('/api/admin/vouchers/smart-assign', adminOnly, async (req, res) => {
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
app.get('/api/admin/vouchers', adminOnly, async (req, res) => {
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
app.get('/api/vouchers', adminOnly, async (req, res) => {
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

app.put('/api/admin/vouchers/:id/status', adminOnly, toggleVoucherStatus);
app.put('/api/vouchers/:id/status', adminOnly, toggleVoucherStatus);

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

app.delete('/api/admin/vouchers/:id', adminOnly, deleteVoucher);
app.delete('/api/vouchers/:id', adminOnly, deleteVoucher);

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

// ==========================================
// SHIPROCKET API AUTOMATED LOGISTICS ENDPOINTS
// ==========================================

// 1. Create / Sync Shiprocket Order (Admin or User)
app.post('/api/shiprocket/create-order', adminOnly, async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ success: false, error: 'Order ID is required.' });

        const orderRef = db.collection('orders').doc(orderId);
        const orderDoc = await orderRef.get();
        if (!orderDoc.exists) return res.status(404).json({ success: false, error: 'Order not found.' });

        const order = { id: orderDoc.id, ...orderDoc.data() };

        // Fetch settings if available
        const settingsDoc = await db.collection('settings').doc('shiprocket').get();
        const settings = readShiprocketSettings(settingsDoc);

        const srRes = await createShiprocketOrder(order, settings);

        if (!srRes.success) {
            return res.status(400).json({ success: false, error: srRes.error, details: srRes.raw });
        }

        const updateData = {
            shiprocket_order_id: srRes.shiprocket_order_id,
            shipment_id: srRes.shipment_id,
            shiprocket_status: srRes.status || 'CREATED',
            updated_at: new Date().toISOString()
        };

        if (srRes.awb_code) {
            updateData.awb_code = srRes.awb_code;
            updateData.tracking_number = srRes.awb_code;
            updateData.courier_name = srRes.courier_name || '';
            updateData.status = 'IN_TRANSIT';
        } else if (srRes.shipment_id) {
            // Attempt to assign AWB automatically
            const awbRes = await generateAwbCode(srRes.shipment_id);
            if (awbRes.success) {
                updateData.awb_code = awbRes.awb_code;
                updateData.tracking_number = awbRes.awb_code;
                updateData.courier_name = awbRes.courier_name || '';
                updateData.status = 'IN_TRANSIT';
            }
        }

        await orderRef.update(updateData);
        const updatedDoc = await orderRef.get();

        res.json({
            success: true,
            message: 'Order synced with Shiprocket successfully!',
            shiprocket: srRes,
            order: { id: updatedDoc.id, ...updatedDoc.data() }
        });
    } catch (err) {
        console.error('[Shiprocket Create Route Error]:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Fetch Live Tracking (User & Admin)
app.get('/api/shiprocket/track/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const orderRef = db.collection('orders').doc(orderId);
        const orderDoc = await orderRef.get();

        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }

        if (!canAccessOrder(orderDoc.data(), orderId, optionalUser(req), req.query.key)) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }

        const order = { id: orderDoc.id, ...orderDoc.data() };
        const awbCode = order.awb_code || (order.tracking_number !== 'PENDING' ? order.tracking_number : null);
        const srOrderId = order.shiprocket_order_id;

        if (!awbCode && !srOrderId) {
            return res.json({
                success: true,
                orderId: order.id,
                status: order.status,
                tracking: {
                    current_status: order.status === 'DELIVERED' ? 'DELIVERED' : (order.status === 'IN_TRANSIT' ? 'IN TRANSIT' : 'PROCESSING'),
                    awb_code: order.tracking_number || 'N/A',
                    courier_name: order.courier_name || 'Standard Courier',
                    scans: []
                }
            });
        }

        const settingsDoc = await db.collection('settings').doc('shiprocket').get();
        const settings = readShiprocketSettings(settingsDoc);

        const trackingRes = await trackShipment(awbCode, srOrderId, settings);

        if (trackingRes.success) {
            // Map Shiprocket Status to Platform Status
            let platformStatus = order.status;
            const srStatus = (trackingRes.current_status || '').toUpperCase();
            if (srStatus.includes('DELIVERED')) {
                platformStatus = 'DELIVERED';
            } else if (srStatus.includes('TRANSIT') || srStatus.includes('OUT FOR DELIVERY') || srStatus.includes('DISPATCHED') || srStatus.includes('PICKED UP')) {
                platformStatus = 'IN_TRANSIT';
            }

            // Sync to Firestore
            await orderRef.update({
                shiprocket_status: trackingRes.current_status,
                courier_name: trackingRes.courier_name || order.courier_name || '',
                awb_code: trackingRes.awb_code || awbCode || '',
                status: platformStatus,
                tracking_scans: trackingRes.scans || [],
                last_tracked_at: new Date().toISOString()
            });

            return res.json({
                success: true,
                orderId: order.id,
                status: platformStatus,
                tracking: trackingRes
            });
        } else {
            return res.json({
                success: true,
                orderId: order.id,
                status: order.status,
                tracking: {
                    current_status: order.shiprocket_status || order.status,
                    awb_code: awbCode || 'N/A',
                    courier_name: order.courier_name || 'Shiprocket Logistics',
                    scans: order.tracking_scans || []
                }
            });
        }
    } catch (err) {
        console.error('[Shiprocket Track Route Error]:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch shipment tracking.' });
    }
});

// 3. Shiprocket Webhook Endpoint for Automated Real-Time Status Updates
app.post('/api/shiprocket/webhook', async (req, res) => {
    try {
        // Shiprocket sends the token configured in its dashboard as the x-api-key header
        const hookToken = process.env.SHIPROCKET_WEBHOOK_TOKEN;
        if (!hookToken) return res.status(503).json({ success: false, error: 'Webhook not configured.' });
        if (!safeEqualHex(req.headers['x-api-key'], hookToken)) {
            return res.status(401).json({ success: false, error: 'Unauthorized.' });
        }

        const body = req.body || {};
        console.log('[Shiprocket Webhook Received]:', body.order_id || body.awb || '');

        const orderId = body.order_id || body.custom_order_id;
        const awb = body.awb || body.awb_code;
        const currentStatus = (body.current_status || body.status || '').toUpperCase();
        const courierName = body.courier_name || '';

        if (!orderId && !awb) {
            return res.status(200).json({ success: true, message: 'Webhook received but missing order identifier.' });
        }

        let orderRef = null;
        if (orderId) {
            orderRef = db.collection('orders').doc(orderId);
        } else if (awb) {
            const snap = await db.collection('orders').where('awb_code', '==', awb).limit(1).get();
            if (!snap.empty) orderRef = snap.docs[0].ref;
        }

        if (orderRef) {
            const doc = await orderRef.get();
            if (doc.exists) {
                let platformStatus = doc.data().status;
                if (currentStatus.includes('DELIVERED')) {
                    platformStatus = 'DELIVERED';
                } else if (currentStatus.includes('TRANSIT') || currentStatus.includes('OUT FOR DELIVERY') || currentStatus.includes('PICKED UP')) {
                    platformStatus = 'IN_TRANSIT';
                }

                await orderRef.update({
                    shiprocket_status: currentStatus,
                    courier_name: courierName || doc.data().courier_name || '',
                    awb_code: awb || doc.data().awb_code || '',
                    status: platformStatus,
                    last_webhook_at: new Date().toISOString()
                });
                console.log(`[Shiprocket Webhook Synced]: Order ${doc.id} updated to ${platformStatus} (${currentStatus})`);
            }
        }

        res.status(200).json({ success: true, message: 'Webhook processed successfully' });
    } catch (err) {
        console.error('[Shiprocket Webhook Error]:', err);
        res.status(500).json({ success: false, error: 'Webhook processing failed' });
    }
});

// 4. Shiprocket Settings Get & Save (Admin)
app.get('/api/admin/shiprocket/settings', adminOnly, async (req, res) => {
    try {
        const doc = await db.collection('settings').doc('shiprocket').get();
        const data = doc.exists ? doc.data() : {};
        const settings = {
            email: data.email || (process.env.SHIPROCKET_EMAIL || '').replace(/^["']|["']$/g, ''),
            pickup_location: data.pickup_location || (process.env.SHIPROCKET_PICKUP_LOCATION || 'Gaj Ganesh').replace(/^["']|["']$/g, ''),
            length: data.length || 20,
            breadth: data.breadth || 14,
            height: data.height || 3,
            weight: data.weight || 0.5,
            auto_create_on_payment: data.auto_create_on_payment !== undefined ? data.auto_create_on_payment : true,
            has_password: Boolean(data.password || process.env.SHIPROCKET_PASSWORD)
        };
        res.json({ success: true, settings });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch Shiprocket settings.' });
    }
});

app.post('/api/admin/shiprocket/settings', adminOnly, async (req, res) => {
    try {
        const { email, password, pickup_location, length, breadth, height, weight, auto_create_on_payment } = req.body;
        const newSettings = {
            email: (email || '').trim(),
            pickup_location: (pickup_location || 'Gaj Ganesh').trim(),
            length: Number(length) || 20,
            breadth: Number(breadth) || 14,
            height: Number(height) || 3,
            weight: Number(weight) || 0.5,
            auto_create_on_payment: Boolean(auto_create_on_payment),
            updated_at: new Date().toISOString()
        };
        if (password && password.trim()) {
            newSettings.password = encryptSecret(password.trim());
        }
        await db.collection('settings').doc('shiprocket').set(newSettings, { merge: true });
        res.json({ success: true, message: 'Shiprocket settings saved successfully.', settings: newSettings });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save Shiprocket settings.' });
    }
});

app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: 'Not found.' });
});

// Export API for Vercel
module.exports = app;

