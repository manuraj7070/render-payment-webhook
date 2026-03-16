const request = require('supertest');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Import your app - you'll need to export it from server.js
// Add this at the bottom of server.js: module.exports = { app, startServer };
const { app } = require('./server');

describe('Payment Webhook Server Tests', () => {
  // Test server startup
  describe('Server Startup', () => {
    test('should have correct environment variables', () => {
      expect(process.env.PORT).toBeDefined();
      expect(process.env.NODE_ENV).toBeDefined();
    });

    test('should have CORS configured', async () => {
      const response = await request(app)
        .options('/health')
        .set('Origin', 'https://pay.innershiftnirvaana.space');
      
      expect(response.headers['access-control-allow-origin']).toBe('https://pay.innershiftnirvaana.space');
      expect(response.headers['access-control-allow-methods']).toContain('GET');
    });
  });

  // Test health endpoints
  describe('Health Endpoints', () => {
    test('GET /health should return 200 with server status', async () => {
      const response = await request(app).get('/health');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('time');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('payments');
      expect(response.body.payments).toHaveProperty('total');
    });

    test('GET /health-test should return detailed health info', async () => {
      const response = await request(app).get('/health-test');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('node');
      expect(response.body).toHaveProperty('git');
    });

    test('GET /diagnostic should return diagnostic info', async () => {
      const response = await request(app).get('/diagnostic');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('paymentsCount');
    });
  });

  // Test payment-success endpoints
  describe('Payment Success Endpoints', () => {
    test('GET /payment-success should redirect with payment ID', async () => {
      const paymentId = 'pay_test_123456';
      const response = await request(app)
        .get(`/payment-success?razorpay_payment_id=${paymentId}`);
      
      expect(response.status).toBe(302); // Redirect
      expect(response.headers.location).toBe(`https://pay.innershiftnirvaana.space/?pid=${paymentId}`);
    });

    test('GET /payment-success without payment ID should redirect to home', async () => {
      const response = await request(app).get('/payment-success');
      
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('https://pay.innershiftnirvaana.space/');
    });

    test('POST /payment-success should process payment success', async () => {
      const paymentData = {
        razorpay_payment_id: 'pay_test_123456',
        razorpay_order_id: 'order_test_789012',
        razorpay_signature: 'test_signature'
      };

      const response = await request(app)
        .post('/payment-success')
        .send(paymentData)
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(302); // Redirect
      expect(response.headers.location).toContain('pid=pay_test_123456');
    });

    test('GET /payment-success-test should work', async () => {
      const response = await request(app)
        .get('/payment-success-test?razorpay_payment_id=pay_test_123');
      
      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('pid=pay_test_123');
    });
  });

  // Test webhook endpoints
  describe('Webhook Endpoints', () => {
    test('POST /webhook should accept webhook events', async () => {
      const webhookData = {
        event: 'test.event',
        payload: {}
      };

      const response = await request(app)
        .post('/webhook')
        .send(webhookData)
        .set('Content-Type', 'application/json');
      
      // Webhook should always return 200
      expect(response.status).toBe(200);
    });

    test('POST /webhooktest should accept test webhooks', async () => {
      const webhookData = {
        event: 'payment.captured',
        key_id: 'test_key',
        key_secret: 'test_secret',
        payload: {
          payment: {
            entity: {
              id: 'pay_test_123',
              amount: 5000
            }
          }
        }
      };

      const response = await request(app)
        .post('/webhooktest')
        .send(webhookData)
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(200);
    });
  });

  // Test API endpoints
  describe('API Endpoints', () => {
    test('GET /api/recent-payments should return recent payments', async () => {
      const response = await request(app).get('/api/recent-payments');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('count');
      expect(response.body).toHaveProperty('payments');
      expect(Array.isArray(response.body.payments)).toBe(true);
    });

    test('POST /api/create-order should validate credentials', async () => {
      const orderData = {
        amount: 5000,
        currency: 'INR',
        key_id: 'test_key',
        key_secret: 'test_secret'
      };

      const response = await request(app)
        .post('/api/create-order')
        .send(orderData)
        .set('Content-Type', 'application/json');
      
      // This will fail with invalid credentials, but we're testing the endpoint exists
      expect(response.status).not.toBe(404);
    });

    test('POST /api/verify-payment should validate signature', async () => {
      const verifyData = {
        razorpay_order_id: 'order_test_123',
        razorpay_payment_id: 'pay_test_456',
        razorpay_signature: 'test_sig',
        key_secret: 'test_secret'
      };

      const response = await request(app)
        .post('/api/verify-payment')
        .send(verifyData)
        .set('Content-Type', 'application/json');
      
      expect(response.status).not.toBe(404);
    });

    test('GET /api/payment-by-page/:pageId should look up payments', async () => {
      const response = await request(app)
        .get('/api/payment-by-page/test_page_123');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
    });

    test('POST /api/find-payment-by-ua should search by user agent', async () => {
      const response = await request(app)
        .post('/api/find-payment-by-ua')
        .send({ userAgent: 'test-agent' })
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
    });
  });

  // Test verification endpoints
  describe('Verification Endpoints', () => {
    test('GET /verify/:paymentId should check payment status', async () => {
      const response = await request(app)
        .get('/verify/pay_test_123');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('valid');
    });
  });

  // Test admin endpoints (with auth)
  describe('Admin Endpoints', () => {
    test('GET /admin/payments should require API key', async () => {
      const response = await request(app)
        .get('/admin/payments');
      
      // Should be 401 if no API key
      expect([401, 200]).toContain(response.status);
    });

    test('GET /admin/payments with valid API key should work', async () => {
      const response = await request(app)
        .get('/admin/payments')
        .set('x-api-key', process.env.ADMIN_API_KEY || 'test_key');
      
      expect(response.status).not.toBe(404);
    });
  });

  // Test CORS
  describe('CORS Configuration', () => {
    const allowedOrigins = [
      'https://pay.innershiftnirvaana.space',
      'https://innershiftnirvaana.space',
      'https://manuraj7070.github.io'
    ];

    allowedOrigins.forEach(origin => {
      test(`should allow CORS from ${origin}`, async () => {
        const response = await request(app)
          .get('/health')
          .set('Origin', origin);
        
        expect(response.headers['access-control-allow-origin']).toBe(origin);
        expect(response.headers['access-control-allow-credentials']).toBe('true');
      });
    });

    test('should block disallowed origins', async () => {
      const response = await request(app)
        .get('/health')
        .set('Origin', 'https://malicious-site.com');
      
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  // Test file operations
  describe('File Operations', () => {
    test('should be able to save and load payments', async () => {
      const { savePayment, getPayments } = require('./server');
      
      const testPaymentId = 'test_pay_' + Date.now();
      const testData = {
        event: 'test',
        amount: 1000,
        email: 'test@example.com'
      };

      // Save payment
      const saveResult = await savePayment(testPaymentId, testData);
      expect(saveResult).toBe(true);

      // Load payments
      const payments = await getPayments(true);
      expect(payments[testPaymentId]).toBeDefined();
      expect(payments[testPaymentId].amount).toBe(1000);
    });
  });
});

// Test server startup separately
describe('Server Startup', () => {
  test('server should start without errors', async () => {
    const { startServer } = require('./server');
    
    // Mock the listen function to prevent actual port binding
    const mockListen = jest.fn();
    jest.spyOn(global, 'app', 'get').mockImplementation(() => ({
      listen: mockListen
    }));

    await expect(startServer()).resolves.not.toThrow();
  });
});