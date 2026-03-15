const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const cors = require('cors');
const axios = require('axios');
const simpleGit = require('simple-git');
// In-memory store for payment link mappings (add this near other variables)
const linkToPaymentMap = {};
const { execSync } = require('child_process');

console.log('🔥 SERVER STARTING AT:', new Date().toISOString());
console.log('📦 Node version:', process.version);
console.log('🔧 Environment:', process.env.RAZORPAY_MODE || 'not set');

// Initialize on startup
let GITHUB_READY = false;
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

// Add at the VERY TOP of server.js
console.log('🔍 DEBUG: Starting server with environment check:');
console.log('RAZORPAY_MODE:', process.env.RAZORPAY_MODE || 'not set');
console.log('RAZORPAY_TEST_KEY_ID present:', !!process.env.RAZORPAY_TEST_KEY_ID);
console.log('RAZORPAY_TEST_KEY_SECRET present:', !!process.env.RAZORPAY_TEST_KEY_SECRET);
console.log('RAZORPAY_LIVE_KEY_ID present:', !!process.env.RAZORPAY_LIVE_KEY_ID);
console.log('RAZORPAY_LIVE_KEY_SECRET present:', !!process.env.RAZORPAY_LIVE_KEY_SECRET);
console.log('ALL env vars:', Object.keys(process.env).filter(key => key.includes('RAZORPAY')).join(', '));

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_LIVE_KEY_ID,
    key_secret: process.env.RAZORPAY_LIVE_KEY_SECRET
});

// Also initialize test instance if needed
const razorpayTest = process.env.RAZORPAY_TEST_KEY_ID ? new Razorpay({
    key_id: process.env.RAZORPAY_TEST_KEY_ID,
    key_secret: process.env.RAZORPAY_TEST_KEY_SECRET
}) : null;

/**
 * Get Razorpay credentials and instance based on environment
 * @returns {Object} Object containing razorpay instance, keyId, and keySecret
 */
function getRazorPayCredentials() {
    // Determine which credentials to use based on environment
    const isProduction = process.env.RAZORPAY_MODE === 'production';
    
    const keyId = isProduction 
        ? process.env.RAZORPAY_LIVE_KEY_ID 
        : process.env.RAZORPAY_TEST_KEY_ID;
        
    const keySecret = isProduction 
        ? process.env.RAZORPAY_LIVE_KEY_SECRET 
        : process.env.RAZORPAY_TEST_KEY_SECRET;
    
    // Validate credentials
    if (!keyId || !keySecret) {
        const environment = isProduction ? 'production' : 'test';
        throw new Error(`Razorpay credentials not configured for ${environment} environment`);
    }
    
    // Create Razorpay instance
    const razorpay = new Razorpay({
        key_id: keyId,
        key_secret: keySecret
    });
    
    // Log environment (optional, remove in production)
    if (process.env.NODE_ENV !== 'production') {
        console.log(`🔧 Razorpay initialized in ${isProduction ? 'production' : 'test'} mode`);
    }
    
    // Return both instance and individual credentials
    return {
        razorpay,           // Razorpay instance for making API calls
        keyId,              // Public key ID (for frontend)
        keySecret,          // Secret key (keep on backend only)
        isProduction,       // Environment flag
        // Convenience method to check if ready
        isReady: true
    };
}


// Shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'manuraj7070/render-payment-webhook';
const GITHUB_BRANCH = 'main';
const REPO_URL = `https://manuraj7070:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
const LOCAL_REPO_PATH = path.join(__dirname, 'repo-cache');
// Configuration
const GIT_REPO = process.env.GITHUB_REPO || 'manuraj7070/render-payment-webhook';
const GIT_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GIT_TOKEN = process.env.GITHUB_TOKEN;
// Change from /tmp to the repo-cache path
const PAYMENTS_FILE = path.join(LOCAL_REPO_PATH, 'payments.json');
const LOG_FILE = path.join(LOCAL_REPO_PATH, 'webhook.log');

// Initialize git repository if it doesn't exist
function initGitRepo() {
    try {
        // Check if .git directory exists
        if (!fs.existsSync(path.join(__dirname, '.git'))) {
            console.log('📁 Initializing git repository...');
            execSync('git init', { stdio: 'inherit' });
            execSync('git config --global user.email "manuraj7070@users.noreply.github.com"', { stdio: 'inherit' });
            execSync('git config --global user.name "manuraj7070"', { stdio: 'inherit' });
            execSync('git remote add origin https://manuraj7070:${process.env.GITHUB_TOKEN}@github.com/manuraj7070/render-payment-webhook.git', { stdio: 'inherit' });
            console.log('✅ Git repository initialized');
        }
        
        // Pull latest changes
        try {
            execSync('git pull origin main --rebase', { stdio: 'inherit' });
            console.log('✅ Synced with GitHub');
        } catch (pullError) {
            console.log('⚠️ Could not pull from GitHub:', pullError.message);
        }
        
        return true;
    } catch (error) {
        console.log('⚠️ Git initialization failed:', error.message);
        return false;
    }
}

// Call this in your startServer function
//const GIT_AVAILABLE = initGitRepo();



// Initialize git repository for storage
// Initialize git repository for storage
async function initGitStorage() {
    if (!GITHUB_TOKEN) {
        console.log('⚠️ GITHUB_TOKEN not set - GitHub sync disabled');
        return false;
    }

    try {
        // Create repo-cache directory if it doesn't exist
        await fs.mkdir(LOCAL_REPO_PATH, { recursive: true });
        
        // Check if already cloned
        try {
            await fs.access(path.join(LOCAL_REPO_PATH, '.git'));
            console.log('📁 Git repository exists, pulling latest...');
            
            // Pull latest changes
            const pullResult = execSync(`cd ${LOCAL_REPO_PATH} && git pull`, { 
                encoding: 'utf8',
                stdio: 'pipe' 
            });
            console.log('📥 Pull result:', pullResult.trim());
            
        } catch (err) {
            // Clone the repository
            console.log('📦 Cloning repository...');
            const cloneResult = execSync(`git clone ${REPO_URL} ${LOCAL_REPO_PATH}`, { 
                encoding: 'utf8',
                stdio: 'pipe' 
            });
            console.log('✅ Clone successful');
        }
        
        // Configure git user for commits
        execSync(`cd ${LOCAL_REPO_PATH} && git config user.email "manuraj7070@users.noreply.github.com"`, { stdio: 'ignore' });
        execSync(`cd ${LOCAL_REPO_PATH} && git config user.name "manuraj7070"`, { stdio: 'ignore' });
        
        console.log('✅ GitHub storage initialized');
        return true;
        
    } catch (error) {
        console.error('❌ Failed to initialize GitHub storage:', error.message);
        return false;
    }
}

// Enhanced savePayment with GitHub sync
// Save payment with GitHub sync
async function savePayment(paymentId, paymentData) {
    try {
        // Load current payments
        const payments = await getPayments(true);
        console.log('📝 savePayment called for:', paymentId);
        console.log('📁 Target file:', PAYMENTS_FILE);

        // Add new payment
        payments[paymentId] = {
            ...paymentData,
            timestamp: paymentData.timestamp || new Date().toISOString(),
            receivedAt: new Date().toISOString()
        };
        
        // Before git add, ensure file exists
        try {
            await fs.access(path.join(LOCAL_REPO_PATH, 'payments.json'));
        } catch {
            await fs.writeFile(path.join(LOCAL_REPO_PATH, 'payments.json'), '{}');
        }       

        console.log('💾 Saving payment to:', PAYMENTS_FILE);
        console.log('📁 Payment data:', paymentId);

        // Save to file in repo
        await fs.writeFile(PAYMENTS_FILE, JSON.stringify(payments, null, 2));
        console.log(`✅ Payment ${paymentId} saved locally`);
        
        // Commit and push to GitHub if token exists
        if (GITHUB_TOKEN) {
            try {
                // Commit the change
                execSync(`
                    cd ${LOCAL_REPO_PATH} &&
                    git add payments.json &&
                    git commit -m "💾 Add payment ${paymentId}" --allow-empty &&
                    git push
                `, { stdio: 'pipe' });
                
                console.log(`✅ Payment ${paymentId} synced to GitHub`);
            } catch (gitError) {
                console.error('⚠️ GitHub sync failed:', gitError.message);
                // Don't fail - payment is still saved locally
            }
        }
        
        return true;
        
    } catch (error) {
        console.error('❌ Failed to save payment:', error.message);
        return false;
    }
}

// Load payments with GitHub backup
// Load payments with GitHub backup
async function loadPayments() {
    // First try local file in repo
    try {
        const data = await fs.readFile(PAYMENTS_FILE, 'utf8');
        const payments = JSON.parse(data);
        console.log(`✅ Loaded ${Object.keys(payments).length} payments from local`);
        return payments;
        
    } catch (localError) {
        console.log('No local payments file found');
        
        // If GitHub token exists, try to pull from GitHub
        if (GITHUB_TOKEN) {
            try {
                // Pull latest from GitHub
                execSync(`cd ${LOCAL_REPO_PATH} && git pull`, { stdio: 'pipe' });
                
                // Try reading again after pull
                const data = await fs.readFile(PAYMENTS_FILE, 'utf8');
                const payments = JSON.parse(data);
                console.log(`✅ Loaded ${Object.keys(payments).length} payments from GitHub`);
                return payments;
                
            } catch (githubError) {
                console.log('No payments found on GitHub either');
            }
        }
        
        // Start fresh
        return {};
    }
}


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


// Or more specifically, allow only your GitHub domain
// Get allowed origins from environment variable
// Get allowed origins - add the specific Google embed domain
const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin => {
        origin = origin.trim();
        // Check if it looks like a regex pattern (starts and ends with /)
        if (origin.startsWith('/') && origin.lastIndexOf('/') > 0) {
            const pattern = origin.slice(1, origin.lastIndexOf('/'));
            const flags = origin.slice(origin.lastIndexOf('/') + 1);
            return new RegExp(pattern, flags);
        }
        return origin;
    })    
    : [
        'https://manuraj7070.github.io',
        'https://sites.google.com',
        'https://rawcdn.githack.com',
        'https://www.innershiftnirvaana.space',
        'https://innershiftnirvaana.space',
        'https://pay.innershiftnirvaana.space',  // ← ADD THIS LINE
        'https://588380366-atari-embeds.googleusercontent.com',
        'http://localhost:8080',  // For local testing
        'http://localhost:3000',
        // Add ALL possible Google embed domains
        // Use proper regex for Google domains
        /^https:\/\/[a-zA-Z0-9-]+\.googleusercontent\.com$/,  // Matches ANY subdomain
        /^https:\/\/[a-zA-Z0-9-]+\.google\.com$/              // Matches ANY subdomain
    ]; 

console.log('🔓 Allowed CORS origins:', allowedOrigins);

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps, curl)
        if (!origin) return callback(null, true);
        
        // Check if origin matches any allowed pattern
        const isAllowed = allowedOrigins.some(allowed => {
            if (allowed instanceof RegExp) {
                return allowed.test(origin);
            }
            // Convert wildcard to regex
            if (typeof allowed === 'string' && allowed.includes('*')) {
                const pattern = allowed.replace(/\*/g, '.*');
                return new RegExp(pattern).test(origin);
            }
            return allowed === origin;
        });


        // Check wildcard for googleusercontent.com
        if (origin.includes('googleusercontent.com')) {
            return callback(null, true);
        }
        
        if (isAllowed) {
            callback(null, true);
        } else {
            console.log('❌ Blocked origin:', origin);
            callback(new Error(`Origin ${origin} not allowed by CORS`));
        }
    },
    credentials: true,
    optionsSuccessStatus: 200
}));

// Explicitly handle OPTIONS preflight requests
//app.options('/*', cors());
// Handle preflight requests

app.use(express.json({ limit: '1mb' })); // Limit payload size


// Add explicit CORS headers for all responses
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (
        origin.includes('.googleusercontent.com') || 
        origin.includes('.google.com') ||
        allowedOrigins.includes(origin)
    )) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    }
    next();
});
// Enable CORS for all routes
// app.use(cors());

// Debug all relevant environment variables
console.log('🔍 ENVIRONMENT VARIABLES DEBUG:');
//console.log('- RAZORPAY_WEBHOOK_SECRET:', process.env.RAZORPAY_WEBHOOK_SECRET ? '✅ Found' : '❌ Missing');
console.log('- DATA_DIR:', process.env.DATA_DIR ? `✅ Found (${process.env.DATA_DIR})` : '❌ Missing');
console.log('- NODE_ENV:', process.env.NODE_ENV);
console.log('- RAILWAY_PUBLIC_DOMAIN:', process.env.RAILWAY_PUBLIC_DOMAIN ? '✅ Found' : '❌ Missing');

// Also check if variables are accessible
/* if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.log('⚠️ WARNING: RAZORPAY_WEBHOOK_SECRET is not set!');
} else {
    console.log('✅ RAZORPAY_WEBHOOK_SECRET is set (hidden)');
} */

// Configuration with defaults
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const DATA_DIR = process.env.DATA_DIR || '/tmp';

// Add this near the top with other variables
let paymentsCache = null;  // In-memory cache
let lastCacheUpdate = 0;
const CACHE_TTL = 60000; // 60 seconds
const MAX_PAYMENTS = 10000; // Prevent unlimited file growth
//let payment_success_paymentId = null;

// ============================================
// Helper function to create Razorpay instance from request
// ============================================
/* function getRazorpayInstance(keyId, keySecret) {
    if (!keyId || !keySecret) {
        throw new Error('Razorpay key_id and key_secret are required');
    }
    return new Razorpay({
        key_id: keyId,
        key_secret: keySecret
    });
} */
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
async function loadPaymentsX() {
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
// Modified getPayments to use cache
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
async function savePaymentX(paymentId, paymentData) {
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
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'Payment Webhook Server is Running',
        endpoints: {
            test: '/api/test',
            publicKey: '/api/get-public-key',
            checkout: '/api/get-checkout-options (POST)',
            verify: '/api/verify-payment (POST)'
        },
        timestamp: new Date().toISOString()
    });
});
// ============================================
// FIXED: Test endpoint with better error handling
// ============================================
app.get('/api/test', (req, res) => {
    try {
        console.log('✅ Test endpoint hit from origin:', req.headers.origin);
        res.json({ 
            success: true, 
            message: 'Server is running!',
            timestamp: new Date().toISOString(),
            mode: process.env.RAZORPAY_MODE || 'test',
            origin: req.headers.origin
        });
    } catch (error) {
        console.error('❌ Test endpoint error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ============================================
// Save Payment Data with Customer Details
// ============================================
app.post('/api/save-payment-details', async (req, res) => {
    try {
        const { 
            paymentId,
            customerName,
            customerEmail,
            customerPhone,
            orderId,
            amount,
            workshopName,
            workshopDate
        } = req.body;

        if (!paymentId || !customerName || !customerPhone) {
            return res.status(400).json({
                success: false,
                error: 'Payment ID, customer name and phone are required'
            });
        }

        // Load existing payments
        const payments = await getPayments(true);
        
        // Update or create payment record
        if (payments[paymentId]) {
            payments[paymentId] = {
                ...payments[paymentId],
                customerName,
                customerEmail: customerEmail || payments[paymentId].email,
                customerPhone,
                orderId: orderId || payments[paymentId].orderId,
                amount: amount || payments[paymentId].amount,
                workshopName: workshopName || 'Workshop Registration',
                workshopDate: workshopDate || new Date().toISOString().split('T')[0],
                whatsappLinkGenerated: true,
                whatsappLinkGeneratedAt: new Date().toISOString()
            };
        } else {
            // New payment record
            payments[paymentId] = {
                paymentId,
                customerName,
                customerEmail: customerEmail || 'Not provided',
                customerPhone,
                orderId: orderId || 'N/A',
                amount: amount || 0,
                workshopName: workshopName || 'Workshop Registration',
                workshopDate: workshopDate || new Date().toISOString().split('T')[0],
                status: 'completed',
                timestamp: new Date().toISOString(),
                whatsappLinkGenerated: true,
                whatsappLinkGeneratedAt: new Date().toISOString()
            };
        }

        // Save to file
        await savePayment(paymentId, payments[paymentId]);
        
        // Generate WhatsApp link
        const whatsappMessage = encodeURIComponent(
            `Hello ${customerName}! Thank you for registering for ${workshopName || 'the workshop'}. ` +
            `Your payment ID is ${paymentId}. Click here to join the WhatsApp group.`
        );
        const whatsappLink = `https://wa.me/${customerPhone}?text=${whatsappMessage}`;

        res.json({
            success: true,
            message: 'Payment details saved successfully',
            paymentId,
            whatsappLink,
            customer: {
                name: customerName,
                email: customerEmail,
                phone: customerPhone
            }
        });

    } catch (error) {
        console.error('❌ Error saving payment details:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// Get Payment Details by Payment ID or Phone
// ============================================
app.post('/api/get-payment-details', async (req, res) => {
    try {
        const { paymentId, customerPhone } = req.body;

        if (!paymentId && !customerPhone) {
            return res.status(400).json({
                success: false,
                error: 'Either paymentId or customerPhone is required'
            });
        }

        const payments = await getPayments(true);
        let matchingPayments = [];

        if (paymentId) {
            // Search by payment ID
            if (payments[paymentId]) {
                matchingPayments = [{
                    paymentId,
                    ...payments[paymentId]
                }];
            }
        } else if (customerPhone) {
            // Search by phone number
            matchingPayments = Object.entries(payments)
                .filter(([_, data]) => data.customerPhone === customerPhone)
                .map(([id, data]) => ({
                    paymentId: id,
                    ...data
                }))
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }

        if (matchingPayments.length > 0) {
            // Generate WhatsApp links for each payment
            const results = matchingPayments.map(payment => {
                const message = encodeURIComponent(
                    `Hello ${payment.customerName || 'there'}! Regarding your payment (ID: ${payment.paymentId}) ` +
                    `for ${payment.workshopName || 'the workshop'}. Join our WhatsApp group here.`
                );
                return {
                    ...payment,
                    whatsappLink: `https://wa.me/${payment.customerPhone || customerPhone}?text=${message}`
                };
            });

            res.json({
                success: true,
                count: results.length,
                payments: results
            });
        } else {
            res.json({
                success: false,
                message: 'No payments found matching your criteria'
            });
        }

    } catch (error) {
        console.error('❌ Error fetching payment details:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// Generate WhatsApp Link API
// ============================================
app.post('/api/generate-whatsapp-link', async (req, res) => {
    try {
        const { 
            paymentId,
            customerName,
            customerPhone,
            customMessage 
        } = req.body;

        if (!paymentId || !customerPhone) {
            return res.status(400).json({
                success: false,
                error: 'Payment ID and customer phone are required'
            });
        }

        // Default message
        const defaultMessage = customMessage || 
            `Hello ${customerName || 'there'}! Your payment (ID: ${paymentId}) is confirmed. ` +
            `Click here to join the WhatsApp group.`;

        const whatsappLink = `https://wa.me/${customerPhone}?text=${encodeURIComponent(defaultMessage)}`;

        res.json({
            success: true,
            paymentId,
            customerName,
            customerPhone,
            whatsappLink,
            message: defaultMessage
        });

    } catch (error) {
        console.error('❌ Error generating WhatsApp link:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});
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
// ============================================
// NEW ENDPOINT: Create Razorpay Order (with credentials in payload)
// ============================================
// Endpoint to get PUBLIC key only
// ============================================
// CORRECT IMPLEMENTATION - Keys ONLY from environment
// ============================================


// ============================================
// FIXED: Get public key endpoint
// ============================================
app.get('/api/get-public-key', (req, res) => {
    try {
        console.log('🔑 Public key requested at:', new Date().toISOString());
        console.log('🔑 Headers:', req.headers);
        console.log('🔑 Origin:', req.headers.origin);
        
        // Log environment state
        console.log('🔍 Current state:', {
            RAZORPAY_MODE: process.env.RAZORPAY_MODE,
            NODE_ENV: process.env.NODE_ENV,
            hasTestKey: !!process.env.RAZORPAY_TEST_KEY_ID,
            hasLiveKey: !!process.env.RAZORPAY_LIVE_KEY_ID
        });
        
        const credentials = getRazorPayCredentials();
        console.log('🔑 Credentials loaded:', {
            hasKeyId: !!credentials.keyId,
            isProduction: credentials.isProduction,
            mode: credentials.isProduction ? 'production' : 'test'
        });
        
        if (!credentials.keyId) {
            throw new Error('Key ID not configured in environment variables');
        }
        
        // Set CORS headers
        const origin = req.headers.origin;
        if (origin) {
            res.header('Access-Control-Allow-Origin', origin);
            res.header('Access-Control-Allow-Credentials', 'true');
            res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
        }
        
        // Handle preflight
        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }
        
        console.log('✅ Sending public key:', credentials.keyId.substring(0, 10) + '...');
        
        res.json({ 
            success: true, 
            key_id: credentials.keyId,
            mode: process.env.RAZORPAY_MODE || 'test',
            environment: process.env.NODE_ENV
        });
        
    } catch (error) {
        console.error('❌ Public key error:', error);
        console.error('❌ Stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ============================================
// FIXED: Create order endpoint
// ============================================
app.post('/api/create-order', async (req, res) => {
    try {
        console.log('💰 Create order request from:', req.headers.origin);
        console.log('📦 Request body:', req.body);
        
        const { amount, fullname, email, phone } = req.body;
        
        // Validate inputs
        if (!amount || amount <= 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid amount' 
            });
        }
        
        // Initialize Razorpay
        const { razorpay, keyId, keySecret, isProduction, isReady } = getRazorPayCredentials(); 
        if (!keyId || !keySecret) {
            throw new Error('Razorpay credentials not configured');
        }

        // Create order
        const order = await razorpay.orders.create({
            amount: amount * 100,
            currency: 'INR',
            receipt: `receipt_${Date.now()}`,
            notes: { fullname, email, phone }
        });

        console.log('✅ Order created:', order.id);
        
        // Set CORS headers
        res.header('Access-Control-Allow-Origin', req.headers.origin);
        res.header('Access-Control-Allow-Credentials', 'true');
        
        res.json({
            success: true,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key_id: keyId  // Send key_id for frontend
        });
        
    } catch (error) {
        console.error('❌ Order creation error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});
// In your server.js - Complete payment link solution
app.post('/api/create-workshop-payment', async (req, res) => {
    try {
      const { fullname, email, phone } = req.body;
      
      // Create payment link with all bells and whistles
      const options = {
        amount: 5100,
        currency: 'INR',
        accept_partial: false,
        description: `Addiction Healing Workshop - ₹51`,
        customer: {
          name: fullname,
          email: email,
          contact: phone
        },
        notify: {
          sms: true,
          email: true
        },
        reminder_enable: true,
        notes: {
          fullname: fullname,
          email: email,
          phone: phone,
          whatsapp_group: REAL_WHATSAPP_LINK
        },
        // After payment, send them to a page with WhatsApp link
        callback_url: 'https://your-site.com/payment-success',
        callback_method: 'get'
      };
  
      const paymentLink = await razorpay.paymentLink.create(options);
      
      // Store payment link in database with user data
      await db.save({
        paymentLinkId: paymentLink.id,
        shortUrl: paymentLink.short_url,
        customer: { fullname, email, phone },
        createdAt: new Date()
      });
      
      // Return both payment link AND WhatsApp link
      res.json({
        success: true,
        payment_link: paymentLink.short_url,
        whatsapp_link: REAL_WHATSAPP_LINK,
        message: 'Click payment link to pay. After payment, you\'ll get WhatsApp access.'
      });
      
    } catch (error) {
      res.json({ success: false, error: error.message });
    }
  });
// In your server.js
app.post('/api/create-payment-link', async (req, res) => {
    try {
      const { fullname, email, phone } = req.body;
      
      const options = {
        amount: 5100,
        currency: 'INR',
        customer: {
          name: fullname,
          email: email,
          contact: phone
        },
        notify: { sms: true, email: true },
        reminder_enable: true,
        callback_url: `${req.protocol}://${req.get('host')}/payment-success`,
        callback_method: 'get'
      };
      
      const paymentLink = await razorpay.paymentLink.create(options);
      
      res.json({ 
        success: true, 
        link: paymentLink.short_url 
      });
    } catch (error) {
      res.json({ success: false, error: error.message });
    }
  });

// ============================================
// Verify Payment with Razorpay API
// ============================================
app.post('/api/razorpay-verify-payment', async (req, res) => {
    try {
        const { paymentId } = req.body;
        
        if (!paymentId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Payment ID is required' 
            });
        }

        // Initialize Razorpay with your live keys
        // Initialize Razorpay
        const { razorpay, keyId, keySecret, isProduction, isReady } = getRazorPayCredentials();
        if (!keyId || !keySecret) {
            throw new Error('Razorpay credentials not configured');
        }

        // Fetch payment details directly from Razorpay API [citation:8]
        const payment = await razorpay.payments.fetch(paymentId);
        
        // Check if payment exists and is successful [citation:3][citation:6]
        if (payment && (payment.status === 'captured' || payment.status === 'authorized')) {
            
            // You can also fetch additional details like customer info [citation:4]
            // But payment.fetch already includes most details
            
            res.json({
                success: true,
                payment: {
                    id: payment.id,
                    amount: payment.amount,
                    currency: payment.currency,
                    status: payment.status,
                    method: payment.method,
                    email: payment.email,
                    contact: payment.contact,
                    created_at: payment.created_at
                }
            });
        } else {
            res.status(404).json({ 
                success: false, 
                error: 'Payment not found or not successful' 
            });
        }
    } catch (error) {
        console.error('❌ Razorpay verification error:', error);
        
        // Handle specific Razorpay errors [citation:8]
        if (error.statusCode === 400) {
            res.status(400).json({ 
                success: false, 
                error: 'Invalid payment ID' 
            });
        } else {
            res.status(500).json({ 
                success: false, 
                error: error.message || 'Failed to verify payment' 
            });
        }
    }
});
// ============================================
// Verify payment endpoint
// ============================================
app.post('/api/verify-payment', (req, res) => {
    try {
        console.log('🔍 Verify payment from:', req.headers.origin);
        
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        
        // Initialize Razorpay
        const { razorpay, keyId, keySecret, isProduction, isReady } = getRazorPayCredentials();

        if (!keyId || !keySecret) {
            throw new Error('Razorpay credentials not configured');
        }

        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', keySecret)
            .update(body)
            .digest('hex');

        const isValid = expectedSignature === razorpay_signature;
        
        // Set CORS headers
        res.header('Access-Control-Allow-Origin', req.headers.origin);
        res.header('Access-Control-Allow-Credentials', 'true');
        
        if (isValid) {
            console.log('✅ Payment verified:', razorpay_payment_id);
            res.json({ 
                success: true, 
                payment_id: razorpay_payment_id 
            });
        } else {
            console.log('❌ Invalid signature');
            res.status(400).json({ 
                success: false, 
                error: 'Invalid signature' 
            });
        }
    } catch (error) {
        console.error('❌ Verification error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});
// ============================================
// Optional: Endpoints for fetching details (still using server keys)
// ============================================

app.post('/api/order-details', async (req, res) => {
    try {
        const { order_id } = req.body;
        
        if (!order_id) {
            return res.status(400).json({
                success: false,
                error: 'order_id is required'
            });
        }

        const mode = process.env.RAZORPAY_MODE || 'test';
        const instance = mode === 'production' ? razorpay : (razorpayTest || razorpay);
        
        // Fetch order from Razorpay
        const order = await instance.orders.fetch(order_id);
        
        // Only return safe fields
        res.json({
            success: true,
            order: {
                id: order.id,
                amount: order.amount,
                currency: order.currency,
                status: order.status,
                created_at: order.created_at
            }
        });

    } catch (error) {
        console.error('❌ Order fetch error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Similar for payment details - use server keys, never accept from client
app.post('/api/payment-details', async (req, res) => {
    try {
        const { payment_id } = req.body;
        
        if (!payment_id) {
            return res.status(400).json({
                success: false,
                error: 'payment_id is required'
            });
        }

        const mode = process.env.RAZORPAY_MODE || 'test';
        const instance = mode === 'production' ? razorpay : (razorpayTest || razorpay);
        
        const payment = await instance.payments.fetch(payment_id);
        
        // Only return safe fields
        res.json({
            success: true,
            payment: {
                id: payment.id,
                amount: payment.amount,
                currency: payment.currency,
                status: payment.status,
                method: payment.method,
                created_at: payment.created_at
                // DON'T send sensitive data like bank details, card numbers, etc.
            }
        });

    } catch (error) {
        console.error('❌ Payment fetch error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/* // ============================================
// NEW ENDPOINT: Fetch Order Details (with credentials in payload)
// ============================================
app.post('/api/order', async (req, res) => {
    try {
        const { 
            order_id,
            key_id,
            key_secret
        } = req.body;
        
        if (!order_id || !key_id || !key_secret) {
            return res.status(400).json({
                success: false,
                error: 'order_id, key_id, and key_secret are required'
            });
        }

        // Create Razorpay instance with provided credentials
        const razorpay = getRazorpayInstance(key_id, key_secret);
        
        // Fetch order from Razorpay
        const order = await razorpay.orders.fetch(order_id);
        
        res.json({
            success: true,
            order
        });

    } catch (error) {
        console.error('❌ Order fetch error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// NEW ENDPOINT: Fetch Payment Details (with credentials in payload)
// ============================================
app.post('/api/payment', async (req, res) => {
    try {
        const { 
            payment_id,
            key_id,
            key_secret
        } = req.body;
        
        if (!payment_id || !key_id || !key_secret) {
            return res.status(400).json({
                success: false,
                error: 'payment_id, key_id, and key_secret are required'
            });
        }

        // Create Razorpay instance with provided credentials
        const razorpay = getRazorpayInstance(key_id, key_secret);
        
        // Fetch payment from Razorpay
        const payment = await razorpay.payments.fetch(payment_id);
        
        res.json({
            success: true,
            payment
        });

    } catch (error) {
        console.error('❌ Payment fetch error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}); */

// ============================================
// Webhook Endpoint (with credentials in payload)
// ============================================
app.post('/webhooktest', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const requestId = crypto.randomBytes(8).toString('hex');
        console.log(`[${requestId}] Webhook received`);
        
        if (!req.body) {
            console.log('❌ Empty webhook body');
            return res.status(400).send('Empty webhook body');
        }

        // Extract credentials from webhook payload
        const { 
            key_id, 
            key_secret,
            webhook_secret 
        } = req.body;

        if (!key_id || !key_secret) {
            console.log('❌ Missing Razorpay credentials in webhook payload');
            return res.status(400).json({ error: 'Credentials required' });
        }

        console.log('Event:', req.body.event);
        const eventType = req.body.event;
        
        // Handle payment.authorized
        if (eventType === 'payment.authorized') {
            const payment = req.body.payload?.payment?.entity || {};
            const notes = payment.notes || {};
            const paymentPageId = notes.payment_page_id || notes.payment_page_link_id || notes.page_id || 'N/A';
            const paymentId = payment.id;
            const orderId = payment.order_id;
            
            console.log(`📄 Payment Page ID: ${paymentPageId}`);
            console.log(`💰 Payment ID: ${paymentId}`);
            console.log(`📦 Order ID: ${orderId}`);
            
            // Store mapping
            linkToPaymentMap[paymentPageId] = paymentId;
            
            return res.status(200).json({ received: true });
        }
        
        // Handle payment.captured
        else if (eventType === 'payment.captured') {
            // Signature verification using webhook_secret from payload
            const signature = req.headers['x-razorpay-signature'];
            if (webhook_secret) {
                if (!signature) {
                    console.log('❌ Missing signature header');
                    return res.status(400).send('Missing signature');
                }
                
                const expectedSignature = crypto
                    .createHmac('sha256', webhook_secret)
                    .update(JSON.stringify(req.body))
                    .digest('hex');
                
                if (!crypto.timingSafeEqual(
                    Buffer.from(signature),
                    Buffer.from(expectedSignature)
                )) {
                    console.log('❌ Invalid signature');
                    return res.status(400).send('Invalid signature');
                }
                console.log('✅ Signature verified');
            }
            
            // Extract payment details
            const payment = req.body.payload?.payment?.entity || {};
            const notes = payment.notes || {};
            const acquirerData = payment.acquirer_data || {};
            const paymentId = payment.id;
            const orderId = payment.order_id;
            
            console.log(`📨 Payment captured: ${paymentId} for order: ${orderId}`);
            
            const paymentPageId = notes.payment_page_id || notes.payment_page_link_id || notes.page_id || 'N/A';
            
            // Store mapping
            if (paymentPageId !== 'N/A') {
                linkToPaymentMap[paymentPageId] = paymentId;
            }
            
            const paymentData = {
                event: eventType,
                paymentId,
                orderId,
                amount: payment.amount,
                currency: payment.currency,
                status: payment.status,
                method: payment.method,
                email: notes.email || payment.email || notes.customer_email || 'N/A',
                phone: notes.contact || payment.contact || notes.customer_phone || 'N/A',
                customer_name: notes.customer_name || 'N/A',
                bank_rrn: acquirerData.rrn || payment.rrn || 'N/A',
                bank_transaction_id: acquirerData.bank_transaction_id || 'N/A',
                paymentPageId,
                timestamp: new Date().toISOString(),
                receivedAt: new Date().toISOString()
            };

            // Save to storage
            
            console.log('💰 About to save payment:', paymentId);
            const saved = await savePayment(paymentId, paymentData);
            console.log('✅ Save result:', saved ? 'success' : 'failed');

            const processingTime = Date.now() - startTime;
            console.log(`✅ Processed ${paymentId} in ${processingTime}ms`);

            return res.status(200).json({ 
                received: true, 
                paymentId,
                orderId 
            });
        }
        
        // Unknown event type
        else {
            console.log(`⚠️ Unknown event type: ${eventType}`);
            return res.status(200).json({ received: true });
        }
        
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        return res.status(500).send('Webhook processing error');
    }
});
// Payment success handlers (keep your existing ones)
app.post('/payment-success-test', async (req, res) => {
    try {
        const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
        
        if (!razorpay_payment_id) {
            return res.redirect('https://pay.innershiftnirvaana.space/');
        }
        
        return res.redirect(`https://pay.innershiftnirvaana.space/?pid=${razorpay_payment_id}`);
        
    } catch (error) {
        console.error('❌ Error:', error);
        return res.redirect('https://pay.innershiftnirvaana.space/');
    }
});

app.get('/payment-success-test', async (req, res) => {
    try {
        const { razorpay_payment_id } = req.query;

        if (!razorpay_payment_id) {
            return res.redirect('https://pay.innershiftnirvaana.space/');
        }

        return res.redirect(`https://pay.innershiftnirvaana.space/?pid=${razorpay_payment_id}`);

    } catch (error) {
        console.error('❌ Payment-success error:', error);
        return res.redirect('https://pay.innershiftnirvaana.space/');
    }
});
// Enhanced health check
app.get('/health-test', async (req, res) => {
    try {
        const healthData = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()),
            node: process.version,
            memory: process.memoryUsage(),
            pid: process.pid,
            port: process.env.PORT,
            env: {
                NODE_ENV: process.env.NODE_ENV,
                HAS_GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
                ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? 'set' : 'not set'
            },
            git: {
                initialized: !!git,
                working: false
            }
        };

        // Test git quickly
        try {
            const status = await git.status();
            healthData.git.working = true;
            healthData.git.branch = status.current;
        } catch (gitError) {
            healthData.git.error = gitError.message;
        }

        res.json(healthData);
    } catch (error) {
        console.error('❌ Health check error:', error);
        res.status(500).json({ 
            status: 'error', 
            error: error.message 
        });
    }
});
// Webhook endpoint
// Webhook endpoint
app.post('/webhook', async (req, res) => {
    const startTime = Date.now();
    
    // Error redirect HTML
    const errorHtml = `...`; // Your existing error HTML
    
    try {
        const requestId = crypto.randomBytes(8).toString('hex');
        console.log(`[${requestId}] Webhook received`);
        
        if (!req.body) {
            console.log('❌ Empty webhook body');
            return res.send(errorHtml);
        }

        console.log('Event:', req.body.event);
        const eventType = req.body.event;
        
        // Handle payment.authorized - store mapping
        if (eventType === 'payment.authorized') {
            const payment = req.body.payload?.payment?.entity || {};
            const notes = payment.notes || {};
            const paymentPageId = notes.payment_page_id || notes.payment_page_link_id || notes.page_id || 'N/A';
            const paymentId = payment.id;
            
            console.log(`📄 Payment Page ID: ${paymentPageId}`);
            console.log(`💰 Payment ID: ${paymentId}`);
            
            // Store mapping
            linkToPaymentMap[paymentPageId] = paymentId;
            
            return res.status(200).json({ received: true });
        }
        
        // Handle payment.captured - save full details
        else if (eventType === 'payment.captured') {
            // Signature verification
            const signature = req.headers['x-razorpay-signature'];
            if (WEBHOOK_SECRET) {
                if (!signature) {
                    console.log('❌ Missing signature header');
                    return res.send(errorHtml);
                }
                if (!verifySignature(req.body, signature)) {
                    console.log('❌ Invalid signature');
                    return res.send(errorHtml);
                }
                console.log('✅ Signature verified');
            }
            
            // Validate payload
            const validation = validateWebhookPayload(req.body);
            if (!validation.valid) {
                console.log('❌ Invalid payload:', validation.error);
                return res.send(errorHtml);
            }
            
            const paymentId = validation.paymentId;
            const event = req.body.event || 'unknown';
            
            console.log(`📨 Webhook received: ${event} for ${paymentId}`);
            console.log(`[${requestId}] Payment ${paymentId}`);

            // Extract payment details
            const payment = req.body.payload?.payment?.entity || {};
            const notes = payment.notes || {};
            const acquirerData = payment.acquirer_data || {};
            const userAgent = req.headers['user-agent'] || 'unknown';
            
            const paymentPageId = notes.payment_page_id || notes.payment_page_link_id || notes.page_id || 'N/A';
            // After extracting paymentPageId, add this line:
            if (paymentPageId !== 'N/A') {
                linkToPaymentMap[paymentPageId] = paymentId;
            }
            const userAgentHash = crypto
                .createHash('sha256')
                .update(userAgent + Date.now().toString())
                .digest('hex')
                .substring(0, 16);

            console.log(`🆔 User Agent: ${userAgent}`);
            console.log(`🆔 User Agent#: ${userAgentHash}`);
            console.log(`📄 Payment Page ID: ${paymentPageId}`);

            const paymentData = {
                event,
                paymentId,
                amount: payment.amount,
                currency: payment.currency,
                status: payment.status,
                method: payment.method,
                orderId: payment.order_id,
                email: notes.email || payment.email || notes.customer_email || 'N/A',
                phone: notes.contact || payment.contact || notes.customer_phone || 'N/A',
                customer_name: notes.customer_name || 'N/A',
                bank_rrn: acquirerData.rrn || payment.rrn || 'N/A',
                bank_transaction_id: acquirerData.bank_transaction_id || 'N/A',
                bank_name: acquirerData.bank_name || 'N/A',
                ifsc: acquirerData.ifsc || 'N/A',
                vpa: acquirerData.vpa || 'N/A',
                card_id: payment.card_id || 'N/A',
                card_last4: payment.card?.last4 || 'N/A',
                card_network: payment.card?.network || 'N/A',
                card_type: payment.card?.type || 'N/A',
                description: payment.description || 'N/A',
                fee: payment.fee,
                tax: payment.tax,
                rawData: process.env.NODE_ENV === 'development' ? req.body : undefined,
                created_at: payment.created_at,
                captured_at: payment.captured_at,
                userAgentHash: userAgentHash,
                userAgent: userAgent,
                paymentPageId: paymentPageId,  // Store the Page ID!
                timestamp: new Date().toISOString(),
                receivedAt: new Date().toISOString()
            };

            // Log extracted details
            console.log(`📧 Customer email: ${paymentData.email}`);
            console.log(`📱 Customer phone: ${paymentData.phone}`);
            console.log(`🏦 Bank RRN: ${paymentData.bank_rrn}`);
            console.log(`🆔 Order ID: ${paymentData.orderId}`);

            // Save to persistent storage
            const saved = await savePayment(paymentId, paymentData);
            if (!saved) {
                console.error(`⚠️ Payment ${paymentId} received but not saved`);
            }

            const processingTime = Date.now() - startTime;
            console.log(`✅ Processed ${paymentId} in ${processingTime}ms`);

            // HTML redirect
            const redirectHtml = `...`; // Your existing redirect HTML
            
            return res.send(redirectHtml);
        }
        
        // Unknown event type
        else {
            console.log(`⚠️ Unknown event type: ${eventType}`);
            return res.status(200).json({ received: true });
        }
        
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        console.error(error.stack);
        return res.send(errorHtml);
    }
});


// Get payment details using Payment Page ID
app.get('/api/payment-by-page/:pageId', async (req, res) => {
    try {
        const { pageId } = req.params;
        console.log(`🔍 Looking up payment for Payment Page ID: ${pageId}`);
        
        const payments = await getPayments();
        
        // Find payment where paymentPageId matches
        const paymentEntry = Object.entries(payments).find(
            ([_, data]) => data.paymentPageId === pageId
        );
        
        if (paymentEntry) {
            const [paymentId, paymentData] = paymentEntry;
            res.json({
                success: true,
                paymentId: paymentId,
                details: {
                    amount: paymentData.amount,
                    timestamp: paymentData.timestamp
                }
            });
        } else {
            res.json({
                success: false,
                message: 'Payment not found for this page'
            });
        }
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// New endpoint to find payment by User-Agent
app.post('/api/find-payment-by-ua', async (req, res) => {
    try {
        const { userAgent } = req.body;
        console.log('🔍 Looking up payment for User-Agent:', userAgent.substring(0, 50) + '...');
        
        const payments = await getPayments();
        
        // Find the most recent payment from this browser
        // Sort by timestamp (newest first)
        const matchingPayments = Object.entries(payments)
            .filter(([_, data]) => data.userAgent === userAgent)
            .sort((a, b) => new Date(b[1].timestamp) - new Date(a[1].timestamp));
        
        if (matchingPayments.length > 0) {
            const [paymentId, paymentData] = matchingPayments[0];
            console.log('✅ Found matching payment:', paymentId);
            res.json({
                success: true,
                paymentId: paymentId,
                details: {
                    amount: paymentData.amount,
                    timestamp: paymentData.timestamp
                }
            });
        } else {
            console.log('❌ No payment found for this User-Agent');
            res.json({
                success: false,
                message: 'No payment found'
            });
        }
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/verify/:code', async (req, res) => {
    const { code } = req.params;
    const dbPath = path.join(__dirname, 'payment.json');
    
    try {
      const content = await fs.readFile(dbPath, 'utf8');
      const data = JSON.parse(content);
      
      // Check if code exists
      if (data[code] && !data[code].used) {
        // Mark as used (optional - for one-time use)
        data[code].used = true;
        data[code].accessedAt = new Date().toISOString();
        await fs.writeFile(dbPath, JSON.stringify(data, null, 2));
        
        // Return success with WhatsApp link
        res.json({
          valid: true,
          paymentId: data[code].paymentId,
          whatsappLink: data[code].whatsappLink
        });
      } else if (data[code] && data[code].used) {
        res.json({
          valid: false,
          message: 'This link has already been used'
        });
      } else {
        res.json({
          valid: false,
          message: 'Invalid access code'
        });
      }
    } catch (err) {
      res.status(500).json({ valid: false, message: 'Server error' });
    }
  });
// Webhook endpoint - modify your existing payment success handler
app.post('/webhook/payment-success', async (req, res) => {
    const { paymentId, email, amount } = req.body;
    
    // Your existing payment verification logic
    const isValid = await verifyPayment(paymentId);
    
    if (isValid) {
      // Generate unique access code
      const accessCode = generateAccessCode();
      await storeAccessCode(paymentId, accessCode);
      
      // Return the obfuscated link
      const joinLink = `https://innershiftnirvaana.github.io/innershiftnirvaana-repo/join?code=${accessCode}`;
      
      // Send to user (email or direct response)
      res.json({
        success: true,
        joinLink: joinLink,
        message: 'Use this link to access the group'
      });
    }
  });
// On payment success page
app.get('/payment-success-access-code', async (req, res) => {
    const paymentId = req.query.payment_id;
    
    // 1. Generate unique, random code
    const accessCode = crypto.randomBytes(8).toString('hex'); // 16 chars, hex
    
    // 2. Create signed payload
    const payload = {
      paymentId: paymentId,
      whatsappLink: 'https://chat.whatsapp.com/realgroup123',
      created: Date.now(),
      maxClicks: 1
    };
    
    // 3. Encrypt it (optional but maximum security)
    const encrypted = encryptPayload(payload, SECRET_KEY);
    
    // 4. Store in database
    await db.save({
      code: accessCode,
      data: encrypted,
      used: false,
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    
    // 5. Give user this beautiful, obfuscated link
    const finalLink = `https://join.yourdomain.com/${accessCode}`;
    // Looks like: https://join.yourdomain.com/a1b2c3d4e5f67890
    
    res.send(`
      <h2>Payment Successful!</h2>
      <p>Your private group link:</p>
      <a href="${finalLink}">${finalLink}</a>
      <p>This link expires in 7 days or after first use.</p>
    `);
  });
  
  // Handle the access link
  app.get('/join/:code', async (req, res) => {
    const { code } = req.params;
    
    // Look up in database
    const record = await db.findByCode(code);
    
    if (!record || record.used || record.expires < Date.now()) {
      return res.status(404).send('Invalid or expired link');
    }
    
    // Mark as used (for one-time links)
    await db.markAsUsed(code);
    
    // Log the access with payment ID
    console.log(`Payment ${record.paymentId} accessed link at ${new Date()}`);
    
    // Decrypt and redirect
    const payload = decryptPayload(record.data, SECRET_KEY);
    res.redirect(payload.whatsappLink);
  });

app.post('/payment-success', async (req, res) => {
    try {
        const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
        
        if (!razorpay_payment_id) {
            return res.redirect('https://pay.innershiftnirvaana.space/');
        }
        
        // Verify signature if you have the secret
        if (process.env.RAZORPAY_WEBHOOK_SECRET) {
            const generatedSignature = crypto
                .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
                .update(razorpay_order_id + "|" + razorpay_payment_id)
                .digest('hex');
                
            if (generatedSignature !== razorpay_signature) {
                console.log('❌ Invalid signature');
                return res.redirect('https://pay.innershiftnirvaana.space/');
            }
            console.log('✅ Signature verified');
        }
        
        return res.redirect(`https://pay.innershiftnirvaana.space/?pid=${razorpay_payment_id}`);
        
    } catch (error) {
        console.error('❌ Error:', error);
        return res.redirect('https://pay.innershiftnirvaana.space/');
    }
});

// ✅ Correct GET handler for Payment Links callback
app.get('/payment-success', async (req, res) => {
    try {
        // Parameters come in query string, not body
        const { 
            razorpay_payment_id,
            razorpay_payment_link_id,
            razorpay_payment_link_reference_id,
            razorpay_payment_link_status,
            razorpay_signature 
        } = req.query;

        console.log(`📨 Payment-success GET received:`, req.query);

        if (!razorpay_payment_id) {
            console.log('❌ No payment ID in callback');
            return res.redirect('https://pay.innershiftnirvaana.space/');
        }

        // Optional: Verify signature for security
        if (process.env.RAZORPAY_WEBHOOK_SECRET && razorpay_signature) {
            // Create signature string from parameters [citation:9]
            const signatureString = `${razorpay_payment_link_id}|${razorpay_payment_link_reference_id}|${razorpay_payment_link_status}|${razorpay_payment_id}`;
            
            const generatedSignature = crypto
                .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
                .update(signatureString)
                .digest('hex');
                
            if (generatedSignature !== razorpay_signature) {
                console.log('❌ Invalid signature');
                return res.redirect('https://pay.innershiftnirvaana.space/');
            }
            console.log('✅ Signature verified');
        }

        // Redirect to frontend with payment ID
        console.log(`🔄 Redirecting to frontend with payment ID: ${razorpay_payment_id}`);
        return res.redirect(`https://pay.innershiftnirvaana.space/?pid=${razorpay_payment_id}`);

    } catch (error) {
        console.error('❌ Payment-success error:', error);
        return res.redirect('https://pay.innershiftnirvaana.space/');
    }
});

// Add this endpoint to get recent payments
// Replace your recent-payments endpoint with:
app.get('/recent-payments', async (req, res) => {
    try {
        console.log('📊 Recent payments requested');
        console.log('Origin:', req.headers.origin);
        
        // Force refresh cache
        const payments = await getPayments(true);
        console.log('📊 Payments object:', payments ? 'exists' : 'null');
        
        if (!payments) {
            console.log('⚠️ Payments is null/undefined');
            return res.json({ count: 0, payments: [] });
        }
        
        console.log(`📊 Total payments in cache: ${Object.keys(payments).length}`);
        
        const paymentsArray = Object.entries(payments);
        console.log(`📊 Found ${paymentsArray.length} payments`);
        
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

app.get('/api/recent-payments', (req, res) => {
    res.redirect('/recent-payments');
});
// Add this temporary debug endpoint
app.get('/debug-payments', async (req, res) => {
    try {
        console.log('🔍 Debug payments endpoint called');
        
        // Check if payments file exists
        const fileExists = await fs.access(PAYMENTS_FILE).then(() => true).catch(() => false);
        
        let fileContent = null;
        let paymentCount = 0;
        let payments = {};
        
        if (fileExists) {
            try {
                const data = await fs.readFile(PAYMENTS_FILE, 'utf8');
                payments = JSON.parse(data);
                paymentCount = Object.keys(payments).length;
                fileContent = payments;
            } catch (readError) {
                console.error('❌ Error reading payments file:', readError.message);
            }
        }
        
        res.json({
            success: true,
            paymentsFile: PAYMENTS_FILE,
            fileExists,
            paymentCount,
            payments: fileContent,
            localStorage: {
                repoCacheExists: await fs.access(LOCAL_REPO_PATH).then(() => true).catch(() => false),
                repoCachePath: LOCAL_REPO_PATH
            }
        });
    } catch (error) {
        console.error('❌ Debug endpoint error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});
app.get('/debug-webhook-status', async (req, res) => {
    try {
        // Check if payments file exists and has content
        const fileExists = await fs.access(PAYMENTS_FILE).then(() => true).catch(() => false);
        let fileContent = {};
        let paymentCount = 0;
        
        if (fileExists) {
            try {
                const data = await fs.readFile(PAYMENTS_FILE, 'utf8');
                fileContent = JSON.parse(data);
                paymentCount = Object.keys(fileContent).length;
            } catch (e) {
                console.error('Error reading file:', e);
            }
        }
        
        // Also check your in-memory cache
        res.json({
            paymentsFile: PAYMENTS_FILE,
            fileExists,
            paymentCount,
            fileContent,
            cacheSize: paymentsCache ? Object.keys(paymentsCache).length : 0,
            cacheContent: paymentsCache
        });
    } catch (error) {
        res.json({ error: error.message });
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

// ============================================
// server-side-options.js - Complete Options Package Handler
// ============================================
app.post('/api/get-checkout-options', async (req, res) => {
    try {
    // Prevent caching
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
        const { 
            amount, 
            fullname, 
            email, 
            phone,
            currency = 'INR',
            description = 'Addiction Healing Workshop',
            themeColor = '#667eea'
        } = req.body;

        // Validate required fields
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid amount'
            });
        }

        if (!fullname || !email || !phone) {
            return res.status(400).json({
                success: false,
                error: 'Customer details (name, email, phone) are required'
            });
        }

        console.log('📦 Generating checkout options for:', { fullname, email, amount });

        // Initialize Razorpay
        const { razorpay, keyId, keySecret, isProduction, isReady } = getRazorPayCredentials();

        if (!keyId || !keySecret) {
            throw new Error('Razorpay credentials not configured');
        }

        // 2. Create order first (order_id is required for checkout)
        const orderOptions = {
            amount: amount * 100, // Convert to paise
            currency: currency,
            receipt: `receipt_${Date.now()}`,
            payment_capture: 1,
            notes: {
                purpose: description,
                fullname: fullname,
                email: email,
                phone: phone,
                created_at: new Date().toISOString()
            }
        };

        console.log('🔄 Creating Razorpay order...');
        const order = await razorpay.orders.create(orderOptions);
        console.log('✅ Order created:', order.id);

        // 4. Build the complete options package
        const checkoutOptions = {
            key: keyId,
            amount: order.amount,
            currency: order.currency,
            name: 'Inner Shift Nirvaana',
            description: description,
            order_id: order.id,
            prefill: {
                name: fullname,
                email: email,
                contact: phone
            },
            notes: {
                purpose: description,
                fullname: fullname,
                email: email,
                phone: phone,
                order_id: order.id
            },
            theme: {
                color: themeColor
            },
            // Add any additional Razorpay options here
            modal: {
                confirm_close: true, // Ask before closing
                ondismiss: {
                    // This will be handled on frontend
                }
            },
            retry: {
                enabled: true,
                max_count: 3
            },
            remember_customer: true,
            send_sms_hash: true,
            callback_url: `${req.protocol}://${req.get('host')}/api/payment-callback`,
            redirect: false
        };

        // 5. Also create a frontend handler function as string
        // (This is optional - you can let frontend define its own handler)
        const handlerFunction = `
            function(response) {
                fetch('/api/payment-success', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        razorpay_payment_id: response.razorpay_payment_id,
                        razorpay_order_id: response.razorpay_order_id,
                        razorpay_signature: response.razorpay_signature,
                        customer: ${JSON.stringify({ fullname, email, phone })}
                    })
                })
                .then(res => res.json())
                .then(data => {
                    if (data.success) {
                        window.location.href = '/success.html?payment_id=' + response.razorpay_payment_id;
                    } else {
                        alert('Payment verification failed');
                    }
                });
            }
        `;

        // 6. Return the complete package
        res.json({
            success: true,
            checkout_options: checkoutOptions,
            // Also return individual values if needed
            key_id: keyId,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            // For backward compatibility
            legacy: {
                key: keyId,
                order_id: order.id
            }
        });

    } catch (error) {
        console.error('❌ Failed to generate checkout options:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to initialize payment'
        });
    }
});
// ============================================
// PAYMENT CALLBACK ENDPOINT
// Receives POST from Razorpay after payment
// ============================================
app.post('/api/payment-callback', async (req, res) => {
    try {
        const { 
            razorpay_payment_id, 
            razorpay_order_id, 
            razorpay_signature 
        } = req.body;
        
        console.log('📞 Payment callback received:', {
            payment_id: razorpay_payment_id,
            order_id: razorpay_order_id
        });
        
        // Verify the signature (same as your verify endpoint)
        // Initialize Razorpay
        const { razorpay, keyId, keySecret, isProduction, isReady } = getRazorPayCredentials();

        if (!keyId || !keySecret) {
            throw new Error('Razorpay credentials not configured');
        }
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', keySecret)
            .update(body)
            .digest('hex');
        
        const isValid = expectedSignature === razorpay_signature;
        
        if (isValid) {
            // Update your database
            await updatePaymentStatus(razorpay_payment_id, 'success');
            
            // Redirect to success page or return JSON
            res.redirect(`https://your-site.com/success?payment_id=${razorpay_payment_id}`);
        } else {
            res.status(400).send('Invalid signature');
        }
    } catch (error) {
        console.error('❌ Callback error:', error);
        res.status(500).send('Server error');
    }
});
// ============================================
// Payment Success Handler (called by frontend)
// ============================================
app.post('/api/payment-success', async (req, res) => {
    try {
        const { 
            razorpay_payment_id, 
            razorpay_order_id, 
            razorpay_signature,
            customer 
        } = req.body;

        // Verify payment signature
        const crypto = require('crypto');
        // Initialize Razorpay
        const { razorpay, keyId, secret, isProduction, isReady } = getRazorPayCredentials();

        if (!keyId || !secret) {
            throw new Error('Razorpay credentials not configured');
        }

        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({
                success: false,
                error: 'Invalid signature'
            });
        }

        // Payment is verified - save to database
        console.log('✅ Payment verified:', razorpay_payment_id);
        
        // Store payment in your database
        // await savePayment({ razorpay_payment_id, razorpay_order_id, customer });

        res.json({
            success: true,
            payment_id: razorpay_payment_id,
            message: 'Payment verified successfully'
        });

    } catch (error) {
        console.error('❌ Payment success handler error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Add a simple keep-alive endpoint
app.get('/ping', (req, res) => {
    res.json({ status: 'alive', time: new Date().toISOString() });
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



// Initialize and start server
// Initialize and start server
async function startServer() {
    try {
        // Force /tmp if writable is false
/*         try {
            await fs.access('/tmp', fs.constants.W_OK);
            PAYMENTS_FILE = '/tmp/payments.json';
            LOG_FILE = '/tmp/webhook.log';
            console.log(`📁 Using /tmp for storage`);
        } catch (e) {
            console.error('❌ Even /tmp is not writable!');
        }      */   


        try{
            // Initialize GitHub storage
            // Create repo directory
            await fs.mkdir(LOCAL_REPO_PATH, { recursive: true });
            
            // Initialize GitHub storage
            const GITHUB_READY = await initGitStorage();
            if (GITHUB_READY) {
                console.log('✅ GitHub storage ready');
            } else {
                console.log('⚠️ Running with local storage only');
            }
            
            // Load payments
            const payments = await loadPayments();
            paymentsCache = payments;
            lastCacheUpdate = Date.now();
            
            console.log(`✅ Loaded ${Object.keys(payments).length} existing payments`);
            
        } catch (e) {
            console.error('❌ failed to initialize github storage:', e.message);
        }   
        
/*         // After forcing /tmp, test writability
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
         */
        
        // Start server
        const server = app.listen(PORT, "0.0.0.0", () => {
            console.log(`🚀 Webhook server running on port ${PORT}`);
            console.log(`📁 Payments file: ${PAYMENTS_FILE}`);
            //console.log(`🔐 Webhook secret: ${WEBHOOK_SECRET ? 'configured' : 'NOT SET'}`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        });

        // ===== ADD KEEP-ALIVE CODE HERE =====
        // Ping the server every minute to keep the connection alive
        setInterval(() => {
            const http = require('http');
            http.get(`http://localhost:${PORT}/ping`, (res) => {
                console.log('💓 Keep-alive ping sent');
            }).on('error', (err) => {
                // Ignore errors - server might be starting
            });
        }, 60000); // 60 seconds
        
        // Also add a simple ping endpoint
        app.get('/ping', (req, res) => {
            res.json({ 
                status: 'alive', 
                time: new Date().toISOString(),
                uptime: process.uptime()
            });
        });
        // ===== END KEEP-ALIVE CODE =====

        // Export server for graceful shutdown
        global.server = server;
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();