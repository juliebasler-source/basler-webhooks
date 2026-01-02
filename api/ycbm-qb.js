/**
 * YCBM → QuickBooks Integration
 * 
 * @version 2.1.0
 * @description Handle YouCanBookMe webhooks and create QuickBooks records
 * @lastUpdated 2025-01-02
 * 
 * CHANGELOG v2.1.0:
 * - Fixed PARTIAL_PAYMENT: creates ONE Invoice + applies Payment (not two records)
 * - Added dynamic QB price lookup via getItemPrice()
 * - Fixed customer creation to pass firstName/lastName/phone
 * 
 * CHANGELOG v2.0.1:
 * - Fixed ES module syntax (import instead of require)
 * 
 * CHANGELOG v2.0.0:
 * - Complete rewrite with 4-flow architecture
 * - Flow 1 (Paylater): Invoice full amount, send invoice
 * - Flow 2 (Simple Paid): Sales Receipt for amount paid
 * - Flow 3 (Paid + Discount): Sales Receipt with discount line
 * - Flow 4 (Partial Payment): Invoice + Payment applied, send invoice
 * - Supports both fixed and percentage discounts
 * - Percentage discounts apply to extras
 */

import { parseYCBMPayload } from '../lib/parse-ycbm.js';
import { findPaymentByEmail, centsToDollars } from '../lib/stripe-lookup.js';
import { 
  getQBClient, 
  findOrCreateCustomer, 
  createSalesReceipt,
  createInvoice,
  createPayment,
  sendInvoice,
  getItemPrice
} from '../lib/quickbooks.js';

// Default prices (used for paylater when no Stripe data)
const DEFAULT_BST_PRICE = 1750;
const DEFAULT_ADD_PRICE = 99;

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  console.log('═'.repeat(60));
  console.log('📅 YCBM WEBHOOK RECEIVED');
  console.log('═'.repeat(60));
  
  try {
    const payload = req.body;
    
    // Verify this is from YCBM
    if (payload.source !== 'ycbm') {
      console.log('⚠️ Not a YCBM payload, ignoring');
      return res.status(200).json({ status: 'ignored', reason: 'not ycbm' });
    }
    
    // Parse the booking data
    const booking = parseYCBMPayload(payload);
    
    console.log(`\n👤 Customer: ${booking.fullName}`);
    console.log(`📧 Email: ${booking.email}`);
    console.log(`📋 Booking Ref: ${booking.bookingRef}`);
    console.log(`👥 Additional Team Members: ${booking.additionalTeamMembers}`);
    
    // Get QuickBooks client
    const qb = await getQBClient();
    
    // Fetch prices from QuickBooks (falls back to defaults if lookup fails)
    console.log(`\n💰 Fetching QB Prices...`);
    const bstPrice = await getItemPrice(qb, process.env.QB_ITEM_BST || '21');
    const addPrice = await getItemPrice(qb, process.env.QB_ITEM_ADD || '22');
    console.log(`   Base (BST): $${bstPrice}`);
    console.log(`   Additional: $${addPrice}`);
    
    // Find or create customer in QuickBooks
    const customer = await findOrCreateCustomer(qb, {
      firstName: booking.firstName,
      lastName: booking.lastName,
      email: booking.email,
      phone: booking.phone
    });
    console.log(`\n✓ QB Customer: ${customer.DisplayName} (ID: ${customer.Id})`);
    
    // Search Stripe for payment (extended to 60 min for testing)
    const stripePayment = await findPaymentByEmail(booking.email, 60);
    
    // Determine which flow to use
    let flow;
    if (!stripePayment.found) {
      flow = 'PAYLATER';
    } else if (booking.additionalTeamMembers > 0) {
      flow = 'PARTIAL_PAYMENT';
    } else if (stripePayment.discountAmount > 0) {
      flow = 'PAID_WITH_DISCOUNT';
    } else {
      flow = 'SIMPLE_PAID';
    }
    
    console.log(`\n🔀 Processing Flow: ${flow}`);
    
    let result;
    
    switch (flow) {
      case 'PAYLATER':
        result = await handlePaylater(qb, customer, booking, bstPrice, addPrice);
        break;
        
      case 'SIMPLE_PAID':
        result = await handleSimplePaid(qb, customer, booking, stripePayment);
        break;
        
      case 'PAID_WITH_DISCOUNT':
        result = await handlePaidWithDiscount(qb, customer, booking, stripePayment);
        break;
        
      case 'PARTIAL_PAYMENT':
        result = await handlePartialPayment(qb, customer, booking, stripePayment, bstPrice, addPrice);
        break;
    }
    
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅ SUCCESS - ${flow}`);
    console.log(`   QB Record: ${result.type} #${result.docNumber}`);
    if (result.paymentAmount) console.log(`   Payment Applied: $${result.paymentAmount.toFixed(2)}`);
    if (result.balanceDue) console.log(`   Balance Due: $${result.balanceDue.toFixed(2)}`);
    if (result.invoiceSent) console.log(`   📧 Invoice sent to customer`);
    console.log('═'.repeat(60));
    
    return res.status(200).json({
      status: 'success',
      flow: flow,
      ...result
    });
    
  } catch (error) {
    console.error(`\n❌ ERROR: ${error.message}`);
    console.error(error.stack);
    
    return res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
}

/**
 * Flow 1: PAYLATER - No Stripe payment found
 * Create invoice for full amount at QB prices
 */
async function handlePaylater(qb, customer, booking, bstPrice, addPrice) {
  console.log('\n📋 Creating PAYLATER Invoice (full amount)...');
  
  const lines = [];
  
  // Line 1: Building Strong Teams
  lines.push({
    Amount: bstPrice,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: String(process.env.QB_ITEM_BST) },
      Qty: 1,
      UnitPrice: bstPrice
    },
    Description: 'Building Strong Teams'
  });
  
  // Line 2: Additional Team Members (if any)
  if (booking.additionalTeamMembers > 0) {
    const extrasTotal = booking.additionalTeamMembers * addPrice;
    lines.push({
      Amount: extrasTotal,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: String(process.env.QB_ITEM_ADD) },
        Qty: booking.additionalTeamMembers,
        UnitPrice: addPrice
      },
      Description: `Additional Team Members (${booking.additionalTeamMembers})`
    });
  }
  
  // Calculate due date (NET 30)
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);
  
  const invoiceData = {
    CustomerRef: { value: String(customer.Id) },
    BillEmail: { Address: booking.email },
    Line: lines,
    DueDate: dueDate.toISOString().split('T')[0],
    PrivateNote: `YCBM Booking: ${booking.bookingRef}`
  };
  
  const invoice = await createInvoice(qb, invoiceData);
  console.log(`   ✓ Invoice created: #${invoice.DocNumber}`);
  
  // Send the invoice
  let invoiceSent = false;
  try {
    const sendResult = await sendInvoice(qb, invoice.Id, booking.email);
    if (sendResult) {
      invoiceSent = true;
      console.log(`   ✓ Invoice sent to ${booking.email}`);
    }
  } catch (e) {
    console.log(`   ⚠️ Could not send invoice: ${e.message}`);
  }
  
  return {
    type: 'Invoice',
    docNumber: invoice.DocNumber,
    invoiceId: invoice.Id,
    total: invoice.TotalAmt,
    invoiceSent
  };
}

/**
 * Flow 2: SIMPLE_PAID - Stripe payment, no extras, no discount
 * Create Sales Receipt for amount paid
 */
async function handleSimplePaid(qb, customer, booking, stripePayment) {
  console.log('\n🧾 Creating Sales Receipt (simple paid)...');
  
  const amountPaid = centsToDollars(stripePayment.amountPaid);
  
  const lines = [{
    Amount: amountPaid,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: String(process.env.QB_ITEM_BST) },
      Qty: 1,
      UnitPrice: amountPaid
    },
    Description: 'Building Strong Teams'
  }];
  
  const receiptData = {
    CustomerRef: { value: String(customer.Id) },
    BillEmail: { Address: booking.email },
    Line: lines,
    PrivateNote: `YCBM Booking: ${booking.bookingRef}`,
    PaymentMethodRef: { value: '1' },
    DepositToAccountRef: { value: process.env.QB_DEPOSIT_ACCOUNT || '154' }
  };
  
  const receipt = await createSalesReceipt(qb, receiptData);
  console.log(`   ✓ Sales Receipt created: #${receipt.DocNumber}`);
  
  return {
    type: 'SalesReceipt',
    docNumber: receipt.DocNumber,
    total: receipt.TotalAmt
  };
}

/**
 * Flow 3: PAID_WITH_DISCOUNT - Stripe payment with discount, no extras
 * Create Sales Receipt with discount line item
 */
async function handlePaidWithDiscount(qb, customer, booking, stripePayment) {
  console.log('\n🧾 Creating Sales Receipt (with discount)...');
  
  const subtotal = centsToDollars(stripePayment.subtotal);
  const discountAmount = centsToDollars(stripePayment.discountAmount);
  const couponCode = stripePayment.couponCode || 'Discount';
  
  const lines = [
    // Line 1: Building Strong Teams at subtotal (pre-discount)
    {
      Amount: subtotal,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: String(process.env.QB_ITEM_BST) },
        Qty: 1,
        UnitPrice: subtotal
      },
      Description: 'Building Strong Teams'
    },
    // Line 2: Discount (negative amount)
    {
      Amount: -discountAmount,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: String(process.env.QB_ITEM_DISCOUNT) },
        Qty: 1,
        UnitPrice: -discountAmount
      },
      Description: `Discount (${couponCode})`
    }
  ];
  
  const receiptData = {
    CustomerRef: { value: String(customer.Id) },
    BillEmail: { Address: booking.email },
    Line: lines,
    PrivateNote: `YCBM Booking: ${booking.bookingRef} | Coupon: ${couponCode}`,
    PaymentMethodRef: { value: '1' },
    DepositToAccountRef: { value: process.env.QB_DEPOSIT_ACCOUNT || '154' }
  };
  
  const receipt = await createSalesReceipt(qb, receiptData);
  console.log(`   ✓ Sales Receipt created: #${receipt.DocNumber}`);
  console.log(`   ✓ Discount applied: -$${discountAmount.toFixed(2)} (${couponCode})`);
  
  return {
    type: 'SalesReceipt',
    docNumber: receipt.DocNumber,
    total: receipt.TotalAmt,
    discountApplied: discountAmount,
    couponCode
  };
}

/**
 * Flow 4: PARTIAL_PAYMENT - Stripe payment + extras (balance due)
 * Creates ONE invoice showing everything, then applies Stripe payment
 * 
 * Invoice shows:
 *   Building Strong Teams      $1,750.00
 *   Additional Team Members      $99.00 (x qty)
 *   Discount                  -$XXX.XX
 *   ─────────────────────────────────────
 *   Total                     $XXX.XX
 *   Payment (Stripe)          -$XX.XX
 *   ─────────────────────────────────────
 *   Balance Due               $XX.XX
 */
async function handlePartialPayment(qb, customer, booking, stripePayment, bstPrice, addPrice) {
  console.log('\n📋 Creating Invoice + Payment (partial)...');
  
  // Calculate amounts from Stripe
  const subtotal = centsToDollars(stripePayment.subtotal);
  const discountAmount = centsToDollars(stripePayment.discountAmount);
  const amountPaid = centsToDollars(stripePayment.amountPaid);
  const couponCode = stripePayment.couponCode || 'Discount';
  
  // Calculate extras pricing
  let extrasTotal = booking.additionalTeamMembers * addPrice;
  let extrasDiscount = 0;
  
  // If percentage discount, apply to extras too
  if (stripePayment.discountType === 'percent' && stripePayment.percentOff) {
    extrasDiscount = extrasTotal * (stripePayment.percentOff / 100);
    extrasDiscount = Math.round(extrasDiscount * 100) / 100; // Round to cents
  }
  
  // Build ALL line items for the invoice
  const invoiceLines = [];
  
  // Line 1: Building Strong Teams (at subtotal/pre-discount price)
  invoiceLines.push({
    Amount: subtotal,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: String(process.env.QB_ITEM_BST) },
      Qty: 1,
      UnitPrice: subtotal
    },
    Description: 'Building Strong Teams'
  });
  
  // Line 2: Additional Team Members
  if (booking.additionalTeamMembers > 0) {
    invoiceLines.push({
      Amount: extrasTotal,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: String(process.env.QB_ITEM_ADD) },
        Qty: booking.additionalTeamMembers,
        UnitPrice: addPrice
      },
      Description: `Additional Team Members (${booking.additionalTeamMembers})`
    });
  }
  
  // Line 3: Discount on base (from Stripe)
  if (discountAmount > 0) {
    invoiceLines.push({
      Amount: -discountAmount,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: String(process.env.QB_ITEM_DISCOUNT) },
        Qty: 1,
        UnitPrice: -discountAmount
      },
      Description: `Discount (${couponCode})`
    });
  }
  
  // Line 4: Discount on extras (if percentage discount)
  if (extrasDiscount > 0) {
    invoiceLines.push({
      Amount: -extrasDiscount,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: String(process.env.QB_ITEM_DISCOUNT) },
        Qty: 1,
        UnitPrice: -extrasDiscount
      },
      Description: `Discount on extras (${stripePayment.percentOff}% off)`
    });
  }
  
  // Calculate expected total
  const expectedTotal = subtotal + extrasTotal - discountAmount - extrasDiscount;
  const balanceDue = expectedTotal - amountPaid;
  
  console.log(`   📊 Invoice breakdown:`);
  console.log(`      Base: $${subtotal.toFixed(2)}`);
  console.log(`      Extras: $${extrasTotal.toFixed(2)} (${booking.additionalTeamMembers} members)`);
  console.log(`      Discount: -$${(discountAmount + extrasDiscount).toFixed(2)}`);
  console.log(`      Invoice Total: $${expectedTotal.toFixed(2)}`);
  console.log(`      Stripe Payment: -$${amountPaid.toFixed(2)}`);
  console.log(`      Balance Due: $${balanceDue.toFixed(2)}`);
  
  // Calculate due date (NET 30)
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);
  
  // Create the invoice
  const invoiceData = {
    CustomerRef: { value: String(customer.Id) },
    BillEmail: { Address: booking.email },
    Line: invoiceLines,
    DueDate: dueDate.toISOString().split('T')[0],
    PrivateNote: `YCBM Booking: ${booking.bookingRef} | Stripe payment: $${amountPaid.toFixed(2)}`
  };
  
  const invoice = await createInvoice(qb, invoiceData);
  console.log(`   ✓ Invoice created: #${invoice.DocNumber} (Total: $${invoice.TotalAmt})`);
  
  // Apply the Stripe payment against the invoice
  const paymentData = {
    CustomerRef: { value: String(customer.Id) },
    TotalAmt: amountPaid,
    Line: [{
      Amount: amountPaid,
      LinkedTxn: [{
        TxnId: String(invoice.Id),
        TxnType: 'Invoice'
      }]
    }],
    PrivateNote: `Stripe payment for YCBM booking: ${booking.bookingRef}`
  };
  
  const payment = await createPayment(qb, paymentData);
  console.log(`   ✓ Payment applied: $${amountPaid.toFixed(2)} (Payment ID: ${payment.Id})`);
  
  // Send invoice showing balance due
  let invoiceSent = false;
  if (balanceDue > 0) {
    try {
      const sendResult = await sendInvoice(qb, invoice.Id, booking.email);
      if (sendResult) {
        invoiceSent = true;
        console.log(`   ✓ Invoice sent to ${booking.email} (Balance: $${balanceDue.toFixed(2)})`);
      }
    } catch (e) {
      console.log(`   ⚠️ Could not send invoice: ${e.message}`);
    }
  }
  
  return {
    type: 'Invoice+Payment',
    docNumber: invoice.DocNumber,
    invoiceId: invoice.Id,
    invoiceTotal: invoice.TotalAmt,
    paymentId: payment.Id,
    paymentAmount: amountPaid,
    balanceDue: balanceDue,
    invoiceSent
  };
}
