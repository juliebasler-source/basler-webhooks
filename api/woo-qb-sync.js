/**
 * WooCommerce → QuickBooks Sync Webhook
 * 
 * Receives order webhooks from WooCommerce and:
 * - Creates/finds customer in QuickBooks
 * - Creates Sales Receipt (if paid via Stripe)
 * - Creates Invoice with NET 30 (if paylater coupon used)
 * 
 * @version 1.4.0
 * @lastUpdated 2025-01-01
 * 
 * CHANGELOG v1.4.0:
 * - Added DepositToAccountRef to Sales Receipts (fixes QB validation error)
 * - Fixed item.price → item.unitPrice field reference
 * - Added String() conversion for all QB IDs
 * - Added PaymentMethodRef for credit card payments
 * 
 * CHANGELOG v1.3.0:
 * - Fixed imports to use function-based QuickBooks API
 * 
 * CHANGELOG v1.2.0:
 * - Made invoice sending non-fatal (invoice still created if send fails)
 * - Paylater orders now use full prices for invoicing
 */

import { validateWooCommerceWebhook } from '../lib/validate-webhook.js';
import { parseWooCommerceOrder } from '../lib/parse-order.js';
import { 
  getQBClient, 
  findOrCreateCustomer, 
  createSalesReceipt, 
  createInvoice, 
  sendInvoice 
} from '../lib/quickbooks.js';

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
      console.log(`     ${i + 1}. ${item.name} x${item.quantity} @ $${item.unitPrice} = $${item.total}`);
    });

    // =========================================================================
    // Step 4: Initialize QuickBooks client
    // =========================================================================
    
    const qb = await getQBClient();

    // =========================================================================
    // Step 5: Find or create customer in QuickBooks
    // =========================================================================
    
    console.log('\n👤 PROCESSING CUSTOMER...');
    const qbCustomer = await findOrCreateCustomer(qb, order.customer);
    console.log(`   QB Customer ID: ${qbCustomer.Id}`);
    console.log(`   QB Customer Name: ${qbCustomer.DisplayName}`);

    // =========================================================================
    // Step 6: Create transaction based on payment type
    // =========================================================================
    
    if (order.isPaylater) {
      // Paylater coupon used = Create Invoice with NET 30 terms
      console.log('\n📄 CREATING INVOICE (NET 30)...');
      
      // Build invoice data
      const invoiceData = buildInvoiceData(qbCustomer, order);
      const invoice = await createInvoice(qb, invoiceData);
      
      console.log(`   Invoice ID: ${invoice.Id}`);
      console.log(`   Invoice Number: ${invoice.DocNumber || 'auto-assigned'}`);
      console.log(`   Due Date: ${invoice.DueDate}`);
      console.log(`   Total: $${invoice.TotalAmt}`);
      
      // Auto-send the invoice (non-fatal if it fails)
      console.log('\n📧 SENDING INVOICE...');
      const sendResult = await sendInvoice(qb, invoice.Id, order.customer.email);
      if (sendResult) {
        console.log(`   ✓ Invoice sent to ${order.customer.email}`);
      } else {
        console.warn(`   ⚠ Could not auto-send invoice`);
        console.warn(`   → Invoice was created successfully but needs manual sending from QuickBooks`);
      }
      
    } else {
      // Paid via Stripe = Create Sales Receipt (already paid)
      console.log('\n🧾 CREATING SALES RECEIPT...');
      
      // Build receipt data
      const receiptData = buildSalesReceiptData(qbCustomer, order);
      const receipt = await createSalesReceipt(qb, receiptData);
      
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

/**
 * Build QuickBooks Invoice data structure
 * Used for paylater orders (NET 30 terms)
 */
function buildInvoiceData(qbCustomer, order) {
  // Calculate due date (NET 30)
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);
  
  return {
    CustomerRef: { value: String(qbCustomer.Id) },
    BillEmail: { Address: order.customer.email },
    DueDate: dueDate.toISOString().split('T')[0],
    PrivateNote: `WooCommerce Order #${order.orderId}`,
    Line: order.lineItems.map(item => ({
      Amount: parseFloat(item.total),
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: String(item.qbItemId || process.env.QB_ITEM_BST) },
        Qty: item.quantity,
        UnitPrice: parseFloat(item.unitPrice)
      },
      Description: item.name
    }))
  };
}

/**
 * Build QuickBooks Sales Receipt data structure
 * Used for paid orders (Stripe payment completed)
 */
function buildSalesReceiptData(qbCustomer, order) {
  return {
    CustomerRef: { value: String(qbCustomer.Id) },
    BillEmail: { Address: order.customer.email },
    PrivateNote: `WooCommerce Order #${order.orderId}`,
    PaymentMethodRef: { value: '1' },  // Credit Card
    DepositToAccountRef: { value: process.env.QB_DEPOSIT_ACCOUNT || '154' },
    Line: order.lineItems.map(item => ({
      Amount: parseFloat(item.total),
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: String(item.qbItemId || process.env.QB_ITEM_BST) },
        Qty: item.quantity,
        UnitPrice: parseFloat(item.unitPrice)
      },
      Description: item.name
    }))
  };
}
