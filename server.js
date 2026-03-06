require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage (use a database in production)
const payments = new Map();

// Webhook endpoint
app.post('/webhook', (req, res) => {
    console.log('📨 Webhook received at:', new Date().toISOString());
    console.log('Event:', req.body.event);
    
    const paymentId = req.body.payload?.payment?.entity?.id;
    const orderId = req.body.payload?.payment?.entity?.order_id;
    
    if (paymentId) {
        payments.set(paymentId, {
            orderId,
            timestamp: new Date().toISOString(),
            event: req.body.event
        });
        console.log('✅ Payment stored:', paymentId);
    }
    
    res.json({ 
        received: true,
        paymentId 
    });
});

// Verification endpoint
app.get('/verify/:paymentId', (req, res) => {
    const paymentId = req.params.paymentId;
    const payment = payments.get(paymentId);
    
    if (payment) {
        res.json({ 
            valid: true, 
            paymentId,
            details: payment
        });
    } else {
        res.json({ 
            valid: false, 
            paymentId 
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        time: new Date().toISOString(),
        payments: payments.size 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook server running on port ${PORT}`);
});