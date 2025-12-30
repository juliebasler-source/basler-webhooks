/**
 * Product Mapping Configuration
 * 
 * Maps WooCommerce products to QuickBooks items.
 * 
 * @version 1.1.0
 * @lastUpdated 2024-12-30
 * 
 * CHANGELOG v1.1.0:
 * - Added debug logging to show env var values
 * - Added explicit handling for undefined env vars
 */

/**
 * Product mapping table
 * 
 * Keys can be matched against:
 * - WooCommerce product name (case-insensitive, partial match)
 * - WooCommerce SKU (exact match)
 */
const PRODUCT_MAP = {
  // Primary product: Building Strong Teams
  'building-strong-teams': {
    keywords: ['building strong teams', 'strong teams', 'bst'],
    sku: 'BST-001',
    qbItemId: process.env.QB_ITEM_BST || null,
    qbItemName: 'Building Strong Teams',
    defaultPrice: 1750.00,
    description: 'Building Strong Teams program - includes 6 team members'
  },

  // Add-on: Additional Team Member
  'additional-team-member': {
    keywords: ['additional team member', 'extra member', 'add member', 'additional member'],
    sku: 'BST-ADD',
    qbItemId: process.env.QB_ITEM_ADD || null,
    qbItemName: 'Strong Teams - Additional Team Member',
    defaultPrice: 99.00,
    description: 'Additional team member beyond the 6 included in base'
  }
};

// Log configured Item IDs at module load time
console.log('📦 Product Map Configuration:');
console.log(`   QB_ITEM_BST env var: ${process.env.QB_ITEM_BST || '(not set)'}`);
console.log(`   QB_ITEM_ADD env var: ${process.env.QB_ITEM_ADD || '(not set)'}`);

/**
 * Map a WooCommerce product to QuickBooks item
 * @param {string} productName - WooCommerce product name
 * @param {string} sku - WooCommerce SKU (optional)
 * @returns {Object} QuickBooks item mapping
 */
export function mapProductToQuickBooks(productName, sku = null) {
  const nameLower = (productName || '').toLowerCase().trim();
  const skuLower = (sku || '').toLowerCase().trim();

  console.log(`   Mapping product: "${productName}" (SKU: ${sku || 'none'})`);

  // First, try to match by SKU (exact match)
  for (const [key, product] of Object.entries(PRODUCT_MAP)) {
    if (skuLower && product.sku && product.sku.toLowerCase() === skuLower) {
      console.log(`     ✓ Matched by SKU to ${key}, qbItemId: ${product.qbItemId}`);
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
      console.log(`     ✓ Matched by keyword to ${key}, qbItemId: ${product.qbItemId}`);
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
  console.warn(`     ⚠ No QuickBooks mapping found for product: "${productName}"`);
  
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
