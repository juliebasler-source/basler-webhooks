/**
 * WooCommerce Webhook Validation
 * 
 * Validates webhook signatures to ensure requests are from WooCommerce.
 * 
 * @version 1.0.0
 */

import crypto from 'crypto';

/**
 * Validate WooCommerce webhook signature
 * 
 * WooCommerce signs webhooks with HMAC-SHA256 using the webhook secret.
 * The signature is sent in the X-WC-Webhook-Signature header.
 * 
 * @param {string} payload - Raw request body (JSON string)
 * @param {string} signature - Signature from X-WC-Webhook-Signature header
 * @param {string} secret - Webhook secret from WooCommerce settings
 * @returns {boolean} True if signature is valid
 */
export function validateWooCommerceWebhook(payload, signature, secret) {
  if (!signature || !secret) {
    return false;
  }

  // WooCommerce uses base64-encoded HMAC-SHA256
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('base64');

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (e) {
    // Buffers of different lengths will throw
    return false;
  }
}

/**
 * Extract webhook metadata from headers
 * 
 * @param {Object} headers - Request headers
 * @returns {Object} Webhook metadata
 */
export function getWebhookMetadata(headers) {
  return {
    signature: headers['x-wc-webhook-signature'],
    source: headers['x-wc-webhook-source'],      // Site URL
    topic: headers['x-wc-webhook-topic'],        // e.g., 'order.completed'
    resource: headers['x-wc-webhook-resource'],  // e.g., 'order'
    event: headers['x-wc-webhook-event'],        // e.g., 'completed'
    deliveryId: headers['x-wc-webhook-delivery-id'],
    webhookId: headers['x-wc-webhook-id']
  };
}
