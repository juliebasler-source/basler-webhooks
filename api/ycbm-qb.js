/**
 * YCBM → QuickBooks Integration
 * 
 * @version 2.0.1
 * @description Handle YouCanBookMe webhooks and create QuickBooks records
 * @lastUpdated 2025-01-02
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
  getAccessToken, 
  findOrCreateCustomer, 
  getItemPrice,
  createSalesReceipt,
  createInvoice,
  createPayment,
  sendInvoice
} from '../lib/quickbooks.js';

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
    
    // Get QuickBooks access token
    const accessToken = await getAccessToken();
    const realmId = process.env.QB_REALM_ID;
    
    // Find or create customer in QuickBooks
    const customer = await findOrCreateCustomer(accessToken, realmId, {
      name: booking.fullName,
      email: booking.email
    });
    console.log(`\n✓ QB Customer: ${customer.DisplayName} (ID: ${customer.Id})`);
    
    // Get QB item prices
    const bstPrice = await getItemPrice(accessToken, realmId, process.env.QB_ITEM_BST);
    const addPrice = await getItemPrice(accessToken, realmId, process.env.QB_ITEM_ADD);
    console.log(`\n💰 QB Prices: Base=$${bstPrice}, Additional=$${addPrice}`);
    
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
        result = await handlePaylater(accessToken, realmId, customer, booking, bstPrice, addPrice);
        break;
        
      case 'SIMPLE_PAID':
        result = await handleSimplePaid(accessToken, realmId, customer, booking, stripePayment);
        break;
        
      case 'PAID_WITH_DISCOUNT':
        result = await handlePaidWithDiscount(accessToken, realmId, customer, booking, stripePayment);
        break;
        
      case 'PARTIAL_PAYMENT':
        result = await handlePartialPayment(accessToken, realmId, customer, booking, stripePayment, bstPrice, addPrice);
        break;
    }
    
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅ SUCCESS - ${flow}`);
    console.log(`   QB Record: ${result.type} #${result.docNumber}`);
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
async function handlePaylater(accessToken, realmId, customer, booking, bstPrice, addPrice) {
  console.log('\n📋 Creating PAYLATER Invoice (full amount)...');
  
  const lines = [];
  
  // Line 1: Building Strong Teams
  lines.push({
    Amount: bstPrice,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: process.env.QB_ITEM_BST },
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
        ItemRef: { value: process.env.QB_ITEM_ADD },
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
    CustomerRef: { value: customer.Id },
    Line: lines,
    DueDate: dueDate.toISOString().split('T')[0],
    CustomerMemo: { value: `Booking ref: ${booking.bookingRef} - Thank you for your booking!` },
    PrivateNote: `YCBM Booking: ${booking.bookingRef}`
  };
  
  const invoice = await createInvoice(accessToken, realmId, invoiceData);
  console.log(`   ✓ Invoice created: #${invoice.DocNumber}`);
  
  // Send the invoice
  let invoiceSent = false;
  try {
    await sendInvoice(accessToken, realmId, invoice.Id, booking.email);
    invoiceSent = true;
    console.log(`   ✓ Invoice sent to ${booking.email}`);
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
async function handleSimplePaid(accessToken, realmId, customer, booking, stripePayment) {
  console.log('\n🧾 Creating Sales Receipt (simple paid)...');
  
  const amountPaid = centsToDollars(stripePayment.amountPaid);
  
  const lines = [{
    Amount: amountPaid,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: process.env.QB_ITEM_BST },
      Qty: 1,
      UnitPrice: amountPaid
    },
    Description: 'Building Strong Teams'
  }];
  
  const receiptData = {
    CustomerRef: { value: customer.Id },
    Line: lines,
    PrivateNote: `YCBM Booking: ${booking.bookingRef}`,
    DepositToAccountRef: { value: process.env.QB_DEPOSIT_ACCOUNT }
  };
  
  const receipt = await createSalesReceipt(accessToken, realmId, receiptData);
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
async function handlePaidWithDiscount(accessToken, realmId, customer, booking, stripePayment) {
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
        ItemRef: { value: process.env.QB_ITEM_BST },
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
        ItemRef: { value: process.env.QB_ITEM_DISCOUNT },
        Qty: 1,
        UnitPrice: -discountAmount
      },
      Description: `Discount (${couponCode})`
    }
  ];
  
  const receiptData = {
    CustomerRef: { value: customer.Id },
    Line: lines,
    PrivateNote: `YCBM Booking: ${booking.bookingRef} | Coupon: ${couponCode}`,
    DepositToAccountRef: { value: process.env.QB_DEPOSIT_ACCOUNT }
  };
  
  const receipt = await createSalesReceipt(accessToken, realmId, receiptData);
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
 * Create Invoice with all lines, apply Payment for Stripe amount
 */
async function handlePartialPayment(accessToken, realmId, customer, booking, stripePayment, bstPrice, addPrice) {
  console.log('\n📋 Creating Invoice with Payment (partial)...');
  
  const lines = [];
  
  // Use Stripe subtotal as base price (what they saw at checkout)
  const basePrice = centsToDollars(stripePayment.subtotal);
  const discountAmount = centsToDollars(stripePayment.discountAmount);
  const amountPaid = centsToDollars(stripePayment.amountPaid);
  const couponCode = stripePayment.couponCode || 'Discount';
  
  // Line 1: Building Strong Teams
  lines.push({
    Amount: basePrice,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: process.env.QB_ITEM_BST },
      Qty: 1,
      UnitPrice: basePrice
    },
    Description: 'Building Strong Teams'
  });
  
  // Line 2: Discount on base (if any)
  if (discountAmount > 0) {
    lines.push({
      Amount: -discountAmount,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: process.env.QB_ITEM_DISCOUNT },
        Qty: 1,
        UnitPrice: -discountAmount
      },
      Description: `Discount (${couponCode})`
    });
  }
  
  // Calculate extras pricing
  let extrasTotal = booking.additionalTeamMembers * addPrice;
  let extrasDiscount = 0;
  
  // If percentage discount, apply to extras too
  if (stripePayment.discountType === 'percent' && stripePayment.percentOff) {
    extrasDiscount = extrasTotal * (stripePayment.percentOff / 100);
    extrasDiscount = Math.round(extrasDiscount * 100) / 100; // Round to cents
  }
  
  // Line 3: Additional Team Members
  if (booking.additionalTeamMembers > 0) {
    lines.push({
      Amount: extrasTotal,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: process.env.QB_ITEM_ADD },
        Qty: booking.additionalTeamMembers,
        UnitPrice: addPrice
      },
      Description: `Additional Team Members (${booking.additionalTeamMembers})`
    });
    
    // Line 4: Discount on extras (if percentage discount)
    if (extrasDiscount > 0) {
      lines.push({
        Amount: -extrasDiscount,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: process.env.QB_ITEM_DISCOUNT },
          Qty: 1,
          UnitPrice: -extrasDiscount
        },
        Description: `Discount on extras (${stripePayment.percentOff}% off)`
      });
    }
  }
  
  // Calculate due date (NET 30)
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);
  
  const invoiceData = {
    CustomerRef: { value: customer.Id },
    Line: lines,
    DueDate: dueDate.toISOString().split('T')[0],
    CustomerMemo: { value: 'Thank you for your booking! This invoice reflects the balance due for additional team members.' },
    PrivateNote: `YCBM Booking: ${booking.bookingRef} | Stripe payment: $${amountPaid.toFixed(2)}`
  };
  
  const invoice = await createInvoice(accessToken, realmId, invoiceData);
  console.log(`   ✓ Invoice created: #${invoice.DocNumber} (Total: $${invoice.TotalAmt})`);
  
  // Apply payment for the Stripe amount
  const paymentData = {
    CustomerRef: { value: customer.Id },
    TotalAmt: amountPaid,
    Line: [{
      Amount: amountPaid,
      LinkedTxn: [{
        TxnId: invoice.Id,
        TxnType: 'Invoice'
      }]
    }],
    PrivateNote: `Stripe payment for YCBM booking: ${booking.bookingRef}`
  };
  
  const payment = await createPayment(accessToken, realmId, paymentData);
  console.log(`   ✓ Payment applied: $${amountPaid.toFixed(2)}`);
  
  const balanceDue = invoice.TotalAmt - amountPaid;
  console.log(`   📊 Balance due: $${balanceDue.toFixed(2)}`);
  
  // Send invoice for balance due
  let invoiceSent = false;
  if (balanceDue > 0) {
    try {
      await sendInvoice(accessToken, realmId, invoice.Id, booking.email);
      invoiceSent = true;
      console.log(`   ✓ Invoice sent to ${booking.email}`);
    } catch (e) {
      console.log(`   ⚠️ Could not send invoice: ${e.message}`);
    }
  }
  
  return {
    type: 'Invoice+Payment',
    docNumber: invoice.DocNumber,
    invoiceId: invoice.Id,
    invoiceTotal: invoice.TotalAmt,
    paymentAmount: amountPaid,
    balanceDue: balanceDue,
    invoiceSent
  };
}
