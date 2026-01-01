/**
 * QuickBooks API Client
 * 
 * @version 2.0.0
 * @description QuickBooks Online API integration with OAuth 2.0 and automatic token management
 * @lastUpdated 2025-01-01
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
  const displayName = `${firstName} ${lastName}`;

  // First, try to find by email
  const existing = await new Promise((resolve, reject) => {
    qb.findCustomers({
      PrimaryEmailAddr: email,
      fetchAll: true
    }, (err, customers) => {
      if (err) {
        // If query fails, we'll create new
        console.log('Customer search failed, will create new');
        resolve(null);
      } else {
        resolve(customers?.QueryResponse?.Customer?.[0] || null);
      }
    });
  });

  if (existing) {
    console.log(`   Found existing customer: ${existing.DisplayName} (ID: ${existing.Id})`);
    return existing;
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
 * @param {string} itemId - Item ID (e.g., "21" for Building Strong Teams)
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
      '21': 1750,
      '22': 99
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
 * Create an Invoice (for unpaid or partially paid orders)
 * 
 * @param {QuickBooks} qb - QuickBooks client
 * @param {Object} invoiceData - Invoice data
 * @returns {Object} Created invoice
 */
export async function createInvoice(qb, invoiceData) {
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
 * Send an Invoice via email
 * Note: This often fails with QB API errors - invoices may need manual sending
 * 
 * @param {QuickBooks} qb - QuickBooks client
 * @param {string} invoiceId - Invoice ID
 * @param {string} email - Email address to send to
 * @returns {Object|null} Result or null if failed
 */
export async function sendInvoice(qb, invoiceId, email) {
  return new Promise((resolve) => {
    qb.sendInvoicePdf(invoiceId, email, (err, result) => {
      if (err) {
        console.log(`⚠️  Invoice send failed (non-fatal): ${JSON.stringify(err)}`);
        resolve(null);
      } else {
        resolve(result);
      }
    });
  });
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
