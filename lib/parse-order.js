/**
 * WooCommerce Order Parser
 * 
 * Transforms WooCommerce webhook payload into normalized order object
 * for QuickBooks processing.
 * 
 * @version 1.1.0
 * @lastUpdated 2024-12-30
 * 
 * CHANGELOG v1.1.0:
 * - Added paylater price handling: uses full prices (not discounted) for invoices
 * - Paylater orders now invoice at standard rates regardless of WooCommerce discount
 */

import { mapProductToQuickBooks } from './product-map.js';

/**
 * Parse WooCommerce order webhook payload
 * @param {Object} payload - Raw webhook payload from WooCommerce
 * @returns {Object} Normalized order object
 */
export function parseWooCommerceOrder(payload) {
  // Validate required fields
  if (!payload || !payload.id) {
    throw new Error('Invalid WooCommerce payload: missing order ID');
  }

  if (!payload.billing || !payload.billing.email) {
    throw new Error('Invalid WooCommerce payload: missing billing email');
  }

  // Check if this is a paylater order FIRST (we need this for pricing)
  const isPaylater = detectPaylater(payload);
  
  if (isPaylater) {
    console.log('💳 Paylater order detected - will use full prices for invoice');
  }

  // Build customer object
  const customer = {
    email: payload.billing.email,
    firstName: payload.billing.first_name || '',
    lastName: payload.billing.last_name || '',
    company: payload.billing.company || '',
    phone: payload.billing.phone || '',
    
    // Display name: prefer company, fall back to full name
    displayName: payload.billing.company 
      ? payload.billing.company 
      : `${payload.billing.first_name} ${payload.billing.last_name}`.trim(),
    
    // Billing address
    address: {
      line1: payload.billing.address_1 || '',
      line2: payload.billing.address_2 || '',
      city: payload.billing.city || '',
      state: payload.billing.state || '',
      postalCode: payload.billing.postcode || '',
      country: payload.billing.country || 'US'
    }
  };

  // Parse line items
  const lineItems = (payload.line_items || []).map(item => {
    // Map WooCommerce product to QuickBooks item
    const qbMapping = mapProductToQuickBooks(item.name, item.sku);
    
    const quantity = parseInt(item.quantity, 10) || 1;
    
    // Get prices - use DEFAULT prices for paylater, WooCommerce prices otherwise
    let unitPrice, total;
    
    if (isPaylater && qbMapping.matched && qbMapping.defaultPrice > 0) {
      // PAYLATER: Use the standard price from product map
      unitPrice = qbMapping.defaultPrice;
      total = unitPrice * quantity;
      console.log(`   💰 ${item.name}: Using full price $${unitPrice} x ${quantity} = $${total}`);
    } else {
      // PAID: Use WooCommerce prices (already paid via Stripe)
      unitPrice = parseFloat(item.price) || 0;
      total = parseFloat(item.total) || 0;
    }
    
    return {
      name: item.name,
      sku: item.sku || null,
      quantity: quantity,
      unitPrice: unitPrice,
      total: total,
      
      // QuickBooks mapping
      qbItemId: qbMapping.qbItemId,
      qbItemName: qbMapping.qbItemName
    };
  });

  // Calculate totals
  let subtotal, total;
  
  if (isPaylater) {
    // PAYLATER: Calculate from our full-price line items
    subtotal = lineItems.reduce((sum, item) => sum + item.total, 0);
    total = subtotal;
    console.log(`   💰 Paylater invoice total: $${total}`);
  } else {
    // PAID: Use WooCommerce totals
    subtotal = lineItems.reduce((sum, item) => sum + item.total, 0);
    total = parseFloat(payload.total) || subtotal;
  }

  return {
    orderId: payload.id,
    orderNumber: payload.number || payload.id,
    status: payload.status,
    dateCreated: payload.date_created || new Date().toISOString(),
    datePaid: payload.date_paid,
    
    customer,
    lineItems,
    
    subtotal,
    total,
    currency: payload.currency || 'USD',
    
    isPaylater,
    paymentMethod: payload.payment_method || 'unknown',
    transactionId: payload.transaction_id || null,
    
    // Preserve coupon info for reference
    coupons: (payload.coupon_lines || []).map(c => ({
      code: c.code,
      discount: parseFloat(c.discount) || 0
    })),
    
    // Raw payload for debugging
    _raw: payload
  };
}

/**
 * Detect if order used paylater coupon
 * @param {Object} payload - WooCommerce order payload
 * @returns {boolean}
 */
function detectPaylater(payload) {
  // Check coupon_lines for paylater code
  const coupons = payload.coupon_lines || [];
  
  const hasPaylaterCoupon = coupons.some(coupon => {
    const code = (coupon.code || '').toLowerCase().trim();
    return code === 'paylater' || code === 'pay-later' || code === 'pay_later';
  });

  // Also check if total is $0 with a 100% discount
  // (backup detection in case coupon name varies)
  const totalIsZero = parseFloat(payload.total) === 0;
  const hasFullDiscount = coupons.some(coupon => {
    const discount = parseFloat(coupon.discount) || 0;
    const subtotal = parseFloat(payload.subtotal) || 0;
    return discount > 0 && discount >= subtotal;
  });

  return hasPaylaterCoupon || (totalIsZero && hasFullDiscount);
}

/**
 * Validate order has required data for QuickBooks
 * @param {Object} order - Parsed order object
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validateOrderForQuickBooks(order) {
  const errors = [];

  if (!order.customer.email) {
    errors.push('Customer email is required');
  }

  if (!order.customer.displayName) {
    errors.push('Customer name or company is required');
  }

  if (!order.lineItems || order.lineItems.length === 0) {
    errors.push('Order must have at least one line item');
  }

  // Check that all line items have QB mappings
  order.lineItems.forEach((item, index) => {
    if (!item.qbItemId) {
      errors.push(`Line item ${index + 1} (${item.name}) has no QuickBooks mapping`);
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}
