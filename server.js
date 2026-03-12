const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const simpleGit = require('simple-git');
const Razorpay = require('razorpay');
const axios = require('axios');
const PORT = process.env.PORT || 3000; // Fallback for local dev


// No Razorpay initialization here - will be created per request

// In-memory store for payment link mappings
const linkToPaymentMap = {};
// ============================================
// Global Error Handlers
// ============================================
process.on('uncaughtException', (error) => {
    console.error('💥 UNCAUGHT EXCEPTION:', error);
    console.error('Stack:', error.stack);
    // Keep process alive for 1 second to log, then exit
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 UNHANDLED REJECTION at:', promise);
    console.error('Reason:', reason);
});

const app = express();

// Add request logging middleware right after CORS
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.url} - ${new Date().toISOString()}`);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    next();
});

// Add response time tracking
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`📤 ${req.method} ${req.url} - ${res.statusCode} - ${duration}ms`);
    });
    next();
});
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
// Test git immediately
(async () => {
    try {
        console.log('🔧 Testing Git configuration...');
        const status = await git.status();
        console.log('✅ Git working, branch:', status.current);
    } catch (error) {
        console.error('❌ Git initialization failed:', error.message);
        // Don't exit - app can still work without Git
        console.log('⚠️ Continuing without Git functionality');
    }
})();

app.use(express.json({ limit: '1mb' }));

const cors = require('cors');

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
    : [
        'https://manuraj7070.github.io',
        'https://innershiftnirvaana.space',
        'https://pay.innershiftnirvaana.space',
        'https://588380366-atari-embeds.googleusercontent.com',
        'https://*.googleusercontent.com'
      ]; 

console.log('🔓 Allowed CORS origins:', allowedOrigins);

app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
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

// ============================================
// Helper function to create Razorpay instance from request
// ============================================
function getRazorpayInstance(keyId, keySecret) {
    if (!keyId || !keySecret) {
        throw new Error('Razorpay key_id and key_secret are required');
    }
    return new Razorpay({
        key_id: keyId,
        key_secret: keySecret
    });
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
// ============================================
// NEW ENDPOINT: Create Razorpay Order (with credentials in payload)
// ============================================
app.post('/api/create-order', async (req, res) => {
    try {
        const { 
            amount, 
            currency = 'INR', 
            receipt, 
            notes,
            key_id,          // Razorpay Key ID from frontend
            key_secret        // Razorpay Key Secret from frontend
        } = req.body;
        
        // Validate required fields
        if (!key_id || !key_secret) {
            return res.status(400).json({
                success: false,
                error: 'Razorpay credentials (key_id, key_secret) are required'
            });
        }

        // Validate amount
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid amount. Must be greater than 0'
            });
        }

        console.log(`💰 Creating order for amount: ₹${amount} with key: ${key_id.substring(0, 8)}...`);

        // Create Razorpay instance with provided credentials
        const razorpay = getRazorpayInstance(key_id, key_secret);

        // Create order in Razorpay
        const orderOptions = {
            amount: amount * 100, // Convert to paise
            currency: currency,
            receipt: receipt || `receipt_${Date.now()}`,
            payment_capture: 1, // Auto capture payment
            notes: notes || {}
        };

        const order = await razorpay.orders.create(orderOptions);

        console.log(`✅ Order created: ${order.id}`);

        // Return order details to frontend
        res.json({
            success: true,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            receipt: order.receipt,
            status: order.status
            // Don't send key_id back - already have it
        });

    } catch (error) {
        console.error('❌ Order creation error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to create order'
        });
    }
});

// ============================================
// NEW ENDPOINT: Verify Payment Signature (with credentials in payload)
// ============================================
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { 
            razorpay_order_id, 
            razorpay_payment_id, 
            razorpay_signature,
            key_secret  // Key secret from frontend for verification
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !key_secret) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields (order_id, payment_id, signature, key_secret)'
            });
        }

        // Create signature string
        const body = razorpay_order_id + '|' + razorpay_payment_id;

        // Generate expected signature using provided key_secret
        const expectedSignature = crypto
            .createHmac('sha256', key_secret)
            .update(body.toString())
            .digest('hex');

        // Compare signatures
        const isValid = expectedSignature === razorpay_signature;

        if (isValid) {
            console.log(`✅ Payment verified for order: ${razorpay_order_id}`);
            
            // Store payment mapping
            linkToPaymentMap[razorpay_order_id] = razorpay_payment_id;
            
            res.json({
                success: true,
                message: 'Payment verified successfully',
                payment_id: razorpay_payment_id
            });
        } else {
            console.log('❌ Invalid payment signature');
            res.status(400).json({
                success: false,
                error: 'Invalid signature'
            });
        }

    } catch (error) {
        console.error('❌ Payment verification error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
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
});

// ============================================
// Webhook Endpoint (with credentials in payload)
// ============================================
app.post('/webhook', async (req, res) => {
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
            const saved = await savePayment(paymentId, paymentData);
            
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

// ============================================
// Rest of your existing endpoints (unchanged)
// ============================================

// Get payment by page ID
app.get('/api/payment-by-page/:pageId', async (req, res) => {
    try {
        const { pageId } = req.params;
        console.log(`🔍 Looking up payment for Payment Page ID: ${pageId}`);
        
        const payments = await getPayments();
        
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

// Find payment by User-Agent
app.post('/api/find-payment-by-ua', async (req, res) => {
    try {
        const { userAgent } = req.body;
        console.log('🔍 Looking up payment for User-Agent:', userAgent.substring(0, 50) + '...');
        
        const payments = await getPayments();
        
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

// Payment success handlers (keep your existing ones)
app.post('/payment-success', async (req, res) => {
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

app.get('/payment-success', async (req, res) => {
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

// Recent payments endpoint
app.get('/api/recent-payments', async (req, res) => {
    try {
        const payments = await getPayments(true);
        
        if (!payments) {
            return res.json({ count: 0, payments: [] });
        }
        
        const paymentsArray = Object.entries(payments);
        
        const recent = paymentsArray
            .map(([id, data]) => ({
                paymentId: id,
                timestamp: data?.timestamp || new Date().toISOString(),
                amount: data?.amount || 0,
                orderId: data?.orderId || null
            }))
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 5);
        
        res.json({
            count: recent.length,
            payments: recent
        });
    } catch (error) {
        console.error('❌ Recent payments error:', error.message);
        res.status(500).json({ count: 0, payments: [] });
    }
});

// Verify payment endpoint
app.get('/verify/:paymentId', async (req, res) => {
    try {
        const paymentId = req.params.paymentId;
        
        const payments = await loadPayments();
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
            res.json({ valid: false, message: 'Payment not found' });
        }
    } catch (error) {
        console.error('Verification error:', error.message);
        res.status(500).json({ valid: false, error: 'Verification failed' });
    }
});

// Health check
// Enhanced health check
app.get('/health', async (req, res) => {
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
// ============================================
// Helper functions (keep your existing ones)
// ============================================

// ... (keep all your existing helper functions: ensureDirectories, loadPayments, 
// getPayments, savePayment, syncToGitHub, gracefulShutdown, etc.)

// [Copy all your existing helper functions here - they remain unchanged]

// Start server
// Start server
async function startServer() {
    try {
        console.log('🚀 Webhook server starting...');
        console.log('📦 Node version:', process.version);
        console.log('📂 Working directory:', __dirname);
        console.log('🔧 Environment:', {
            PORT: process.env.PORT,
            NODE_ENV: process.env.NODE_ENV,
            GITHUB_TOKEN: process.env.GITHUB_TOKEN ? '✅ Set' : '❌ Not set',
            ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? '✅ Set' : '❌ Not set'
        });

        // Test GitHub token if present
        if (process.env.GITHUB_TOKEN) {
            console.log('🔑 GitHub token length:', process.env.GITHUB_TOKEN.length);
        }

        const server = app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
            const address = server.address();
            console.log(`✅ Server successfully listening!`);
            console.log(`📡 Port: ${address.port}`);
            console.log(`🌐 Address: ${address.address}`);
            console.log(`🔓 CORS enabled for: ${allowedOrigins.length} origins`);
            console.log(`🏥 Health check: /health`);
        });

        server.on('error', (error) => {
            console.error('❌ Server error:', error);
        });

        global.server = server;
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

startServer();