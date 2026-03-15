const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// Log all requests
app.use((req, res, next) => {
    console.log(`📨 ${req.method} ${req.url} from ${req.headers.origin || 'unknown'}`);
    next();
});

// Simple GET endpoint
app.get('/health', (req, res) => {
    console.log('✓ Health check hit');
    res.json({ 
        status: 'OK', 
        time: new Date().toISOString(),
        port: PORT 
    });
});

// Simple webhook endpoint
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    console.log('✓ Webhook received');
    console.log('Headers:', req.headers);
    console.log('Raw body:', req.body?.toString() || '(empty)');
    res.status(200).send('OK');
});

// Simple test endpoint
app.get('/test', (req, res) => {
    res.json({ message: 'Server is working!' });
});

// Catch-all for debugging
app.use('*', (req, res) => {
    console.log(`❓ Unknown route: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Route not found', path: req.originalUrl });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log(`✅ SERVER STARTED SUCCESSFULLY`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🔗 Health: http://0.0.0.0:${PORT}/health`);
    console.log(`🔗 Webhook: http://0.0.0.0:${PORT}/webhook (POST)`);
    console.log('='.repeat(50));
});

// Error handling
server.on('error', (err) => {
    console.error('❌ Server error:', err);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err);
});