/**
 * QuickBooks API Client
 * 
 * @version 2.3.0
 * @description QuickBooks Online API integration with OAuth 2.0 and automatic token management
 * @lastUpdated 2026-01-21
 * 
 * CHANGELOG v2.3.0:
 * - Fixed createInvoice to fetch item prices from QB and calculate Line.Amount
 * - QB requires Line.Amount - it will NOT calculate it automatically
 * - Prices are fetched dynamically from QB Items (not hardcoded)
 * 
 * CHANGELOG v2.2.0:
 * - Fixed createInvoice to properly transform friendly format to QB API format
 * - Removed Amount: null which caused "failed to parse json object" error
 * 
 * CHANGELOG v2.1.0:
 * - Fixed sendInvoice to use direct API call instead of node-quickbooks library method
 * - Added sendTo query parameter for explicit email targeting
 * - Better error handling for invoice sending
 * 
 * CHANGELOG v2.0.0:
 * - Added Vercel KV storage for refresh tokens (auto-updates, no manual intervention)
 * - Refresh token is now automatically persisted after each OAuth refresh
 * - Falls back to environment variable if KV is unavailable
 * 
 * CHANGELOG v1.2.0:
 * - Added getItemPrice() function to fetch current QB item prices
 * - Added getItem() function for item lookup
 * 
 * CHANGELOG v1.1.0:
 * - Explicit string conversion for Item IDs
 * - Better error handling
 */

import QuickBooks from 'node-quickbooks';
import { kv } from '@vercel/kv';

// Token cache (in-memory for serverless)
let cachedToken = null;
let tokenExpiry = null;

// KV keys
const KV_REFRESH_TOKEN_KEY = 'qb_refresh_token';

/**
 * Get QuickBooks client with fresh access token
 * Handles OAuth refresh automatically
 */
export async function getQBClient() {
  // Check if we need to refresh the token
  if (!cachedToken || !tokenExpiry || Date.now() >= tokenExpiry) {
    await refreshAccessToken();
  }

  const qb = new QuickBooks(
    process.env.QB_CLIENT_ID,
    process.env.QB_CLIENT_SECRET,
    cachedToken,
    false, // no token secret for OAuth2
    process.env.QB_REALM_ID,
    process.env.QB_ENVIRONMENT === 'sandbox', // use sandbox?
    false, // enable debug?
    null, // minor version
    '2.0', // OAuth version
    await getRefreshToken() // Get from KV or env
  );

  return qb;
}

/**
 * Get refresh token from KV store, falling back to environment variable
 */
async function getRefreshToken() {
  try {
    // Try to get from KV first
    const kvToken = await kv.get(KV_REFRESH_TOKEN_KEY);
    if (kvToken) {
      console.log('🔑 Using refresh token from KV store');
      return kvToken;
    }
  } catch (error) {
    console.log('⚠️  KV read failed, using env var:', error.message);
  }
  
  // Fall back to environment variable
  console.log('🔑 Using refresh token from environment variable');
  return process.env.QB_REFRESH_TOKEN;
}

/**
 * Save refresh token to KV store
 */
async function saveRefreshToken(token) {
  try {
    await kv.set(KV_REFRESH_TOKEN_KEY, token);
    console.log('💾 New refresh token saved to KV store');
    return true;
  } catch (error) {
    console.error('⚠️  Failed to save refresh token to KV:', error.message);
    console.error('   IMPORTANT: Manually update QB_REFRESH_TOKEN env var!');
    console.error(`   New token: ${token}`);
    return false;
  }
}

/**
 * Refresh OAuth access token
 */
async function refreshAccessToken() {
  console.log('🔄 Refreshing QuickBooks access token...');

  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
  
  const auth = Buffer.from(
    `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
  ).toString('base64');

  // Get current refresh token
  const currentRefreshToken = await getRefreshToken();

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `grant_type=refresh_token&refresh_token=${currentRefreshToken}`
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  cachedToken = data.access_token;
  // Set expiry 5 minutes before actual expiry for safety
  tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  
  console.log('✓ Access token refreshed');
  
  // IMPORTANT: Save the new refresh token if it changed
  if (data.refresh_token) {
    if (data.refresh_token !== currentRefreshToken) {
      console.log('🔄 New refresh token received - saving to KV...');
      await saveRefreshToken(data.refresh_token);
    } else {
      console.log('🔑 Refresh token unchanged');
    }
  }

  return data.access_token;
}

/**
 * Find existing customer or create new one
 * 
 * @param {QuickBooks} qb - QuickBooks client
 * @param {Object} customerData - { firstName, lastName, email, phone }
 * @returns {Object} QuickBooks Customer object
 */
export async function findOrCreateCustomer(qb, customerData) {
  const { firstName, lastName, email, phone } = customerData;
  const displayName = `${firstName} ${lastName}`.trim();

  // First, try to find by email (PrimaryEmailAddr)
  const existing = await new Promise((resolve, reject) => {
    qb.findCustomers({
      PrimaryEmailAddr: email,
      fetchAll: true
    }, (err, customers) => {
      if (err) {
        console.log('Customer search by email failed, will try fallback');
        resolve(null);
      } else {
        resolve(customers?.QueryResponse?.Customer?.[0] || null);
      }
    });
  });

  if (existing) {
    console.log(`   Found existing customer by email: ${existing.DisplayName} (ID: ${existing.Id})`);
    return existing;
  }

  // Fallback: search by DisplayName (catches existing customers that don't
  // have PrimaryEmailAddr set, but were created with the same name)
  if (displayName) {
    const byName = await new Promise((resolve) => {
      qb.findCustomers({
        DisplayName: displayName,
        fetchAll: true
      }, (err, customers) => {
        if (err) {
          console.log('Customer search by name failed');
          resolve(null);
        } else {
          resolve(customers?.QueryResponse?.Customer?.[0] || null);
        }
      });
    });

    if (byName) {
      console.log(`   Found existing customer by name: ${byName.DisplayName} (ID: ${byName.Id})`);
      return byName;
    }
  }

  // Create new customer
  console.log(`   Creating new customer: ${displayName}`);
  
  const newCustomer = {
    DisplayName: displayName,
    GivenName: firstName,
    FamilyName: lastName,
    PrimaryEmailAddr: { Address: email }
  };

  if (phone) {
    newCustomer.PrimaryPhone = { FreeFormNumber: phone };
  }

  return new Promise((resolve, reject) => {
    qb.createCustomer(newCustomer, (err, customer) => {
      if (err) {
        // Handle duplicate display name
        if (err.Fault?.Error?.[0]?.code === '6240') {
          // Try with email suffix to make unique
          newCustomer.DisplayName = `${displayName} (${email})`;
          qb.createCustomer(newCustomer, (err2, customer2) => {
            if (err2) {
              reject(new Error(`Failed to create customer: ${JSON.stringify(err2)}`));
            } else {
              resolve(customer2);
            }
          });
        } else {
          reject(new Error(`Failed to create customer: ${JSON.stringify(err)}`));
        }
      } else {
        resolve(customer);
      }
    });
  });
}

/**
 * Get a QuickBooks Item by ID
 * 
 * @param {QuickBooks} qb - QuickBooks client
 * @param {string} itemId - Item ID
 * @returns {Object} QuickBooks Item object
 */
export async function getItem(qb, itemId) {
  return new Promise((resolve, reject) => {
    qb.getItem(String(itemId), (err, item) => {
      if (err) {
        reject(new Error(`Failed to get item ${itemId}: ${JSON.stringify(err)}`));
      } else {
        resolve(item);
      }
    });
  });
}

/**
 * Get current price for a QuickBooks Item
 * Fetches the item and returns its UnitPrice
 * 
 * @param {QuickBooks} qb - QuickBooks client
 * @param {string} itemId - Item ID (e.g., "23" for Full Assessment)
 * @returns {number} Unit price of the item
 */
export async function getItemPrice(qb, itemId) {
  try {
    const item = await getItem(qb, itemId);
    
    // QuickBooks items have UnitPrice for services/products
    const price = item.UnitPrice || 0;
    
    console.log(`   Item ${itemId} (${item.Name}): $${price}`);
    
    return price;
  } catch (error) {
    console.error(`   Failed to get price for item ${itemId}:`, error.message);
    
    // Fall back to defaults if item lookup fails
    const defaults = {
      [process.env.QB_ITEM_BST]: 1750,
      [process.env.QB_ITEM_ADD]: 99,
      [process.env.QB_ITEM_FULL_ASSESSMENT]: 35,
      [process.env.QB_ITEM_INTERVIEW]: 35,
      '21': 1750,
      '22': 99,
      '23': 35,
      '24': 35
    };
    
    const fallback = defaults[String(itemId)] || 0;
    console.log(`   Using fallback price: $${fallback}`);
    
    return fallback;
  }
}

/**
 * Create a Sales Receipt (for fully paid orders)
 * 
 * @param {QuickBooks} qb - QuickBooks client
 * @param {Object} receiptData - Sales receipt data
 * @returns {Object} Created sales receipt
 */
export async function createSalesReceipt(qb, receiptData) {
  return new Promise((resolve, reject) => {
    qb.createSalesReceipt(receiptData, (err, receipt) => {
      if (err) {
        reject(new Error(`Failed to create sales receipt: ${JSON.stringify(err)}`));
      } else {
        resolve(receipt);
      }
    });
  });
}

/**
 * Create an Invoice
 * 
 * Accepts a friendly format and transforms it to QuickBooks API format.
 * Fetches item prices from QuickBooks to calculate Line.Amount (required by QB).
 * 
 * @param {QuickBooks} qb - QuickBooks client
 * @param {Object} params
 * @param {string} params.customerId - QB Customer ID
 * @param {Array} params.lineItems - Array of { itemId, quantity, description, unitPrice? }
 * @param {string} params.memo - Invoice memo/notes (goes to PrivateNote)
 * @param {string} params.dueDate - Due date in YYYY-MM-DD format
 * @param {string} [params.email] - Bill-to email address (sets BillEmail on the invoice)
 * @returns {Object} Created invoice
 */
export async function createInvoice(qb, { customerId, lineItems, memo, dueDate, email }) {
  console.log(`   Creating invoice with ${lineItems.length} line item(s)...`);
  
  // Fetch prices for all unique items from QuickBooks
  const uniqueItemIds = [...new Set(lineItems.map(item => String(item.itemId)))];
  const itemPrices = {};
  
  console.log(`   Fetching prices for ${uniqueItemIds.length} item(s) from QuickBooks...`);
  for (const itemId of uniqueItemIds) {
    itemPrices[itemId] = await getItemPrice(qb, itemId);
  }
  
  // Build line items array in QuickBooks format
  // IMPORTANT: QB REQUIRES Line.Amount - it will NOT calculate it automatically
  const lines = lineItems.map((item, index) => {
    const itemId = String(item.itemId);
    
    // Use provided unitPrice, or fall back to fetched price from QB
    const unitPrice = item.unitPrice !== undefined && item.unitPrice !== null 
      ? item.unitPrice 
      : itemPrices[itemId];
    
    const amount = item.quantity * unitPrice;
    
    const lineItem = {
      LineNum: index + 1,
      Amount: amount, // REQUIRED by QuickBooks
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: {
          value: itemId
        },
        Qty: item.quantity,
        UnitPrice: unitPrice
      }
    };

    // Include Description if provided
    if (item.description) {
      lineItem.Description = item.description;
    }

    return lineItem;
  });

  // Build invoice data in QuickBooks format
  // NOTE: Do NOT set SalesTermRef here. When SalesTermRef is present, QB
  // recomputes DueDate from the term and the supplied DueDate is ignored.
  const invoiceData = {
    CustomerRef: {
      value: String(customerId)
    },
    Line: lines,
    DueDate: dueDate,
    PrivateNote: memo
  };

  if (email) {
    invoiceData.BillEmail = { Address: email };
  }

  console.log(`   Invoice payload: ${JSON.stringify(invoiceData, null, 2)}`);

  return new Promise((resolve, reject) => {
    qb.createInvoice(invoiceData, (err, invoice) => {
      if (err) {
        reject(new Error(`Failed to create invoice: ${JSON.stringify(err)}`));
      } else {
        resolve(invoice);
      }
    });
  });
}

/**
 * Create an Invoice with raw QuickBooks format (for advanced use cases)
 * 
 * @param {QuickBooks} qb - QuickBooks client
 * @param {Object} invoiceData - Raw QuickBooks invoice data
 * @returns {Object} Created invoice
 */
export async function createInvoiceRaw(qb, invoiceData) {
  return new Promise((resolve, reject) => {
    qb.createInvoice(invoiceData, (err, invoice) => {
      if (err) {
        reject(new Error(`Failed to create invoice: ${JSON.stringify(err)}`));
      } else {
        resolve(invoice);
      }
    });
  });
}

/**
 * Create a Payment (to apply against an invoice)
 * 
 * @param {QuickBooks} qb - QuickBooks client
 * @param {Object} paymentData - Payment data
 * @returns {Object} Created payment
 */
export async function createPayment(qb, paymentData) {
  return new Promise((resolve, reject) => {
    qb.createPayment(paymentData, (err, payment) => {
      if (err) {
        reject(new Error(`Failed to create payment: ${JSON.stringify(err)}`));
      } else {
        resolve(payment);
      }
    });
  });
}

/**
 * Send an Invoice via email using DIRECT API call
 * Uses the QuickBooks REST API directly instead of node-quickbooks library
 * 
 * @param {QuickBooks} qb - QuickBooks client (used for token, not for the actual call)
 * @param {string} invoiceId - Invoice ID to send
 * @param {string} email - Email address to send the invoice to
 * @returns {Object|null} Result or null if failed
 */
export async function sendInvoice(qb, invoiceId, email) {
  console.log(`   Attempting to send invoice ${invoiceId} to ${email}...`);
  
  // Ensure we have a fresh token
  if (!cachedToken || !tokenExpiry || Date.now() >= tokenExpiry) {
    await refreshAccessToken();
  }
  
  // Determine base URL based on environment
  const baseUrl = process.env.QB_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
  
  const realmId = process.env.QB_REALM_ID;
  
  // Build the API URL with sendTo parameter
  const url = `${baseUrl}/v3/company/${realmId}/invoice/${invoiceId}/send?sendTo=${encodeURIComponent(email)}`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cachedToken}`,
        'Content-Type': 'application/octet-stream',
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`   ⚠️  Invoice send API error (${response.status}): ${errorText}`);
      
      // Try to parse error for more details
      try {
        const errorJson = JSON.parse(errorText);
        const errorMessage = errorJson?.Fault?.Error?.[0]?.Message || 'Unknown error';
        const errorDetail = errorJson?.Fault?.Error?.[0]?.Detail || '';
        console.log(`   Error Message: ${errorMessage}`);
        console.log(`   Error Detail: ${errorDetail}`);
      } catch (e) {
        // Not JSON, already logged the raw text
      }
      
      return null;
    }
    
    const result = await response.json();
    console.log(`   ✅ Invoice sent successfully to ${email}`);
    return result.Invoice || result;
    
  } catch (error) {
    console.log(`   ⚠️  Invoice send failed (non-fatal): ${error.message}`);
    return null;
  }
}

/**
 * Test QuickBooks connection
 * 
 * @returns {boolean} True if connection successful
 */
export async function testConnection() {
  try {
    const qb = await getQBClient();
    
    // Try to get company info
    return new Promise((resolve, reject) => {
      qb.getCompanyInfo(process.env.QB_REALM_ID, (err, companyInfo) => {
        if (err) {
          console.error('QB connection test failed:', err);
          resolve(false);
        } else {
          console.log('✓ Connected to QuickBooks');
          console.log(`  Company: ${companyInfo.CompanyName}`);
          resolve(true);
        }
      });
    });
  } catch (error) {
    console.error('QB connection error:', error.message);
    return false;
  }
}

/**
 * Initialize KV with current refresh token from env var
 * Call this once to seed the KV store with your current token
 * 
 * @returns {boolean} True if successful
 */
export async function initializeKVToken() {
  const envToken = process.env.QB_REFRESH_TOKEN;
  if (!envToken) {
    console.error('No QB_REFRESH_TOKEN in environment');
    return false;
  }
  
  try {
    await kv.set(KV_REFRESH_TOKEN_KEY, envToken);
    console.log('✓ KV store initialized with refresh token from env var');
    return true;
  } catch (error) {
    console.error('Failed to initialize KV:', error.message);
    return false;
  }
}
