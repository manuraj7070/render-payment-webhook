const express = require('express');
const app = express();

// ✅ CRITICAL FIX: Use Railway's PORT environment variable
const PORT = process.env.PORT || 8080;  // Railway assigns 8080, not 3000
console.log('🔥 RAILWAY DIAGNOSTIC START');
console.log('📌 Process ID:', process.pid);
console.log('📌 Platform:', process.platform);
console.log('📌 Node version:', process.version);
console.log('📌 Memory usage:', process.memoryUsage());
console.log('📌 Uptime:', process.uptime());
console.log('🔥 DEBUG: Server starting...');
console.log('📌 Railway PORT env:', process.env.PORT);
console.log('📌 Using PORT:', PORT);

// Simple GET endpoint
app.get('/health', (req, res) => {
    console.log('✓ Health check hit');
    res.json({ 
        status: 'OK', 
        time: new Date().toISOString(),
        port: PORT,
        env_port: process.env.PORT
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
app.use((req, res) => {
    console.log(`❓ Unknown route: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Route not found', path: req.originalUrl });
});

// ✅ Bind to 0.0.0.0 with Railway's PORT

// Add after server starts
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log(`✅ SERVER STARTED SUCCESSFULLY`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`📡 Host: 0.0.0.0`);
    console.log(`📡 Process ID: ${process.pid}`);
    console.log(`🔗 Health: http://0.0.0.0:${PORT}/health`);
    
    // List all network interfaces
    const os = require('os');
    const nets = os.networkInterfaces();
    console.log('📡 Network interfaces:');
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            console.log(`   ${name}: ${net.address} (${net.family})`);
        }
    }
    console.log('='.repeat(50));
});
// Error handling
server.on('error', (err) => {
    console.error('❌ Server error:', err);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err);
});