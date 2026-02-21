/**
 * Google Apps Script → QuickBooks Invoice Creation
 * 
 * @version 1.0.0
 * @description Creates QB invoice when "Create Interview Link" is used from a Build File
 * @lastUpdated 2026-02-21
 * @location /api/script-invoice.js
 * 
 * FLOW:
 * 1. User clicks "Create Interview Link" in Build File menu
 * 2. Apps Script creates IDS assessment link (existing behavior)
 * 3. Apps Script calls THIS endpoint with leader/team data
 * 4. This endpoint creates QB Invoice (NET 7, same as YCBM paylater)
 * 5. Invoice is auto-sent to leader's email
 * 
 * SECURITY:
 * - Requires shared secret in Authorization header
 * - Only accepts POST requests
 * - Validates all required fields
 */

import { 
  getQBClient, 
  findOrCreateCustomer, 
  createInvoiceRaw,
  sendInvoice,
  getItemPrice
} from '../lib/quickbooks.js';

// ========================================
// CONFIGURATION
// ========================================

// Invoice payment terms (days until due) - matches YCBM paylater
const NET_TERMS_DAYS = 7;

// Shared secret for authenticating requests from Apps Script
// Set this in Vercel Environment Variables as SCRIPT_INVOICE_SECRET
const EXPECTED_SECRET = process.env.SCRIPT_INVOICE_SECRET;

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('═'.repeat(60));
  console.log('📝 SCRIPT INVOICE REQUEST RECEIVED');
  console.log('═'.repeat(60));

  try {
    // ========================================
    // AUTHENTICATION
    // ========================================
    if (EXPECTED_SECRET) {
      const authHeader = req.headers['authorization'] || '';
      const providedSecret = authHeader.replace('Bearer ', '');
      
      if (providedSecret !== EXPECTED_SECRET) {
        console.log('❌ Authentication failed - invalid secret');
        return res.status(401).json({ error: 'Unauthorized' });
      }
      console.log('✓ Authentication passed');
    } else {
      console.log('⚠️  No SCRIPT_INVOICE_SECRET configured - skipping auth');
    }

    // ========================================
    // PARSE & VALIDATE REQUEST
    // ========================================
    const {
      firstName,
      lastName,
      email,
      phone,
      companyName,
      additionalTeamMembers,
      source  // optional - for logging (e.g., "Build File: John Smith")
    } = req.body;

    // Validate required fields
    const missing = [];
    if (!firstName) missing.push('firstName');
    if (!lastName) missing.push('lastName');
    if (!email) missing.push('email');
    
    if (missing.length > 0) {
      console.log(`❌ Missing required fields: ${missing.join(', ')}`);
      return res.status(400).json({ 
        error: 'Missing required fields', 
        missing 
      });
    }

    const fullName = `${firstName} ${lastName}`;
    const extras = parseInt(additionalTeamMembers) || 0;

    console.log(`\n👤 Leader: ${fullName}`);
    console.log(`📧 Email: ${email}`);
    if (phone) console.log(`📱 Phone: ${phone}`);
    if (companyName) console.log(`🏢 Company: ${companyName}`);
    console.log(`👥 Additional Team Members: ${extras}`);
    if (source) console.log(`📋 Source: ${source}`);

    // ========================================
    // QUICKBOOKS PROCESSING
    // ========================================
    
    // Get QuickBooks client
    console.log('\n🔄 Connecting to QuickBooks...');
    const qb = await getQBClient();

    // Fetch current prices from QuickBooks
    console.log('💰 Fetching QB Prices...');
    const bstPrice = await getItemPrice(qb, process.env.QB_ITEM_BST || '21');
    const addPrice = await getItemPrice(qb, process.env.QB_ITEM_ADD || '22');
    console.log(`   Base (BST): $${bstPrice}`);
    console.log(`   Additional: $${addPrice}`);

    // Find or create customer
    const customer = await findOrCreateCustomer(qb, {
      firstName,
      lastName,
      email,
      phone: phone || ''
    });
    console.log(`\n✓ QB Customer: ${customer.DisplayName} (ID: ${customer.Id})`);

    // ========================================
    // BUILD INVOICE
    // ========================================
    console.log('\n📋 Creating Invoice...');
    
    const lines = [];

    // Line 1: Building Strong Teams
    lines.push({
      Amount: bstPrice,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: String(process.env.QB_ITEM_BST || '21') },
        Qty: 1,
        UnitPrice: bstPrice
      },
      Description: 'Building Strong Teams'
    });

    // Line 2: Additional Team Members (if any)
    if (extras > 0) {
      const extrasTotal = extras * addPrice;
      lines.push({
        Amount: extrasTotal,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: String(process.env.QB_ITEM_ADD || '22') },
          Qty: extras,
          UnitPrice: addPrice
        },
        Description: `Additional Team Members (${extras})`
      });
    }

    // Calculate due date
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + NET_TERMS_DAYS);

    // Calculate expected total for logging
    const expectedTotal = bstPrice + (extras * addPrice);
    console.log(`   📊 Invoice breakdown:`);
    console.log(`      Base: $${bstPrice.toFixed(2)}`);
    if (extras > 0) console.log(`      Extras: $${(extras * addPrice).toFixed(2)} (${extras} members × $${addPrice})`);
    console.log(`      Total: $${expectedTotal.toFixed(2)}`);
    console.log(`      Due: ${dueDate.toISOString().split('T')[0]} (NET ${NET_TERMS_DAYS})`);

    // Build memo/private note
    const memoparts = ['Create Interview Link'];
    if (companyName) memoparts.push(`Company: ${companyName}`);
    if (source) memoparts.push(source);
    const memo = memoparts.join(' | ');

    // Create the invoice using raw format (same as YCBM paylater)
    const invoiceData = {
      CustomerRef: { value: String(customer.Id) },
      BillEmail: { Address: email },
      Line: lines,
      DueDate: dueDate.toISOString().split('T')[0],
      PrivateNote: memo
    };

    const invoice = await createInvoiceRaw(qb, invoiceData);
    const docNum = invoice.DocNumber || `ID:${invoice.Id}`;
    console.log(`   ✓ Invoice created: #${docNum} (Total: $${invoice.TotalAmt})`);

    // ========================================
    // SEND INVOICE
    // ========================================
    let invoiceSent = false;
    try {
      const sendResult = await sendInvoice(qb, invoice.Id, email);
      if (sendResult) {
        invoiceSent = true;
        console.log(`   ✓ Invoice sent to ${email}`);
      }
    } catch (e) {
      console.log(`   ⚠️ Could not auto-send invoice: ${e.message}`);
      console.log(`   → Invoice was created successfully - send manually from QuickBooks if needed`);
    }

    // ========================================
    // SUCCESS RESPONSE
    // ========================================
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅ SUCCESS - SCRIPT INVOICE`);
    console.log(`   Leader: ${fullName}`);
    console.log(`   QB Invoice: #${docNum}`);
    console.log(`   Total: $${invoice.TotalAmt}`);
    console.log(`   Due: ${dueDate.toISOString().split('T')[0]}`);
    if (invoiceSent) console.log(`   📧 Invoice sent to ${email}`);
    console.log('═'.repeat(60));

    return res.status(200).json({
      status: 'success',
      invoice: {
        id: invoice.Id,
        docNumber: docNum,
        total: invoice.TotalAmt,
        dueDate: dueDate.toISOString().split('T')[0],
        sent: invoiceSent
      },
      customer: {
        id: customer.Id,
        name: customer.DisplayName,
        email: email
      }
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
