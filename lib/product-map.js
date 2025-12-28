/**
 * Product Mapping Configuration
 * 
 * Maps WooCommerce products to QuickBooks items.
 * 
 * SETUP INSTRUCTIONS:
 * 1. Create products in QuickBooks Online
 * 2. Get the Item IDs from QuickBooks
 * 3. Update the QB_ITEM_ID values below
 * 
 * ADDING NEW PRODUCTS:
 * Just add a new entry to PRODUCT_MAP - no other code changes needed.
 * 
 * @version 1.0.0
 */

/**
 * Product mapping table
 * 
 * Keys can be matched against:
 * - WooCommerce product name (case-insensitive, partial match)
 * - WooCommerce SKU (exact match)
 * 
 * qbItemId: Set to null until you create the product in QB and get the ID
 */
const PRODUCT_MAP = {
  // Primary product: Building Strong Teams
  'building-strong-teams': {
    keywords: ['building strong teams', 'strong teams', 'bst'],
    sku: 'BST-001',
    qbItemId: process.env.QB_ITEM_BST || null,  // Set in environment or update here
    qbItemName: 'Building Strong Teams',
    defaultPrice: 1750.00,
    description: 'Building Strong Teams program  - includes 6 team members'
  },

  // Add-on: Additional Team Member
  'additional-team-member': {
    keywords: ['additional team member', 'extra member', 'add member', 'additional member'],
    sku: 'BST-ADD',
    qbItemId: process.env.QB_ITEM_ADD || null,  // Set in environment or update here
    qbItemName: 'Additional Team Member',
    defaultPrice: 99.00,
    description: 'Additional team member beyond the 6 included in base'
  }

  // ──────────────────────────────────────────────────────────
  // FUTURE PRODUCTS: Add new entries here
  // ──────────────────────────────────────────────────────────
  // 'new-product-slug': {
  //   keywords: ['product name', 'alternate name'],
  //   sku: 'NEW-001',
  //   qbItemId: process.env.QB_ITEM_NEW || null,
  //   qbItemName: 'New Product Name',
  //   defaultPrice: 0.00,
  //   description: 'Product description'
  // }
};

/**
 * Map a WooCommerce product to QuickBooks item
 * @param {string} productName - WooCommerce product name
 * @param {string} sku - WooCommerce SKU (optional)
 * @returns {Object} QuickBooks item mapping
 */
export function mapProductToQuickBooks(productName, sku = null) {
  const nameLower = (productName || '').toLowerCase().trim();
  const skuLower = (sku || '').toLowerCase().trim();

  // First, try to match by SKU (exact match)
  for (const [key, product] of Object.entries(PRODUCT_MAP)) {
    if (skuLower && product.sku && product.sku.toLowerCase() === skuLower) {
      return {
        qbItemId: product.qbItemId,
        qbItemName: product.qbItemName,
        defaultPrice: product.defaultPrice,
        matched: true,
        matchedBy: 'sku',
        matchedKey: key
      };
    }
  }

  // Second, try to match by keywords in product name
  for (const [key, product] of Object.entries(PRODUCT_MAP)) {
    const keywordMatch = product.keywords.some(keyword => 
      nameLower.includes(keyword.toLowerCase())
    );
    
    if (keywordMatch) {
      return {
        qbItemId: product.qbItemId,
        qbItemName: product.qbItemName,
        defaultPrice: product.defaultPrice,
        matched: true,
        matchedBy: 'keyword',
        matchedKey: key
      };
    }
  }

  // No match found - return unmapped (will need manual handling)
  console.warn(`⚠ No QuickBooks mapping found for product: "${productName}" (SKU: ${sku || 'none'})`);
  
  return {
    qbItemId: null,
    qbItemName: productName,  // Use WooCommerce name as fallback
    defaultPrice: 0,
    matched: false,
    matchedBy: null,
    matchedKey: null
  };
}

/**
 * Get all configured products (for debugging/admin)
 * @returns {Object[]} Array of product configs
 */
export function getAllProducts() {
  return Object.entries(PRODUCT_MAP).map(([key, product]) => ({
    key,
    ...product,
    hasQbItemId: !!product.qbItemId
  }));
}

/**
 * Validate all products have QuickBooks IDs configured
 * @returns {Object} { valid: boolean, missing: string[] }
 */
export function validateProductConfig() {
  const missing = [];
  
  for (const [key, product] of Object.entries(PRODUCT_MAP)) {
    if (!product.qbItemId) {
      missing.push(key);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    message: missing.length === 0 
      ? 'All products have QuickBooks Item IDs configured'
      : `Missing QuickBooks Item IDs for: ${missing.join(', ')}`
  };
}
