/**
 * WooCommerce → QuickBooks Sync Webhook
 * 
 * Receives order webhooks from WooCommerce and:
 * - Creates/finds customer in QuickBooks
 * - Creates Sales Receipt (if paid via Stripe)
 * - Creates Invoice with NET 30 (if paylater coupon used)
 * 
 * @version 1.2.0
 * @lastUpdated 2024-12-30
 * 
 * CHANGELOG v1.2.0:
 * - Made invoice sending non-fatal (invoice still created if send fails)
 * - Paylater orders now use full prices for invoicing
 * 
 * CHANGELOG v1.1.0:
 * - Temporarily disabled webhook signature validation for testing
 * - Added order status check (only process "completed" orders)
 * - Improved logging
 */

import { validateWooCommerceWebhook } from '../lib/validate-webhook.js';
import { parseWooCommerceOrder } from '../lib/parse-order.js';
import { QuickBooksClient } from '../lib/quickbooks.js';

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('='.repeat(60));
  console.log('WEBHOOK RECEIVED:', new Date().toISOString());
  console.log('='.repeat(60));

  try {
    // =========================================================================
    // Step 1: Validate webhook signature
    // =========================================================================
    
    const webhookSecret = null; // TEMP: Disabled for testing
    // const webhookSecret = process.env.WOO_WEBHOOK_SECRET; // RE-ENABLE LATER
    
    if (webhookSecret) {
      const signature = req.headers['x-wc-webhook-signature'];
      const isValid = validateWooCommerceWebhook(
        JSON.stringify(req.body),
        signature,
        webhookSecret
      );
      
      if (!isValid) {
        console.log('❌ Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
      console.log('✓ Webhook signature validated');
    } else {
      console.log('⚠ Webhook signature validation disabled (testing mode)');
    }

    // =========================================================================
    // Step 2: Check order status (only process completed orders)
    // =========================================================================
    
    const orderStatus = req.body?.status;
    console.log(`📋 Order Status: ${orderStatus}`);
    
    if (orderStatus !== 'completed') {
      console.log(`⏭ Skipping - order is "${orderStatus}", not "completed"`);
      return res.status(200).json({ 
        success: true, 
        skipped: true,
        reason: `Order status is "${orderStatus}", not "completed"` 
      });
    }

    // =========================================================================
    // Step 3: Parse the WooCommerce order
    // =========================================================================
    
    const order = parseWooCommerceOrder(req.body);
    
    console.log('\n📦 ORDER DETAILS:');
    console.log(`   Order ID: ${order.orderId}`);
    console.log(`   Customer: ${order.customer.displayName}`);
    console.log(`   Email: ${order.customer.email}`);
    console.log(`   Total: $${order.total}`);
    console.log(`   Is Paylater: ${order.isPaylater}`);
    console.log(`   Line Items: ${order.lineItems.length}`);
    
    order.lineItems.forEach((item, i) => {
      console.log(`     ${i + 1}. ${item.name} x${item.quantity} = $${item.total}`);
    });

    // =========================================================================
    // Step 4: Initialize QuickBooks client
    // =========================================================================
    
    const qb = new QuickBooksClient();
    await qb.initialize();

    // =========================================================================
    // Step 5: Find or create customer in QuickBooks
    // =========================================================================
    
    console.log('\n👤 PROCESSING CUSTOMER...');
    const qbCustomer = await qb.findOrCreateCustomer(order.customer);
    console.log(`   QB Customer ID: ${qbCustomer.Id}`);
    console.log(`   QB Customer Name: ${qbCustomer.DisplayName}`);

    // =========================================================================
    // Step 6: Create transaction based on payment type
    // =========================================================================
    
    if (order.isPaylater) {
      // Paylater coupon used = Create Invoice with NET 30 terms
      console.log('\n📄 CREATING INVOICE (NET 30)...');
      const invoice = await qb.createInvoice(qbCustomer, order);
      console.log(`   Invoice ID: ${invoice.Id}`);
      console.log(`   Invoice Number: ${invoice.DocNumber || 'auto-assigned'}`);
      console.log(`   Due Date: ${invoice.DueDate}`);
      console.log(`   Total: $${invoice.TotalAmt}`);
      
      // Auto-send the invoice (non-fatal if it fails)
      console.log('\n📧 SENDING INVOICE...');
      try {
        await qb.sendInvoice(invoice.Id);
        console.log(`   ✓ Invoice sent to ${order.customer.email}`);
      } catch (sendError) {
        console.warn(`   ⚠ Could not auto-send invoice: ${sendError.message}`);
        console.warn(`   → Invoice was created successfully but needs manual sending from QuickBooks`);
      }
      
    } else {
      // Paid via Stripe = Create Sales Receipt (already paid)
      console.log('\n🧾 CREATING SALES RECEIPT...');
      const receipt = await qb.createSalesReceipt(qbCustomer, order);
      console.log(`   Receipt ID: ${receipt.Id}`);
      console.log(`   Receipt Number: ${receipt.DocNumber || 'auto-assigned'}`);
      console.log(`   Total: $${receipt.TotalAmt}`);
    }

    // =========================================================================
    // Step 7: Success response
    // =========================================================================
    
    console.log('\n' + '='.repeat(60));
    console.log('✓ WEBHOOK PROCESSED SUCCESSFULLY');
    console.log('='.repeat(60));

    return res.status(200).json({ 
      success: true,
      orderId: order.orderId,
      isPaylater: order.isPaylater,
      customerId: qbCustomer.Id
    });

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);

    return res.status(200).json({ 
      success: false, 
      error: error.message 
    });
  }
}
