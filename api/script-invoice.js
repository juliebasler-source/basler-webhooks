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
 * 3. Apps Script calls THIS endpoint with leader data
 * 4. This endpoint creates QB Invoice (NET 7) using Item 26
 * 5. Invoice is auto-sent to leader's email
 * 
 * INVOICE: Single line item — QB Item 26 (Interview Link)
 * Price is fetched dynamically from QuickBooks.
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

// QuickBooks Item ID for Interview Guide (from Vercel env var, fallback to 26)
const QB_ITEM_INTERVIEW_GUIDE = process.env.QB_ITEM_INTERVIEW_GUIDE || '26';

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

    console.log(`\n👤 Leader: ${fullName}`);
    console.log(`📧 Email: ${email}`);
    if (phone) console.log(`📱 Phone: ${phone}`);
    if (companyName) console.log(`🏢 Company: ${companyName}`);
    if (source) console.log(`📋 Source: ${source}`);

    // ========================================
    // QUICKBOOKS PROCESSING
    // ========================================
    
    // Get QuickBooks client
    console.log('\n🔄 Connecting to QuickBooks...');
    const qb = await getQBClient();

    // Fetch current price for Item 26 from QuickBooks
    console.log('💰 Fetching QB Price for Interview Link (Item ' + QB_ITEM_INTERVIEW_GUIDE + ')...');
    const itemPrice = await getItemPrice(qb, QB_ITEM_INTERVIEW_GUIDE);
    console.log(`   Item ${QB_ITEM_INTERVIEW_GUIDE}: $${itemPrice}`);

    // Find or create customer
    const customer = await findOrCreateCustomer(qb, {
      firstName,
      lastName,
      email,
      phone: phone || ''
    });
    console.log(`\n✓ QB Customer: ${customer.DisplayName} (ID: ${customer.Id})`);

    // ========================================
    // BUILD INVOICE (Single line item - Item 26)
    // ========================================
    console.log('\n📋 Creating Invoice...');
    
    const lines = [
      {
        Amount: itemPrice,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: QB_ITEM_INTERVIEW_GUIDE },
          Qty: 1,
          UnitPrice: itemPrice
        }
      }
    ];

    // Calculate due date
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + NET_TERMS_DAYS);

    console.log(`   📊 Invoice breakdown:`);
    console.log(`      Item ${QB_ITEM_INTERVIEW_GUIDE}: $${itemPrice.toFixed(2)}`);
    console.log(`      Total: $${itemPrice.toFixed(2)}`);
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
