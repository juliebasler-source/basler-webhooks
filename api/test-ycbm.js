/**
 * YCBM Integration Test Endpoint
 * 
 * @version 1.0.0
 * @description Test endpoint for debugging YCBM → QB integration
 * @lastUpdated 2024-12-31
 * 
 * ENDPOINTS:
 * GET /api/test-ycbm                - Basic health check
 * GET /api/test-ycbm?test=stripe    - Test Stripe connection
 * GET /api/test-ycbm?test=qb        - Test QuickBooks connection
 * GET /api/test-ycbm?test=prices    - Fetch current QB prices
 * GET /api/test-ycbm?test=charges   - List recent Stripe charges
 */

import { getQBClient, getItemPrice, testConnection as testQB } from '../lib/quickbooks.js';
import { verifyStripeConnection, getRecentCharges } from '../lib/stripe-lookup.js';

export default async function handler(req, res) {
  const testType = req.query.test || 'health';

  console.log(`\n🧪 TEST ENDPOINT: ${testType}`);
  console.log('Timestamp:', new Date().toISOString());

  try {
    switch (testType) {
      case 'health':
        return res.status(200).json({
          status: 'ok',
          message: 'YCBM webhook endpoint is running',
          timestamp: new Date().toISOString(),
          endpoints: {
            health: '/api/test-ycbm',
            stripe: '/api/test-ycbm?test=stripe',
            quickbooks: '/api/test-ycbm?test=qb',
            prices: '/api/test-ycbm?test=prices',
            charges: '/api/test-ycbm?test=charges'
          }
        });

      case 'stripe':
        console.log('\n📍 Testing Stripe connection...');
        const stripeOk = await verifyStripeConnection();
        return res.status(stripeOk ? 200 : 500).json({
          status: stripeOk ? 'ok' : 'error',
          test: 'Stripe connection',
          connected: stripeOk,
          message: stripeOk ? 'Stripe API connected successfully' : 'Stripe connection failed - check STRIPE_SECRET_KEY'
        });

      case 'qb':
        console.log('\n📍 Testing QuickBooks connection...');
        const qbOk = await testQB();
        return res.status(qbOk ? 200 : 500).json({
          status: qbOk ? 'ok' : 'error',
          test: 'QuickBooks connection',
          connected: qbOk,
          message: qbOk ? 'QuickBooks API connected successfully' : 'QuickBooks connection failed - check OAuth tokens'
        });

      case 'prices':
        console.log('\n📍 Fetching QuickBooks prices...');
        const qb = await getQBClient();
        
        const bstId = process.env.QB_ITEM_BST || '21';
        const addId = process.env.QB_ITEM_ADD || '22';
        
        const bstPrice = await getItemPrice(qb, bstId);
        const addPrice = await getItemPrice(qb, addId);
        
        return res.status(200).json({
          status: 'ok',
          test: 'QuickBooks prices',
          items: {
            buildingStrongTeams: {
              itemId: bstId,
              price: bstPrice,
              formatted: `$${bstPrice.toFixed(2)}`
            },
            additionalTeamMember: {
              itemId: addId,
              price: addPrice,
              formatted: `$${addPrice.toFixed(2)}`
            }
          },
          examples: {
            team6: { base: bstPrice, extras: 0, total: bstPrice },
            team8: { base: bstPrice, extras: 2 * addPrice, total: bstPrice + 2 * addPrice },
            team10: { base: bstPrice, extras: 4 * addPrice, total: bstPrice + 4 * addPrice }
          }
        });

      case 'charges':
        console.log('\n📍 Fetching recent Stripe charges...');
        const charges = await getRecentCharges(10);
        
        return res.status(200).json({
          status: 'ok',
          test: 'Recent Stripe charges',
          count: charges.length,
          charges: charges.map(c => ({
            id: c.id,
            amount: `$${c.amount}`,
            email: c.email,
            status: c.status,
            created: c.created,
            isWooCommerce: c.isWooCommerce
          }))
        });

      default:
        return res.status(400).json({
          status: 'error',
          message: `Unknown test type: ${testType}`,
          validTests: ['health', 'stripe', 'qb', 'prices', 'charges']
        });
    }

  } catch (error) {
    console.error('Test error:', error.message);
    return res.status(500).json({
      status: 'error',
      test: testType,
      message: error.message
    });
  }
}
