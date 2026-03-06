const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' })); // Limit payload size

// Configuration with defaults
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');
const LOG_FILE = path.join(__dirname, 'webhook.log');
const MAX_PAYMENTS = 10000; // Prevent unlimited file growth

// Ensure directories exist
async function ensureDirectories() {
    try {
        await fs.mkdir(path.dirname(PAYMENTS_FILE), { recursive: true });
    } catch (error) {
        // Directory probably exists
    }
}

// Load payments with error recovery
async function loadPayments() {
    try {
        const data = await fs.readFile(PAYMENTS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist - return empty object
            return {};
        }
        // Corrupted file - backup and start fresh
        try {
            const backupFile = `${PAYMENTS_FILE}.backup.${Date.now()}`;
            await fs.rename(PAYMENTS_FILE, backupFile);
            console.log(`⚠️ Corrupted payments file backed up to ${backupFile}`);
        } catch (backupError) {
            console.error('Could not backup corrupted file:', backupError.message);
        }
        return {};
    }
}

// Save payment with atomic write
async function savePayment(paymentId, paymentData) {
    try {
        // Load current payments
        const payments = await loadPayments();
        
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
        
        // 7. Send success response
        res.json({ 
            received: true,
            paymentId,
            time: processingTime
        });
        
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        console.error(error.stack);
        
        // Always return 200 to prevent Razorpay retries
        // but indicate error in response
        res.status(200).json({ 
            received: true, 
            error: error.message,
            note: 'Payment received but processing failed'
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
        
        const payments = await loadPayments();
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
        const payments = await loadPayments();
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
async function startServer() {
    try {
        // Ensure directories exist
        await ensureDirectories();
        
        // Load existing payments on startup
        const payments = await loadPayments();
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