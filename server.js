const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const simpleGit = require('simple-git');


// Initialize git with token
const git = simpleGit({
    baseDir: __dirname,
    binary: 'git',
    maxConcurrentProcesses: 1,
}).env({
    GIT_ASKPASS: 'echo',
    GIT_USERNAME: 'manuraj7070',
    GIT_PASSWORD: process.env.GITHUB_TOKEN
});

const app = express();
app.use(express.json({ limit: '1mb' })); // Limit payload size

const cors = require('cors');

// Enable CORS for all routes
// app.use(cors());

// Or more specifically, allow only your GitHub domain
// Get allowed origins from environment variable
// Get allowed origins from environment variable
// Get allowed origins - add the specific Google embed domain
// Get allowed origins - add the specific Google embed domain
const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
    : [
        'https://manuraj7070.github.io',
        'https://innershiftnirvaana.space',
        'https://pay.innershiftnirvaana.space',  // ← ADD THIS LINE
        'https://588380366-atari-embeds.googleusercontent.com',
        'https://*.googleusercontent.com'
      ]; 

console.log('🔓 Allowed CORS origins:', allowedOrigins);

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps, curl)
        if (!origin) return callback(null, true);
        
        // Check exact match first
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        
        // Check wildcard for googleusercontent.com
        if (origin.includes('googleusercontent.com')) {
            return callback(null, true);
        }
        
        console.log('❌ Blocked CORS from:', origin);
        callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: true
}));

// Debug all relevant environment variables
console.log('🔍 ENVIRONMENT VARIABLES DEBUG:');
console.log('- RAZORPAY_WEBHOOK_SECRET:', process.env.RAZORPAY_WEBHOOK_SECRET ? '✅ Found' : '❌ Missing');
console.log('- DATA_DIR:', process.env.DATA_DIR ? `✅ Found (${process.env.DATA_DIR})` : '❌ Missing');
console.log('- NODE_ENV:', process.env.NODE_ENV);
console.log('- RAILWAY_PUBLIC_DOMAIN:', process.env.RAILWAY_PUBLIC_DOMAIN ? '✅ Found' : '❌ Missing');

// Also check if variables are accessible
if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.log('⚠️ WARNING: RAZORPAY_WEBHOOK_SECRET is not set!');
} else {
    console.log('✅ RAZORPAY_WEBHOOK_SECRET is set (hidden)');
}

// Configuration with defaults
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const DATA_DIR = process.env.DATA_DIR || '/tmp';
let PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');
let LOG_FILE = path.join(DATA_DIR, 'webhook.log');
// Add this near the top with other variables
let paymentsCache = null;  // In-memory cache
let lastCacheUpdate = 0;
const CACHE_TTL = 60000; // 60 seconds
const MAX_PAYMENTS = 10000; // Prevent unlimited file growth

// Ensure directories exist
async function ensureDirectories() {
    try {
        await fs.mkdir(path.dirname(PAYMENTS_FILE), { recursive: true });
    } catch (error) {
        // Directory probably exists
    }
}

// Add this helper function
async function ensureWritableFile() {
    try {
        await fs.access(path.dirname(PAYMENTS_FILE), fs.constants.W_OK);
        return true;
    } catch {
        console.log('⚠️ Switching to /tmp for file storage');
        PAYMENTS_FILE = '/tmp/payments.json';
        LOG_FILE = '/tmp/webhook.log';
        return false;
    }
}

// Load payments with error recovery
// Load payments with error recovery
async function loadPayments() {
    try {
        console.log(`📂 Attempting to read from: ${PAYMENTS_FILE}`);
        const data = await fs.readFile(PAYMENTS_FILE, 'utf8');
        const payments = JSON.parse(data);
        console.log(`✅ Successfully loaded ${Object.keys(payments).length} payments`);
        return payments;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('📁 No payments file found - starting fresh');
            return {};
        }
        console.error('❌ Error loading payments:', error.message);
        // Corrupted file - backup and start fresh
        try {
            const backupFile = `${PAYMENTS_FILE}.backup.${Date.now()}`;
            await fs.rename(PAYMENTS_FILE, backupFile);
            console.log(`⚠️ Corrupted file backed up to ${backupFile}`);
        } catch (backupError) {
            console.error('Could not backup corrupted file:', backupError.message);
        }
        return {};
    }
}
// Modified loadPayments to use cache
async function getPayments(forceRefresh = false) {
    const now = Date.now();
    
    // Use cache if it's fresh
    if (!forceRefresh && paymentsCache && (now - lastCacheUpdate < CACHE_TTL)) {
        console.log('📋 Using cached payments');
        return paymentsCache;
    }
    
    // Load from file
    console.log('📂 Loading payments from disk');
    const payments = await loadPayments(); // Your existing function
    
    // Update cache
    paymentsCache = payments;
    lastCacheUpdate = now;
    
    return payments;
}
// GitHub sync function
async function syncToGitHub() {
    try {
        // Only sync if we have changes
        const status = await git.status(); 
        
        if (status.files.length > 0) {
            console.log('📤 Syncing payments to GitHub...');
            
            await git.add('./*.json');
            await git.commit(`💾 Auto-sync payments - ${new Date().toISOString()}`);
            await git.push('origin', 'main');
            
            console.log('✅ Successfully synced to GitHub');
        }
    } catch (error) {
        console.error('❌ GitHub sync error:', error.message);
        // Don't fail the payment if GitHub sync fails
    }
}
// Save payment with atomic write
// Save payment with atomic write and GitHub sync
async function savePayment(paymentId, paymentData) {
    try {
        // Load current payments (bypass cache to get latest)
        const payments = await getPayments(true); // Force refresh
        
        // Prevent unlimited growth
        if (Object.keys(payments).length >= MAX_PAYMENTS) {
            // Remove oldest payment
            const oldest = Object.entries(payments)
                .sort((a, b) => new Date(a[1].timestamp) - new Date(b[1].timestamp))[0];
            if (oldest) {
                delete payments[oldest[0]];
                console.log(`⚠️ Removed oldest payment: ${oldest[0]}`);
            }
        }
        
        // Add new payment
        payments[paymentId] = {
            ...paymentData,
            timestamp: paymentData.timestamp || new Date().toISOString(),
            receivedAt: new Date().toISOString()
        };
        
        // Atomic write - write to temp file then rename
        const tempFile = `${PAYMENTS_FILE}.tmp`;
        await fs.writeFile(tempFile, JSON.stringify(payments, null, 2));
        await fs.rename(tempFile, PAYMENTS_FILE);
        
        // Append to log file (non-critical, can fail silently)
        try {
            const logEntry = `${new Date().toISOString()},${paymentId},${paymentData.event || 'unknown'}\n`;
            await fs.appendFile(LOG_FILE, logEntry);
        } catch (logError) {
            console.error('Log write failed (non-critical):', logError.message);
        }
        
        // Trigger GitHub sync in background (don't await)
        syncToGitHub().catch(err => console.error('Background sync error:', err));
        
        return true;
    } catch (error) {
        console.error('Failed to save payment:', error.message);
        return false;
    }
}

// Verify Razorpay signature
function verifySignature(body, signature) {
    if (!WEBHOOK_SECRET || !signature) {
        return false;
    }
    
    try {
        const expectedSignature = crypto
            .createHmac('sha256', WEBHOOK_SECRET)
            .update(JSON.stringify(body))
            .digest('hex');
        
        // Constant-time comparison to prevent timing attacks
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    } catch (error) {
        console.error('Signature verification error:', error.message);
        return false;
    }
}

// Validate webhook payload
function validateWebhookPayload(body) {
    if (!body || typeof body !== 'object') {
        return { valid: false, error: 'Invalid payload format' };
    }
    
    const paymentId = body.payload?.payment?.entity?.id;
    if (!paymentId) {
        return { valid: false, error: 'No payment ID found' };
    }
    
    // Validate payment ID format (basic check)
    if (!paymentId.startsWith('pay_') && !paymentId.startsWith('pay_test_')) {
        return { valid: false, error: 'Invalid payment ID format' };
    }
    
    return { valid: true, paymentId };
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
    const startTime = Date.now();
    
    try {
        // Add at start of webhook
        const requestId = crypto.randomBytes(8).toString('hex');
        console.log(`[${requestId}] Webhook received`);

        // 1. Basic request validation
        if (!req.body) {
            console.log('❌ Empty webhook body');
            return res.status(400).json({ error: 'Empty body' });
        }
        

        // 2. Signature verification (if secret is configured)
        const signature = req.headers['x-razorpay-signature'];
        if (WEBHOOK_SECRET) {
            if (!signature) {
                console.log('❌ Missing signature header');
                return res.status(401).json({ error: 'Missing signature' });
            }
            
            if (!verifySignature(req.body, signature)) {
                console.log('❌ Invalid signature');
                return res.status(401).json({ error: 'Invalid signature' });
            }
            console.log('✅ Signature verified');
        }
        
        // 3. Validate payload structure
        const validation = validateWebhookPayload(req.body);
        if (!validation.valid) {
            console.log('❌ Invalid payload:', validation.error);
            return res.status(400).json({ error: validation.error });
        }
        
        const paymentId = validation.paymentId;
        const event = req.body.event || 'unknown';
        
        console.log(`📨 Webhook received: ${event} for ${paymentId}`);
        console.log(`[${requestId}] Payment ${paymentId}`);

        // 4. Extract payment details
        const paymentData = {
            event,
            paymentId,
            amount: req.body.payload?.payment?.entity?.amount,
            currency: req.body.payload?.payment?.entity?.currency,
            status: req.body.payload?.payment?.entity?.status,
            method: req.body.payload?.payment?.entity?.method,
            orderId: req.body.payload?.payment?.entity?.order_id,
            rawData: process.env.NODE_ENV === 'development' ? req.body : undefined
        };
        
        // 5. Save to persistent storage
        const saved = await savePayment(paymentId, paymentData);
        if (!saved) {
            console.error(`⚠️ Payment ${paymentId} received but not saved`);
            // Still return 200 to Razorpay to prevent retries
        }

        // 6. Log processing time
        const processingTime = Date.now() - startTime;
        console.log(`✅ Processed ${paymentId} in ${processingTime}ms`);

        // ✅ FIX: Redirect to frontend with payment ID (instead of sending JSON)
        console.log(`🔄 Redirecting to frontend with payment ID: ${paymentId}`);
        return res.redirect(`https://pay.innershiftnirvaana.space/?razorpay_payment_id=${paymentId}`);

        } catch (error) {
            console.error('❌ Webhook error:', error.message);
            console.error(error.stack);
            
            // Always return 200 to prevent Razorpay retries
            res.status(200).json({ 
                received: true, 
                error: error.message,
                note: 'Payment received but processing failed'
            });
        }
});

// NEW: Endpoint for the user's browser to land on after payment
app.get('/payment-success', (req, res) => {
    const paymentId = req.query.razorpay_payment_id;
    console.log(`📨 Payment success page accessed with ID: ${paymentId}`);
    
    if (paymentId) {
        // Redirect to your frontend with the ID in the URL
        return res.redirect(`https://pay.innershiftnirvaana.space/?razorpay_payment_id=${paymentId}`);
    } else {
        // No ID? Redirect to the main page (it will show the error)
        return res.redirect('https://pay.innershiftnirvaana.space/');
    }
});

// Add this endpoint to get recent payments
// Replace your recent-payments endpoint with:
app.get('/api/recent-payments', async (req, res) => {
    try {
        console.log('📊 Recent payments requested');
        console.log('Origin:', req.headers.origin);
        
        // Force refresh cache
        const payments = await getPayments(true);
        
        if (!payments) {
            console.log('⚠️ Payments is null/undefined');
            return res.json({ count: 0, payments: [] });
        }
        
        console.log(`📊 Total payments in cache: ${Object.keys(payments).length}`);
        
        const paymentsArray = Object.entries(payments);
        
        if (paymentsArray.length === 0) {
            console.log('📊 No payments found');
            return res.json({ count: 0, payments: [] });
        }
        
        const recent = paymentsArray
            .map(([id, data]) => ({
                paymentId: id,
                timestamp: data?.timestamp || new Date().toISOString(),
                amount: data?.amount || 0
            }))
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 5);
        
        console.log(`✅ Returning ${recent.length} recent payments`);
        res.json({
            count: recent.length,
            payments: recent
        });
    } catch (error) {
        console.error('❌ Recent payments error:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ 
            error: error.message,
            count: 0, 
            payments: [] 
        });
    }
});

// Verify payment endpoint
app.get('/verify/:paymentId', async (req, res) => {
    try {
        const paymentId = req.params.paymentId;
        
        // Basic validation
        if (!paymentId || typeof paymentId !== 'string') {
            return res.status(400).json({ 
                valid: false, 
                error: 'Invalid payment ID' 
            });
        }
        
        const payments = await loadPayments();
        
        await ensureWritableFile();
        console.log(`📁 Current PAYMENTS_FILE: ${PAYMENTS_FILE}`);
        const payment = payments[paymentId];
        if (payment) {
            res.json({
                valid: true,
                paymentId,
                details: {
                    event: payment.event,
                    amount: payment.amount,
                    status: payment.status,
                    timestamp: payment.timestamp
                }
            });
        } else {
            res.json({
                valid: false,
                paymentId,
                message: 'Payment not found'
            });
        }
    } catch (error) {
        console.error('Verification error:', error.message);
        res.status(500).json({ 
            valid: false, 
            error: 'Verification failed' 
        });
    }
});

// Admin endpoint with basic auth (add proper auth in production)
app.get('/admin/payments', async (req, res) => {
    try {
        // Simple API key check (replace with proper auth)
        const apiKey = req.headers['x-api-key'];
        if (apiKey !== process.env.ADMIN_API_KEY && process.env.NODE_ENV === 'production') {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        // Admin endpoint - use cache
        const payments = await getPayments();
        await ensureWritableFile();
        console.log(`📁 Current PAYMENTS_FILE: ${PAYMENTS_FILE}`);
        const paymentsList = Object.entries(payments)
            .map(([id, data]) => ({
                paymentId: id,
                ...data,
                rawData: undefined // Remove raw data for security
            }))
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 100); // Return last 100 payments
        
        res.json({
            total: Object.keys(payments).length,
            payments: paymentsList
        });
    } catch (error) {
        console.error('Admin error:', error.message);
        res.status(500).json({ error: 'Failed to load payments' });
    }
});

// Health check with system info
app.get('/health', async (req, res) => {
    try {
        // Health check - use cache
        const payments = await getPayments();
        await ensureWritableFile();
        console.log(`📁 Current PAYMENTS_FILE: ${PAYMENTS_FILE}`);
        const uptime = process.uptime();
        
        // Check file system
        let fileOk = true;
        try {
            await fs.access(PAYMENTS_FILE, fs.constants.W_OK);
        } catch {
            fileOk = false;
        }
        
        res.json({
            status: 'ok',
            time: new Date().toISOString(),
            uptime: Math.floor(uptime),
            payments: {
                total: Object.keys(payments).length,
                file: path.basename(PAYMENTS_FILE),
                writable: fileOk
            },
            memory: process.memoryUsage(),
            node: process.version,
            env: process.env.NODE_ENV || 'development'
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'degraded', 
            error: error.message 
        });
    }
});
// Add this to check webhook status
app.get('/diagnostic', async (req, res) => {
    try {
        const payments = await getPayments(true); // Force refresh
        res.json({
            status: 'ok',
            time: new Date().toISOString(),
            paymentsCount: Object.keys(payments).length,
            paymentsExist: Object.keys(payments).length > 0,
            cacheSize: paymentsCache ? Object.keys(paymentsCache).length : 0,
            filePath: PAYMENTS_FILE,
            nodeVersion: process.version
        });
    } catch (error) {
        res.json({ status: 'error', error: error.message });
    }
});
// Add this temporarily to check the file
app.get('/debug/check-file', async (req, res) => {
    try {
        const exists = await fs.access(PAYMENTS_FILE).then(() => true).catch(() => false);
        const content = exists ? await fs.readFile(PAYMENTS_FILE, 'utf8') : 'File not found';
        res.json({
            fileExists: exists,
            filePath: PAYMENTS_FILE,
            content: exists ? JSON.parse(content) : null,
            cacheSize: paymentsCache ? Object.keys(paymentsCache).length : 0
        });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Graceful shutdown
async function gracefulShutdown(signal) {
    console.log(`\n${signal} received - shutting down gracefully`);
    
    // Close server
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
    
    // Force exit after 10 seconds
    setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
}

// Error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('🔥 Uncaught Exception:', error);
    console.error(error.stack);
    // Keep running - don't crash on errors
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 Unhandled Rejection at:', promise);
    console.error('Reason:', reason);
});

// Shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Initialize and start server
// Initialize and start server
async function startServer() {
    try {
        // Force /tmp if writable is false
        try {
            await fs.access('/tmp', fs.constants.W_OK);
            PAYMENTS_FILE = '/tmp/payments.json';
            LOG_FILE = '/tmp/webhook.log';
            console.log(`📁 Using /tmp for storage`);
        } catch (e) {
            console.error('❌ Even /tmp is not writable!');
        }        
        
        // After forcing /tmp, test writability
        try {
            await fs.access('/tmp', fs.constants.W_OK);
            console.log('✅ /tmp is writable');
            
            // Create an empty file if it doesn't exist
            try {
                await fs.access(PAYMENTS_FILE);
            } catch {
                await fs.writeFile(PAYMENTS_FILE, '{}');
                console.log('📁 Created empty payments file');
            }
        } catch (e) {
            console.error('❌ /tmp is NOT writable:', e.message);
        }        

        // Try to pull latest payments from GitHub
        try {
            console.log('🔄 Pulling latest payments from GitHub...');
            await git.pull('origin', 'main');
            console.log('✅ Synced with GitHub');
        } catch (error) {
            console.log('⚠️ Could not pull from GitHub:', error.message);
        }

        // Ensure directories exist
        await ensureDirectories();
        
        // FORCE LOAD payments from disk
        console.log('🔄 Force loading payments from disk...');
        const payments = await loadPayments();  // This should now log properly
        
        // Update cache
        paymentsCache = payments;
        lastCacheUpdate = Date.now();
        
        console.log(`✅ Loaded ${Object.keys(payments).length} existing payments`);
        
        // Start server
        const server = app.listen(PORT, () => {
            console.log(`🚀 Webhook server running on port ${PORT}`);
            console.log(`📁 Payments file: ${PAYMENTS_FILE}`);
            console.log(`🔐 Webhook secret: ${WEBHOOK_SECRET ? 'configured' : 'NOT SET'}`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        });
        
        // Export server for graceful shutdown
        global.server = server;
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();