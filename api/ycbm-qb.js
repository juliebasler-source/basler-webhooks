/**
 * YCBM to QuickBooks Webhook Handler
 * 
 * @version 2.0.0
 * @description Process YouCanBookMe bookings and create appropriate QuickBooks records
 * @lastUpdated 2025-01-02
 * 
 * FLOWS:
 * 1. Paylater (no Stripe payment) → Invoice full amount, SEND
 * 2. Paid, no extras, no discount → Sales Receipt
 * 3. Paid, no extras, with discount → Sales Receipt + discount line
 * 4. Paid with extras → Invoice + Payment applied, SEND for balance
 * 
 * CHANGELOG v2.0.0:
 * - Complete rewrite for discount support
 * - Email-only Stripe matching (no amount tolerance)
 * - Percentage discounts apply to extras
 * - Fixed discounts apply to base only
 * - Partial payment handling (Invoice + Payment)
 * - Booking ref added to memos
 * - Invoice auto-send for balances due
 */

const { findPaymentByEmail, centsToDollars } = require('../lib/stripe-lookup');
const { 
  getQuickBooksClient, 
  findOrCreateCustomer, 
  getItemPrice,
  sendInvoice 
} = require('../lib/quickbooks');
const { parseYCBMPayload } = require('../lib/parse-ycbm');

module.exports = async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('============================================================');
  console.log('YCBM WEBHOOK RECEIVED');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('============================================================');

  try {
    // Parse YCBM payload
    const booking = parseYCBMPayload(req.body);
    
    console.log('📋 BOOKING DATA:');
    console.log(`   Customer: ${booking.firstName} ${booking.lastName}`);
    console.log(`   Email: ${booking.email}`);
    console.log(`   Phone: ${booking.phone || 'N/A'}`);
    console.log(`   Additional Team Members: ${booking.additionalTeamMembers}`);
    console.log(`   Booking Ref: ${booking.bookingRef}`);
    console.log(`   Appointment: ${booking.appointmentType}`);

    // Get QuickBooks client
    const qb = await getQuickBooksClient();

    // Fetch QB prices for products
    console.log('💰 FETCHING QB PRICES...');
    const bstPrice = await getItemPrice(qb, process.env.QB_ITEM_BST);
    const addPrice = await getItemPrice(qb, process.env.QB_ITEM_ADD);
    console.log(`   Building Strong Teams: $${bstPrice}`);
    console.log(`   Additional Team Member: $${addPrice}`);

    // Search Stripe for payment
    console.log('🔍 CHECKING STRIPE FOR PAYMENT...');
    const stripePayment = await findPaymentByEmail(booking.email, 30);

    // Find or create QB customer
    console.log('👤 FINDING/CREATING QB CUSTOMER...');
    const customer = await findOrCreateCustomer(qb, {
      name: `${booking.firstName} ${booking.lastName}`,
      email: booking.email
    });
    console.log(`   Customer ID: ${customer.Id}`);
    console.log(`   Customer Name: ${customer.DisplayName}`);

    // Determine which flow to use
    let result;
    
    if (!stripePayment.found) {
      // FLOW 1: PAYLATER
      console.log('📝 FLOW: PAYLATER (No Stripe payment found)');
      result = await handlePaylater(qb, customer, booking, bstPrice, addPrice);
    } else if (booking.additionalTeamMembers > 0) {
      // FLOW 4: PAID WITH EXTRAS (partial payment)
      console.log('📝 FLOW: PARTIAL PAYMENT (Paid with extras)');
      result = await handlePartialPayment(qb, customer, booking, stripePayment, bstPrice, addPrice);
    } else if (stripePayment.discountAmount > 0) {
      // FLOW 3: PAID WITH DISCOUNT (no extras)
      console.log('📝 FLOW: PAID WITH DISCOUNT');
      result = await handlePaidWithDiscount(qb, customer, booking, stripePayment, bstPrice);
    } else {
      // FLOW 2: SIMPLE PAID (no extras, no discount)
      console.log('📝 FLOW: SIMPLE PAID');
      result = await handleSimplePaid(qb, customer, booking, stripePayment, bstPrice);
    }

    console.log('============================================================');
    console.log('✅ YCBM WEBHOOK PROCESSED SUCCESSFULLY');
    console.log('============================================================');

    return res.status(200).json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('❌ WEBHOOK ERROR:', error.message);
    console.error('Stack:', error.stack);
    
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * FLOW 1: Paylater - No Stripe payment, invoice full amount
 */
async function handlePaylater(qb, customer, booking, bstPrice, addPrice) {
  const extras = booking.additionalTeamMembers;
  const extrasTotal = extras * addPrice;
  const totalDue = bstPrice + extrasTotal;
  
  console.log(`   Creating Invoice for full amount...`);
  console.log(`   Base: $${bstPrice}`);
  console.log(`   Extras: ${extras} × $${addPrice} = $${extrasTotal}`);
  console.log(`   Total: $${totalDue}`);
  
  // Build line items
  const lineItems = [
    {
      Amount: bstPrice,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: process.env.QB_ITEM_BST },
        Qty: 1,
        UnitPrice: bstPrice
      },
      Description: 'Building Strong Teams'
    }
  ];
  
  // Add extras if any
  if (extras > 0) {
    lineItems.push({
      Amount: extrasTotal,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: process.env.QB_ITEM_ADD },
        Qty: extras,
        UnitPrice: addPrice
      },
      Description: `Additional Team Members (${extras})`
    });
  }
  
  // Calculate due date (NET 30)
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);
  
  // Create invoice
  const invoiceData = {
    CustomerRef: { value: customer.Id },
    Line: lineItems,
    DueDate: dueDate.toISOString().split('T')[0],
    PrivateNote: `YCBM Booking: ${booking.bookingRef || 'N/A'}`,
    CustomerMemo: { value: `Booking ref: ${booking.bookingRef || 'N/A'} - Thank you for your booking!` }
  };
  
  const invoice = await createInvoice(qb, invoiceData);
  console.log(`   ✅ Invoice created: #${invoice.DocNumber || invoice.Id}`);
  console.log(`   Amount: $${totalDue}`);
  console.log(`   Due Date: ${dueDate.toISOString().split('T')[0]}`);
  
  // Send invoice
  console.log('📧 SENDING INVOICE...');
  await sendInvoiceToCustomer(qb, invoice.Id, booking.email);
  
  return {
    flow: 'paylater',
    recordType: 'Invoice',
    recordId: invoice.Id,
    docNumber: invoice.DocNumber,
    amount: totalDue,
    sent: true
  };
}

/**
 * FLOW 2: Simple Paid - No extras, no discount
 */
async function handleSimplePaid(qb, customer, booking, stripePayment, bstPrice) {
  const amountPaid = centsToDollars(stripePayment.amountPaid);
  
  console.log(`   Creating Sales Receipt...`);
  console.log(`   Amount: $${amountPaid}`);
  
  const lineItems = [
    {
      Amount: amountPaid,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: process.env.QB_ITEM_BST },
        Qty: 1,
        UnitPrice: amountPaid
      },
      Description: 'Building Strong Teams'
    }
  ];
  
  const receiptData = {
    CustomerRef: { value: customer.Id },
    Line: lineItems,
    PrivateNote: buildPrivateNote(booking, stripePayment),
    CustomerMemo: { value: buildCustomerMemo(booking, stripePayment) }
  };
  
  // Add deposit account if configured
  if (process.env.QB_DEPOSIT_ACCOUNT) {
    receiptData.DepositToAccountRef = { value: process.env.QB_DEPOSIT_ACCOUNT };
  }
  
  const receipt = await createSalesReceipt(qb, receiptData);
  console.log(`   ✅ Sales Receipt created: #${receipt.DocNumber || receipt.Id}`);
  console.log(`   Total: $${amountPaid}`);
  
  return {
    flow: 'simple_paid',
    recordType: 'SalesReceipt',
    recordId: receipt.Id,
    docNumber: receipt.DocNumber,
    amount: amountPaid
  };
}

/**
 * FLOW 3: Paid with Discount - No extras, has discount
 */
async function handlePaidWithDiscount(qb, customer, booking, stripePayment, bstPrice) {
  const subtotal = centsToDollars(stripePayment.subtotal);
  const discountAmount = centsToDollars(stripePayment.discountAmount);
  const amountPaid = centsToDollars(stripePayment.amountPaid);
  const couponCode = stripePayment.couponCode || 'DISCOUNT';
  
  console.log(`   Creating Sales Receipt with discount...`);
  console.log(`   Subtotal: $${subtotal}`);
  console.log(`   Discount (${couponCode}): -$${discountAmount}`);
  console.log(`   Total: $${amountPaid}`);
  
  const lineItems = [
    {
      Amount: subtotal,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: process.env.QB_ITEM_BST },
        Qty: 1,
        UnitPrice: subtotal
      },
      Description: 'Building Strong Teams'
    }
  ];
  
  // Add discount line item
  if (discountAmount > 0 && process.env.QB_ITEM_DISCOUNT) {
    lineItems.push({
      Amount: -discountAmount,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: process.env.QB_ITEM_DISCOUNT },
        Qty: 1,
        UnitPrice: -discountAmount
      },
      Description: `Discount (${couponCode.toUpperCase()})`
    });
  } else if (discountAmount > 0) {
    console.log(`   ⚠ QB_ITEM_DISCOUNT not configured, discount not shown as line item`);
  }
  
  const receiptData = {
    CustomerRef: { value: customer.Id },
    Line: lineItems,
    PrivateNote: buildPrivateNote(booking, stripePayment),
    CustomerMemo: { value: buildCustomerMemo(booking, stripePayment) }
  };
  
  if (process.env.QB_DEPOSIT_ACCOUNT) {
    receiptData.DepositToAccountRef = { value: process.env.QB_DEPOSIT_ACCOUNT };
  }
  
  const receipt = await createSalesReceipt(qb, receiptData);
  console.log(`   ✅ Sales Receipt created: #${receipt.DocNumber || receipt.Id}`);
  console.log(`   Total: $${amountPaid}`);
  
  return {
    flow: 'paid_with_discount',
    recordType: 'SalesReceipt',
    recordId: receipt.Id,
    docNumber: receipt.DocNumber,
    amount: amountPaid,
    discount: discountAmount,
    couponCode: couponCode
  };
}

/**
 * FLOW 4: Partial Payment - Paid base, extras owed (and possibly discount)
 */
async function handlePartialPayment(qb, customer, booking, stripePayment, bstPrice, addPrice) {
  const extras = booking.additionalTeamMembers;
  const subtotal = centsToDollars(stripePayment.subtotal);
  const discountAmount = centsToDollars(stripePayment.discountAmount);
  const amountPaid = centsToDollars(stripePayment.amountPaid);
  const couponCode = stripePayment.couponCode || 'DISCOUNT';
  
  // Calculate extras price (apply % discount if applicable)
  let extrasPrice = addPrice;
  let extrasDiscountAmount = 0;
  
  if (stripePayment.discountType === 'percent' && stripePayment.percentOff) {
    const discountPercent = stripePayment.percentOff / 100;
    extrasDiscountAmount = extras * addPrice * discountPercent;
    console.log(`   Applying ${stripePayment.percentOff}% discount to extras`);
  }
  
  const extrasTotal = (extras * addPrice) - extrasDiscountAmount;
  const totalDue = subtotal + (extras * addPrice);  // Before any discounts
  const totalAfterDiscount = amountPaid + extrasTotal;  // What they owe after discount
  const balanceDue = extrasTotal;  // Extras weren't collected by Stripe
  
  console.log(`   Creating Invoice + Payment...`);
  console.log(`   Base (Stripe subtotal): $${subtotal}`);
  if (discountAmount > 0) console.log(`   Base discount (${couponCode}): -$${discountAmount}`);
  console.log(`   Base paid: $${amountPaid}`);
  console.log(`   Extras: ${extras} × $${addPrice} = $${extras * addPrice}`);
  if (extrasDiscountAmount > 0) console.log(`   Extras discount: -$${extrasDiscountAmount.toFixed(2)}`);
  console.log(`   Extras due: $${extrasTotal.toFixed(2)}`);
  console.log(`   Balance due: $${balanceDue.toFixed(2)}`);
  
  // Build line items for invoice (show full breakdown)
  const lineItems = [
    {
      Amount: subtotal,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: process.env.QB_ITEM_BST },
        Qty: 1,
        UnitPrice: subtotal
      },
      Description: 'Building Strong Teams'
    }
  ];
  
  // Add base discount if any
  if (discountAmount > 0 && process.env.QB_ITEM_DISCOUNT) {
    lineItems.push({
      Amount: -discountAmount,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: process.env.QB_ITEM_DISCOUNT },
        Qty: 1,
        UnitPrice: -discountAmount
      },
      Description: `Discount (${couponCode.toUpperCase()})`
    });
  }
  
  // Add extras
  lineItems.push({
    Amount: extras * addPrice,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: process.env.QB_ITEM_ADD },
      Qty: extras,
      UnitPrice: addPrice
    },
    Description: `Additional Team Members (${extras})`
  });
  
  // Add extras discount if percentage discount applies
  if (extrasDiscountAmount > 0 && process.env.QB_ITEM_DISCOUNT) {
    lineItems.push({
      Amount: -extrasDiscountAmount,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: process.env.QB_ITEM_DISCOUNT },
        Qty: 1,
        UnitPrice: -extrasDiscountAmount
      },
      Description: `Discount on extras (${couponCode.toUpperCase()} ${stripePayment.percentOff}%)`
    });
  }
  
  // Calculate due date (NET 30)
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);
  
  // Create invoice
  const invoiceData = {
    CustomerRef: { value: customer.Id },
    Line: lineItems,
    DueDate: dueDate.toISOString().split('T')[0],
    PrivateNote: buildPrivateNote(booking, stripePayment),
    CustomerMemo: { 
      value: `Booking ref: ${booking.bookingRef || 'N/A'} - Thank you for your booking! This invoice reflects the balance due for additional team members.` 
    }
  };
  
  const invoice = await createInvoice(qb, invoiceData);
  console.log(`   ✅ Invoice created: #${invoice.DocNumber || invoice.Id}`);
  
  // Apply payment for the amount already collected by Stripe
  console.log(`   💳 Applying payment of $${amountPaid}...`);
  const payment = await createPayment(qb, {
    CustomerRef: { value: customer.Id },
    TotalAmt: amountPaid,
    Line: [{
      Amount: amountPaid,
      LinkedTxn: [{
        TxnId: invoice.Id,
        TxnType: 'Invoice'
      }]
    }],
    PrivateNote: `Stripe payment - ${stripePayment.sessionId || stripePayment.chargeId || 'N/A'}`
  });
  console.log(`   ✅ Payment applied: $${amountPaid}`);
  
  // Send invoice for balance due
  if (balanceDue > 0) {
    console.log(`📧 SENDING INVOICE FOR BALANCE DUE: $${balanceDue.toFixed(2)}...`);
    await sendInvoiceToCustomer(qb, invoice.Id, booking.email);
  }
  
  return {
    flow: 'partial_payment',
    recordType: 'Invoice+Payment',
    invoiceId: invoice.Id,
    invoiceDocNumber: invoice.DocNumber,
    paymentId: payment.Id,
    totalDue: subtotal + (extras * addPrice) - discountAmount - extrasDiscountAmount,
    amountPaid: amountPaid,
    balanceDue: balanceDue,
    sent: balanceDue > 0
  };
}

/**
 * Create Sales Receipt in QuickBooks
 */
function createSalesReceipt(qb, data) {
  return new Promise((resolve, reject) => {
    qb.createSalesReceipt(data, (err, result) => {
      if (err) {
        console.error('QB createSalesReceipt error:', JSON.stringify(err, null, 2));
        reject(new Error(`Failed to create sales receipt: ${JSON.stringify(err)}`));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Create Invoice in QuickBooks
 */
function createInvoice(qb, data) {
  return new Promise((resolve, reject) => {
    qb.createInvoice(data, (err, result) => {
      if (err) {
        console.error('QB createInvoice error:', JSON.stringify(err, null, 2));
        reject(new Error(`Failed to create invoice: ${JSON.stringify(err)}`));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Create Payment in QuickBooks
 */
function createPayment(qb, data) {
  return new Promise((resolve, reject) => {
    qb.createPayment(data, (err, result) => {
      if (err) {
        console.error('QB createPayment error:', JSON.stringify(err, null, 2));
        reject(new Error(`Failed to create payment: ${JSON.stringify(err)}`));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Send invoice to customer
 */
async function sendInvoiceToCustomer(qb, invoiceId, email) {
  try {
    console.log(`   Attempting to send invoice ${invoiceId} to ${email}...`);
    await sendInvoice(qb, invoiceId, email);
    console.log(`   ✅ Invoice sent successfully to ${email}`);
    return true;
  } catch (error) {
    console.log(`   ⚠ Could not send invoice: ${error.message}`);
    console.log(`   Invoice created but needs manual sending`);
    return false;
  }
}

/**
 * Build private note (internal only)
 */
function buildPrivateNote(booking, stripePayment) {
  const parts = [`YCBM Booking: ${booking.bookingRef || 'N/A'}`];
  
  if (stripePayment?.description) {
    parts.push(stripePayment.description);
  }
  
  if (stripePayment?.sessionId) {
    parts.push(`Stripe Session: ${stripePayment.sessionId}`);
  } else if (stripePayment?.chargeId) {
    parts.push(`Stripe Charge: ${stripePayment.chargeId}`);
  }
  
  return parts.join(' | ');
}

/**
 * Build customer memo (visible on invoice/receipt)
 */
function buildCustomerMemo(booking, stripePayment) {
  if (booking.bookingRef) {
    return `Booking ref: ${booking.bookingRef} - Thank you for your booking!`;
  }
  return 'Thank you for your booking!';
}
