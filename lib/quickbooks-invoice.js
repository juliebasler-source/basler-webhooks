/**
 * QuickBooks Invoice Helpers
 * 
 * Add these functions to your existing lib/quickbooks.js file
 * (or merge into your existing QuickBooks library)
 */

/**
 * Create a QuickBooks Invoice
 * 
 * @param {Object} qb - QuickBooks client
 * @param {Object} params
 * @param {string} params.customerId - QB Customer ID
 * @param {Array} params.lineItems - Array of { itemId, quantity, description }
 * @param {string} params.memo - Invoice memo/notes
 * @param {string} params.dueDate - Due date in YYYY-MM-DD format
 * @returns {Promise<Object>} Created invoice
 */
export async function createInvoice(qb, { customerId, lineItems, memo, dueDate }) {
  // Build line items array
  const lines = lineItems.map((item, index) => ({
    LineNum: index + 1,
    Amount: null, // Will be calculated by QB based on item price * qty
    DetailType: 'SalesItemLineDetail',
    Description: item.description,
    SalesItemLineDetail: {
      ItemRef: {
        value: item.itemId
      },
      Qty: item.quantity
    }
  }));

  const invoiceData = {
    CustomerRef: {
      value: customerId
    },
    Line: lines,
    DueDate: dueDate,
    PrivateNote: memo,
    // NET 30 terms
    SalesTermRef: {
      value: '3' // Typically '3' is Net 30, but verify in your QB
    }
  };

  console.log(`   Creating invoice with ${lineItems.length} line item(s)...`);
  
  const response = await qb.createInvoice(invoiceData);
  
  return response.Invoice;
}

/**
 * Get item price from QuickBooks
 * 
 * @param {Object} qb - QuickBooks client
 * @param {string} itemId - Item ID
 * @returns {Promise<number>} Unit price
 */
export async function getItemPrice(qb, itemId) {
  const item = await qb.getItem(itemId);
  return item?.Item?.UnitPrice || 0;
}

/**
 * Get multiple item prices
 * 
 * @param {Object} qb - QuickBooks client
 * @param {Array<string>} itemIds - Array of item IDs
 * @returns {Promise<Object>} Map of itemId -> price
 */
export async function getItemPrices(qb, itemIds) {
  const prices = {};
  
  for (const itemId of itemIds) {
    try {
      prices[itemId] = await getItemPrice(qb, itemId);
    } catch (e) {
      console.error(`   Failed to get price for item ${itemId}:`, e.message);
      prices[itemId] = 0;
    }
  }
  
  return prices;
}
