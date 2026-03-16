#!/bin/bash

echo "🧪 Running Payment Webhook Server Tests"
echo "========================================"

# Set test environment
export NODE_ENV=test
export PORT=3001
export RAZORPAY_MODE=test
export RAZORPAY_TEST_KEY_ID=rzp_test_123456
export RAZORPAY_TEST_KEY_SECRET=test_secret

# Run tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
# npx jest server.test.js

echo "========================================"
echo "✅ Tests completed"