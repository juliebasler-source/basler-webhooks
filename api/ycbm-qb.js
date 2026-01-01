/**
 * YCBM → QuickBooks Webhook Handler
 * 
 * @version 1.2.0
 * @description Processes YouCanBookMe booking webhooks and creates QuickBooks records
 * @lastUpdated 2026-01-01
 * 
 * CHANGELOG v1.2.0:
 * - Added failed webhook logging to KV for retry capability
 * 
 * CHANGELOG v1.1.0:
 * - Added DepositToAccountRef to Sales Receipts (fixes QB validation error)
 * - Added String() conversion for all QB IDs for consistency
 * 
 * FLOWS:
 * 1. Customer pays via Stripe → Sales Receipt (or Invoice + Payment if extras)
 * 2. Customer uses paylater coupon → Invoice for full amount (NET 30)
 * 
 * WEBHOOK PAYLOAD (from YCBM):
 * {
 *   "source": "ycbm",
 *   "bookingId": "...",
 *   "firstName": "...",
 *   "lastName": "...",
 *   "email": "...",
 *   "phone": "...",
 *   "additionalTeamMembers": "3",
 *   "appointmentType": "60 Minute Phase 1 - Leader Only",
 *   "price": "$ 1,750.00",
 *   "startDate": "2025-12-31T07:00:00-07:00",
 *   "bookingStatus": "UPCOMING",
 *   "bookingRef": "GJPA-YYBP-QMUT"
 * }
 */

import { 
  getQBClient, 
  findOrCreateCustomer, 
  createSalesReceipt, 
  createInvoice,
  createPayment,
  getItemPrice
} from '../lib/quickbooks.js';
import { findStripePayment } from '../lib/stripe-lookup.js';
import { parseYCBMPayload } from '../lib/parse-ycbm.js';
import { logFailedWebhook } from '../lib/failed-webhooks.js';

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('='.repeat(60));
  console.log('YCBM WEBHOOK RECEIVED');
  console.log('Timestamp:', new Date().toISOString());
  console.log('='.repeat(60));

  try {
    // 1. Parse and validate the YCBM payload
    const booking = parseYCBMPayload(req.body);
    
    console.log('\n📋 BOOKING DATA:');
    console.log(`   Customer: ${booking.firstName} ${booking.lastName}`);
    console.log(`   Email: ${booking.email}`);
    console.log(`   Phone: ${booking.phone}`);
    console.log(`   Additional Team Members: ${booking.additionalTeamMembers}`);
    console.log(`   Base Price: $${booking.basePrice}`);
    console.log(`   Booking Ref: ${booking.bookingRef}`);
    console.log(`   Appointment: ${booking.appointmentType}`);

    // Skip non-Phase 1 bookings (optional - remove if you want all bookings)
    if (!booking.appointmentType.includes('Phase 1')) {
      console.log('\n⏭️  Skipping - Not a Phase 1 booking');
      return res.status(200).json({ 
        status: 'skipped', 
        reason: 'Not a Phase 1 booking',
        bookingRef: booking.bookingRef 
      });
    }

    // 2. Get QuickBooks client and fetch current prices
    const qb = await getQBClient();
    
    console.log('\n💰 FETCHING QB PRICES...');
    const bstPrice = await getItemPrice(qb, process.env.QB_ITEM_BST);
    const addPrice = await getItemPrice(qb, process.env.QB_ITEM_ADD);
    console.log(`   Building Strong Teams: $${bstPrice}`);
    console.log(`   Additional Team Member: $${addPrice}`);

    // 3. Calculate total due
    const totalDue = bstPrice + (booking.additionalTeamMembers * addPrice);
    console.log(`\n📊 TOTAL DUE: $${totalDue}`);
    console.log(`   Base: $${bstPrice}`);
    console.log(`   Extras: ${booking.additionalTeamMembers} × $${addPrice} = $${booking.additionalTeamMembers * addPrice}`);

    // 4. Check Stripe for payment
    console.log('\n🔍 CHECKING STRIPE FOR PAYMENT...');
    const stripePayment = await findStripePayment(booking.email, bstPrice);
    
    // 5. Find or create customer in QuickBooks
    console.log('\n👤 FINDING/CREATING QB CUSTOMER...');
    const customer = await findOrCreateCustomer(qb, {
      firstName: booking.firstName,
      lastName: booking.lastName,
      email: booking.email,
      phone: booking.phone
    });
    console.log(`   Customer ID: ${customer.Id}`);
    console.log(`   Customer Name: ${customer.DisplayName}`);

    // 6. Determine which flow to use and create QB record
    let result;

    if (!stripePayment) {
      // FLOW: Paylater - No Stripe payment found
      console.log('\n📝 FLOW: PAYLATER (No Stripe payment)');
      console.log('   Creating Invoice for full amount...');
      
      result = await createYCBMInvoice(qb, {
        customer,
        bstItemId: process.env.QB_ITEM_BST,
        addItemId: process.env.QB_ITEM_ADD,
        bstPrice,
        addPrice,
        additionalMembers: booking.additionalTeamMembers,
        bookingRef: booking.bookingRef,
        memo: `YCBM Booking: ${booking.bookingRef}`
      });
      
      console.log(`   ✅ Invoice created: #${result.DocNumber}`);
      console.log(`   Amount: $${result.TotalAmt}`);
      console.log(`   Due Date: ${result.DueDate}`);

    } else if (booking.additionalTeamMembers > 0 && stripePayment.amount < totalDue) {
      // FLOW: Partial payment - Paid base, owes for extras
      console.log('\n📝 FLOW: PARTIAL PAYMENT');
      console.log(`   Stripe paid: $${stripePayment.amount}`);
      console.log(`   Total due: $${totalDue}`);
      console.log(`   Balance: $${totalDue - stripePayment.amount}`);
      console.log('   Creating Invoice + Payment...');
      
      result = await createYCBMInvoiceWithPayment(qb, {
        customer,
        bstItemId: process.env.QB_ITEM_BST,
        addItemId: process.env.QB_ITEM_ADD,
        bstPrice,
        addPrice,
        additionalMembers: booking.additionalTeamMembers,
        paymentAmount: stripePayment.amount,
        stripeChargeId: stripePayment.chargeId,
        bookingRef: booking.bookingRef,
        memo: `YCBM Booking: ${booking.bookingRef}`
      });
      
      console.log(`   ✅ Invoice created: #${result.invoice.DocNumber}`);
      console.log(`   ✅ Payment applied: $${stripePayment.amount}`);
      console.log(`   Balance due: $${result.invoice.Balance}`);

    } else {
      // FLOW: Full payment - Create Sales Receipt
      console.log('\n📝 FLOW: FULL PAYMENT');
      console.log(`   Stripe paid: $${stripePayment.amount}`);
      console.log('   Creating Sales Receipt...');
      
      result = await createYCBMSalesReceipt(qb, {
        customer,
        bstItemId: process.env.QB_ITEM_BST,
        addItemId: process.env.QB_ITEM_ADD,
        bstPrice,
        addPrice,
        additionalMembers: booking.additionalTeamMembers,
        bookingRef: booking.bookingRef,
        memo: `YCBM Booking: ${booking.bookingRef} | Stripe: ${stripePayment.chargeId}`
      });
      
      console.log(`   ✅ Sales Receipt created: #${result.DocNumber}`);
      console.log(`   Amount: $${result.TotalAmt}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ YCBM WEBHOOK PROCESSED SUCCESSFULLY');
    console.log('='.repeat(60));

    return res.status(200).json({
      status: 'success',
      bookingRef: booking.bookingRef,
      customer: customer.DisplayName,
      qbRecord: result.DocNumber || result.invoice?.DocNumber
    });

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('Stack:', error.stack);

    // Log to KV for retry (skip if this is already a retry)
    if (!req.headers['x-retry-webhook']) {
      await logFailedWebhook('ycbm', req.body, error.message, {
        bookingRef: req.body?.bookingRef,
        customer: `${req.body?.firstName} ${req.body?.lastName}`,
        email: req.body?.email
      });
    }

    return res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
}

/**
 * Create Invoice for paylater bookings (NET 30)
 */
async function createYCBMInvoice(qb, data) {
  const { customer, bstItemId, addItemId, bstPrice, addPrice, additionalMembers, bookingRef, memo } = data;
  
  // Build line items
  const lineItems = [
    {
      DetailType: 'SalesItemLineDetail',
      Amount: bstPrice,
      Description: 'Building Strong Teams Program',
      SalesItemLineDetail: {
        ItemRef: { value: String(bstItemId) },
        Qty: 1,
        UnitPrice: bstPrice
      }
    }
  ];

  // Add additional team members if any
  if (additionalMembers > 0) {
    lineItems.push({
      DetailType: 'SalesItemLineDetail',
      Amount: additionalMembers * addPrice,
      Description: `Additional Team Members (${additionalMembers})`,
      SalesItemLineDetail: {
        ItemRef: { value: String(addItemId) },
        Qty: additionalMembers,
        UnitPrice: addPrice
      }
    });
  }

  // Calculate NET 30 due date
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  const invoiceData = {
    CustomerRef: { value: String(customer.Id) },
    Line: lineItems,
    DueDate: dueDate.toISOString().split('T')[0],
    PrivateNote: memo,
    CustomerMemo: { value: `Booking Reference: ${bookingRef}` }
  };

  return new Promise((resolve, reject) => {
    qb.createInvoice(invoiceData, (err, invoice) => {
      if (err) {
        console.error('QB Invoice Error:', err);
        reject(new Error(`Failed to create invoice: ${err.message || JSON.stringify(err)}`));
      } else {
        resolve(invoice);
      }
    });
  });
}

/**
 * Create Sales Receipt for fully paid bookings
 */
async function createYCBMSalesReceipt(qb, data) {
  const { customer, bstItemId, addItemId, bstPrice, addPrice, additionalMembers, bookingRef, memo } = data;
  
  // Build line items
  const lineItems = [
    {
      DetailType: 'SalesItemLineDetail',
      Amount: bstPrice,
      Description: 'Building Strong Teams Program',
      SalesItemLineDetail: {
        ItemRef: { value: String(bstItemId) },
        Qty: 1,
        UnitPrice: bstPrice
      }
    }
  ];

  // Add additional team members if any
  if (additionalMembers > 0) {
    lineItems.push({
      DetailType: 'SalesItemLineDetail',
      Amount: additionalMembers * addPrice,
      Description: `Additional Team Members (${additionalMembers})`,
      SalesItemLineDetail: {
        ItemRef: { value: String(addItemId) },
        Qty: additionalMembers,
        UnitPrice: addPrice
      }
    });
  }

  const receiptData = {
    CustomerRef: { value: String(customer.Id) },
    Line: lineItems,
    PrivateNote: memo,
    CustomerMemo: { value: `Booking Reference: ${bookingRef}` },
    PaymentMethodRef: { value: '1' },  // Credit Card
    DepositToAccountRef: { value: process.env.QB_DEPOSIT_ACCOUNT || '154' }
  };

  return new Promise((resolve, reject) => {
    qb.createSalesReceipt(receiptData, (err, receipt) => {
      if (err) {
        console.error('QB Sales Receipt Error:', err);
        reject(new Error(`Failed to create sales receipt: ${err.message || JSON.stringify(err)}`));
      } else {
        resolve(receipt);
      }
    });
  });
}

/**
 * Create Invoice with partial payment applied
 */
async function createYCBMInvoiceWithPayment(qb, data) {
  const { customer, paymentAmount, stripeChargeId, ...invoiceData } = data;
  
  // First create the invoice
  const invoice = await createYCBMInvoice(qb, { ...invoiceData, customer });
  
  // Then apply the payment
  const paymentData = {
    CustomerRef: { value: String(customer.Id) },
    TotalAmt: paymentAmount,
    Line: [
      {
        Amount: paymentAmount,
        LinkedTxn: [
          {
            TxnId: String(invoice.Id),
            TxnType: 'Invoice'
          }
        ]
      }
    ],
    PrivateNote: `Stripe Payment: ${stripeChargeId}`
  };

  const payment = await new Promise((resolve, reject) => {
    qb.createPayment(paymentData, (err, payment) => {
      if (err) {
        console.error('QB Payment Error:', err);
        // Non-fatal - invoice was created
        console.log('⚠️  Payment creation failed, invoice created without payment');
        resolve(null);
      } else {
        resolve(payment);
      }
    });
  });

  // Refresh invoice to get updated balance
  const updatedInvoice = await new Promise((resolve, reject) => {
    qb.getInvoice(invoice.Id, (err, inv) => {
      if (err) resolve(invoice); // Return original if refresh fails
      else resolve(inv);
    });
  });

  return { invoice: updatedInvoice, payment };
}
