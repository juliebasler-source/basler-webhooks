/**
 * WooCommerce → QuickBooks Sync Webhook
 * 
 * Receives order.completed webhooks from WooCommerce and:
 * - Creates/finds customer in QuickBooks
 * - Creates Sales Receipt (if paid via Stripe)
 * - Creates Invoice with NET 30 (if paylater coupon used)
 * 
 * @version 1.0.0
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
    // Step 1: Validate webhook signature (if secret is configured)
    const webhookSecret = process.env.WOO_WEBHOOK_SECRET;
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
      console.log('⚠ No webhook secret configured - skipping validation');
    }

    // Step 2: Parse the WooCommerce order
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

    // Step 3: Initialize QuickBooks client
    const qb = new QuickBooksClient();
    await qb.initialize();

    // Step 4: Find or create customer
    console.log('\n👤 PROCESSING CUSTOMER...');
    const qbCustomer = await qb.findOrCreateCustomer(order.customer);
    console.log(`   QB Customer ID: ${qbCustomer.Id}`);
    console.log(`   QB Customer Name: ${qbCustomer.DisplayName}`);

    // Step 5: Create transaction based on payment type
    if (order.isPaylater) {
      // Paylater = Create Invoice with NET 30
      console.log('\n📄 CREATING INVOICE (NET 30)...');
      const invoice = await qb.createInvoice(qbCustomer, order);
      console.log(`   Invoice ID: ${invoice.Id}`);
      console.log(`   Invoice Number: ${invoice.DocNumber}`);
      console.log(`   Due Date: ${invoice.DueDate}`);
      
      // Auto-send the invoice
      console.log('\n📧 SENDING INVOICE...');
      await qb.sendInvoice(invoice.Id);
      console.log(`   ✓ Invoice sent to ${order.customer.email}`);
      
    } else {
      // Paid = Create Sales Receipt
      console.log('\n🧾 CREATING SALES RECEIPT...');
      const receipt = await qb.createSalesReceipt(qbCustomer, order);
      console.log(`   Receipt ID: ${receipt.Id}`);
      console.log(`   Receipt Number: ${receipt.DocNumber}`);
    }

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

    // Return 200 anyway to prevent WooCommerce retries for handled errors
    // Log the error for debugging but acknowledge receipt
    return res.status(200).json({ 
      success: false, 
      error: error.message 
    });
  }
}
