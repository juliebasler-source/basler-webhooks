/**
 * Stripe Live Training → QuickBooks Integration
 *
 * @version 1.0.0
 * @description Handles Stripe checkout.session.completed webhooks for
 *              Basler Academy Live Training Event purchases.
 *              Creates a QuickBooks Sales Receipt for each completed payment.
 *
 * FLOW:
 *   Stripe Payment Link purchased
 *     → Stripe fires checkout.session.completed webhook
 *     → Verify Stripe webhook signature
 *     → Extract customer data (name, email, address, phone, amount)
 *     → Find or create QB customer (lookup by email)
 *     → Fetch live price from QB item (QB_ITEM_LIVE_TRAINING)
 *     → Create QB Sales Receipt
 *     → Return 200
 *
 * ENVIRONMENT VARIABLES:
 *   STRIPE_LIVE_TRAINING_WEBHOOK_SECRET  - Stripe webhook signing secret (whsec_...)
 *   QB_ITEM_LIVE_TRAINING                - QB Item ID for live training product (e.g. "5")
 *   STRIPE_SECRET_KEY                    - Existing Stripe secret key (already set)
 *   QB_CLIENT_ID, QB_CLIENT_SECRET,
 *   QB_REFRESH_TOKEN, QB_REALM_ID,
 *   QB_ENVIRONMENT                       - Existing QB vars (already set)
 *
 * TO GO LIVE:
 *   1. Create webhook in Stripe LIVE mode pointing to this same URL
 *   2. Update STRIPE_LIVE_TRAINING_WEBHOOK_SECRET in Vercel with the live whsec_
 *   3. No code changes needed
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

// Fallback price if QB item lookup fails
const FALLBACK_PRICE = 125;

// Payment method reference shown on QB sales receipt
const PAYMENT_METHOD_REF = 'Stripe';

// ============================================================================
// MAIN HANDLER
// ============================================================================

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('═'.repeat(60));
  console.log('💳 STRIPE LIVE TRAINING WEBHOOK RECEIVED');
  console.log('Timestamp:', new Date().toISOString());
  console.log('═'.repeat(60));

  // ==========================================================================
  // Step 1: Verify Stripe webhook signature
  // ==========================================================================

  const webhookSecret = process.env.STRIPE_LIVE_TRAINING_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('❌ STRIPE_LIVE_TRAINING_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    // Stripe requires the raw body for signature verification.
    // Vercel provides req.body as a parsed object, so we re-stringify it.
    // For production robustness, raw body middleware is ideal but this works
    // reliably for JSON payloads.
    const rawBody = JSON.stringify(req.body);
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

  // Only process paid sessions
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

  // Split full name into first/last (best effort)
  const nameParts  = fullName.trim().split(' ');
  const firstName  = nameParts[0] || 'Unknown';
  const lastName   = nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'Customer';

  // Amount paid in dollars
  const amountPaid = session.amount_total ? session.amount_total / 100 : null;

  console.log(`   Name:    ${firstName} ${lastName}`);
  console.log(`   Email:   ${email}`);
  console.log(`   Phone:   ${phone || '(none)'}`);
  console.log(`   Address: ${address.city || ''} ${address.state || ''} ${address.country || ''}`);
  console.log(`   Amount:  $${amountPaid}`);

  if (!email) {
    console.error('❌ No email in Stripe session — cannot look up or create QB customer');
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
  // Step 5: Find or create QB customer (by email)
  // ==========================================================================

  console.log(`\n👤 LOOKING UP QB CUSTOMER...`);
  let qbCustomer;
  try {
    qbCustomer = await findOrCreateCustomer(qb, {
      firstName,
      lastName,
      email,
      phone,
      // Pass address fields so new customers get full data
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
    console.warn(`   ⚠ Could not fetch QB item price, using amount from Stripe: $${amountPaid}`);
    unitPrice = amountPaid || FALLBACK_PRICE;
  }

  // Use Stripe amount if available (most accurate), fall back to QB item price
  const receiptAmount = amountPaid || unitPrice;

  // ==========================================================================
  // Step 7: Create QB Sales Receipt
  // ==========================================================================

  console.log(`\n🧾 CREATING QB SALES RECEIPT...`);
  console.log(`   Customer:  ${qbCustomer.DisplayName}`);
  console.log(`   Item ID:   ${itemId}`);
  console.log(`   Amount:    $${receiptAmount}`);
  console.log(`   Stripe ID: ${session.id}`);

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
    PrivateNote: `Stripe Session: ${session.id} | Payment Link purchase | ${new Date().toISOString()}`
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
    customer: {
      name: `${firstName} ${lastName}`,
      email
    },
    quickbooks: {
      customerId: qbCustomer.Id,
      receiptId: receipt.Id,
      receiptNumber: receipt.DocNumber,
      amount: receipt.TotalAmt
    }
  });
}
