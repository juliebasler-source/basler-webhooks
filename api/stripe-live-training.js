/**
 * Stripe Live Training → QuickBooks Integration
 *
 * @version 1.0.1
 * @description Handles Stripe checkout.session.completed webhooks for
 *              Basler Academy Live Training Event purchases.
 *              Creates a QuickBooks Sales Receipt for each completed payment.
 *
 * CHANGELOG v1.0.1:
 * - Fixed Stripe signature verification by reading raw body from request stream
 *   (Vercel parses JSON body by default which breaks Stripe signature check)
 */

import Stripe from 'stripe';
import {
  getQBClient,
  findOrCreateCustomer,
  createSalesReceipt,
  getItemPrice
} from '../lib/quickbooks.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const FALLBACK_PRICE = 125;
const PAYMENT_METHOD_REF = 'Stripe';

// ============================================================================
// RAW BODY HELPER
// ============================================================================

/**
 * Read raw body from request stream
 * Required for Stripe webhook signature verification
 */
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ============================================================================
// VERCEL CONFIG — disable automatic body parsing so we get the raw stream
// ============================================================================

export const config = {
  api: {
    bodyParser: false
  }
};

// ============================================================================
// MAIN HANDLER
// ============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('═'.repeat(60));
  console.log('💳 STRIPE LIVE TRAINING WEBHOOK RECEIVED');
  console.log('Timestamp:', new Date().toISOString());
  console.log('═'.repeat(60));

  // ==========================================================================
  // Step 1: Verify Stripe webhook signature using raw body
  // ==========================================================================

  const webhookSecret = process.env.STRIPE_LIVE_TRAINING_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('❌ STRIPE_LIVE_TRAINING_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    console.log(`✓ Stripe signature verified`);
    console.log(`   Event type: ${event.type}`);
    console.log(`   Event ID:   ${event.id}`);
  } catch (err) {
    console.error('❌ Stripe signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature invalid: ${err.message}` });
  }

  // ==========================================================================
  // Step 2: Only process checkout.session.completed events
  // ==========================================================================

  if (event.type !== 'checkout.session.completed') {
    console.log(`⏭  Ignoring event type: ${event.type}`);
    return res.status(200).json({ received: true, action: 'ignored', reason: `Event type ${event.type} not handled` });
  }

  const session = event.data.object;

  if (session.payment_status !== 'paid') {
    console.log(`⏭  Ignoring session with payment_status: ${session.payment_status}`);
    return res.status(200).json({ received: true, action: 'ignored', reason: 'Payment not complete' });
  }

  console.log(`\n📋 SESSION DETAILS`);
  console.log(`   Session ID:     ${session.id}`);
  console.log(`   Payment Status: ${session.payment_status}`);
  console.log(`   Amount Total:   $${(session.amount_total / 100).toFixed(2)}`);

  // ==========================================================================
  // Step 3: Extract customer data from Stripe session
  // ==========================================================================

  console.log(`\n👤 EXTRACTING CUSTOMER DATA...`);

  const customerDetails = session.customer_details || {};
  const email    = customerDetails.email || '';
  const fullName = customerDetails.name  || 'Unknown';
  const phone    = customerDetails.phone || '';
  const address  = customerDetails.address || {};

  const nameParts = fullName.trim().split(' ');
  const firstName = nameParts[0] || 'Unknown';
  const lastName  = nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'Customer';
  const amountPaid = session.amount_total ? session.amount_total / 100 : null;

  console.log(`   Name:    ${firstName} ${lastName}`);
  console.log(`   Email:   ${email}`);
  console.log(`   Phone:   ${phone || '(none)'}`);
  console.log(`   Amount:  $${amountPaid}`);

  if (!email) {
    console.error('❌ No email in Stripe session');
    return res.status(400).json({ error: 'No customer email in Stripe session' });
  }

  // ==========================================================================
  // Step 4: Initialize QuickBooks client
  // ==========================================================================

  console.log(`\n🔗 CONNECTING TO QUICKBOOKS...`);
  let qb;
  try {
    qb = await getQBClient();
    console.log(`   ✓ QuickBooks connected`);
  } catch (err) {
    console.error('❌ Failed to connect to QuickBooks:', err.message);
    return res.status(500).json({ error: 'QuickBooks connection failed', message: err.message });
  }

  // ==========================================================================
  // Step 5: Find or create QB customer by email
  // ==========================================================================

  console.log(`\n👤 LOOKING UP QB CUSTOMER...`);
  let qbCustomer;
  try {
    qbCustomer = await findOrCreateCustomer(qb, {
      firstName,
      lastName,
      email,
      phone,
      billingAddress: address.line1 ? {
        Line1: address.line1,
        Line2: address.line2 || '',
        City: address.city || '',
        CountrySubDivisionCode: address.state || '',
        PostalCode: address.postal_code || '',
        Country: address.country || ''
      } : undefined
    });
    console.log(`   ✓ QB Customer: ${qbCustomer.DisplayName} (ID: ${qbCustomer.Id})`);
  } catch (err) {
    console.error('❌ Failed to find/create QB customer:', err.message);
    return res.status(500).json({ error: 'QB customer lookup failed', message: err.message });
  }

  // ==========================================================================
  // Step 6: Get live price from QB item
  // ==========================================================================

  console.log(`\n💰 FETCHING QB ITEM PRICE...`);
  const itemId = process.env.QB_ITEM_LIVE_TRAINING || '5';
  let unitPrice;

  try {
    unitPrice = await getItemPrice(qb, itemId);
    console.log(`   ✓ QB Item ${itemId} price: $${unitPrice}`);
  } catch (err) {
    console.warn(`   ⚠ Could not fetch QB item price, using Stripe amount`);
    unitPrice = amountPaid || FALLBACK_PRICE;
  }

  const receiptAmount = amountPaid || unitPrice;

  // ==========================================================================
  // Step 7: Create QB Sales Receipt
  // ==========================================================================

  console.log(`\n🧾 CREATING QB SALES RECEIPT...`);
  console.log(`   Customer:  ${qbCustomer.DisplayName}`);
  console.log(`   Amount:    $${receiptAmount}`);

  const receiptData = {
    CustomerRef: {
      value: String(qbCustomer.Id)
    },
    PaymentMethodRef: {
      name: PAYMENT_METHOD_REF
    },
    Line: [
      {
        Amount: receiptAmount,
        DetailType: 'SalesItemLineDetail',
        Description: 'Basler Academy Live Training Event',
        SalesItemLineDetail: {
          ItemRef: {
            value: String(itemId)
          },
          Qty: 1,
          UnitPrice: receiptAmount
        }
      }
    ],
    PrivateNote: `Stripe Session: ${session.id} | ${new Date().toISOString()}`
  };

  let receipt;
  try {
    receipt = await createSalesReceipt(qb, receiptData);
    console.log(`   ✓ Sales Receipt created!`);
    console.log(`   Receipt ID:     ${receipt.Id}`);
    console.log(`   Receipt Number: ${receipt.DocNumber || 'auto-assigned'}`);
    console.log(`   Total:          $${receipt.TotalAmt}`);
  } catch (err) {
    console.error('❌ Failed to create QB Sales Receipt:', err.message);
    return res.status(500).json({ error: 'QB sales receipt creation failed', message: err.message });
  }

  // ==========================================================================
  // Step 8: Return success
  // ==========================================================================

  console.log(`\n✅ COMPLETE`);
  console.log('═'.repeat(60));

  return res.status(200).json({
    received: true,
    action: 'sales_receipt_created',
    stripeSession: session.id,
    customer: { name: `${firstName} ${lastName}`, email },
    quickbooks: {
      customerId: qbCustomer.Id,
      receiptId: receipt.Id,
      receiptNumber: receipt.DocNumber,
      amount: receipt.TotalAmt
    }
  });
}
