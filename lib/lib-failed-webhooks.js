/**
 * Failed Webhook Logger
 * 
 * @version 1.0.0
 * @description Logs failed webhooks to Vercel KV for review and retry
 */

import { kv } from '@vercel/kv';

const FAILED_WEBHOOK_PREFIX = 'failed_webhook:';
const MAX_STORED_FAILURES = 100; // Keep last 100 failures

/**
 * Log a failed webhook to KV store
 * 
 * @param {string} source - 'woocommerce' or 'ycbm'
 * @param {Object} payload - Original webhook payload
 * @param {string} error - Error message
 * @param {Object} context - Additional context (order ID, customer, etc.)
 */
export async function logFailedWebhook(source, payload, error, context = {}) {
  try {
    const timestamp = new Date().toISOString();
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const key = `${FAILED_WEBHOOK_PREFIX}${id}`;
    
    const failedWebhook = {
      id,
      source,
      timestamp,
      error: error.toString(),
      context,
      payload,
      retried: false,
      retriedAt: null
    };
    
    // Store with 30-day expiry (2592000 seconds)
    await kv.set(key, failedWebhook, { ex: 2592000 });
    
    // Add to index list for easy retrieval
    await kv.lpush('failed_webhook_ids', id);
    
    // Trim to keep only recent failures
    await kv.ltrim('failed_webhook_ids', 0, MAX_STORED_FAILURES - 1);
    
    console.log(`📝 Failed webhook logged: ${id}`);
    console.log(`   Source: ${source}`);
    console.log(`   Error: ${error}`);
    
    return id;
  } catch (kvError) {
    // Don't let logging failure break the response
    console.error('⚠️  Failed to log webhook failure to KV:', kvError.message);
    console.error('   Original error:', error);
    console.error('   Payload:', JSON.stringify(payload).substring(0, 500));
    return null;
  }
}

/**
 * Get all failed webhooks
 * 
 * @param {number} limit - Max number to retrieve
 * @returns {Array} List of failed webhooks
 */
export async function getFailedWebhooks(limit = 50) {
  try {
    // Get IDs from index
    const ids = await kv.lrange('failed_webhook_ids', 0, limit - 1);
    
    if (!ids || ids.length === 0) {
      return [];
    }
    
    // Fetch each failed webhook
    const failures = await Promise.all(
      ids.map(async (id) => {
        const data = await kv.get(`${FAILED_WEBHOOK_PREFIX}${id}`);
        return data;
      })
    );
    
    // Filter out any nulls (expired entries)
    return failures.filter(f => f !== null);
  } catch (error) {
    console.error('Failed to get failed webhooks:', error);
    return [];
  }
}

/**
 * Get a specific failed webhook by ID
 * 
 * @param {string} id - Failed webhook ID
 * @returns {Object|null} Failed webhook data or null
 */
export async function getFailedWebhook(id) {
  try {
    return await kv.get(`${FAILED_WEBHOOK_PREFIX}${id}`);
  } catch (error) {
    console.error(`Failed to get webhook ${id}:`, error);
    return null;
  }
}

/**
 * Mark a failed webhook as retried
 * 
 * @param {string} id - Failed webhook ID
 * @param {boolean} success - Whether retry succeeded
 */
export async function markRetried(id, success = true) {
  try {
    const key = `${FAILED_WEBHOOK_PREFIX}${id}`;
    const data = await kv.get(key);
    
    if (data) {
      data.retried = true;
      data.retriedAt = new Date().toISOString();
      data.retrySuccess = success;
      await kv.set(key, data, { ex: 2592000 });
    }
  } catch (error) {
    console.error(`Failed to mark webhook ${id} as retried:`, error);
  }
}

/**
 * Delete a failed webhook
 * 
 * @param {string} id - Failed webhook ID
 */
export async function deleteFailedWebhook(id) {
  try {
    await kv.del(`${FAILED_WEBHOOK_PREFIX}${id}`);
    await kv.lrem('failed_webhook_ids', 0, id);
    console.log(`🗑️  Deleted failed webhook: ${id}`);
  } catch (error) {
    console.error(`Failed to delete webhook ${id}:`, error);
  }
}

/**
 * Clear all failed webhooks
 */
export async function clearAllFailedWebhooks() {
  try {
    const ids = await kv.lrange('failed_webhook_ids', 0, -1);
    
    for (const id of ids) {
      await kv.del(`${FAILED_WEBHOOK_PREFIX}${id}`);
    }
    
    await kv.del('failed_webhook_ids');
    console.log(`🗑️  Cleared all failed webhooks`);
  } catch (error) {
    console.error('Failed to clear webhooks:', error);
  }
}
