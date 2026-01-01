/**
 * Failed Webhooks API
 * 
 * @version 1.0.0
 * @description View and retry failed webhooks
 * 
 * Endpoints:
 *   GET  /api/failed-webhooks           - List all failed webhooks
 *   GET  /api/failed-webhooks?id=xxx    - Get specific failed webhook
 *   POST /api/failed-webhooks?id=xxx    - Retry a failed webhook
 *   DELETE /api/failed-webhooks?id=xxx  - Delete a failed webhook
 *   DELETE /api/failed-webhooks?all=1   - Clear all failed webhooks
 */

import { 
  getFailedWebhooks, 
  getFailedWebhook, 
  markRetried, 
  deleteFailedWebhook,
  clearAllFailedWebhooks 
} from '../lib/failed-webhooks.js';

export default async function handler(req, res) {
  // Simple auth check - require a secret header
  const authHeader = req.headers['x-admin-secret'];
  const expectedSecret = process.env.ADMIN_SECRET || 'basler-admin-2026';
  
  if (authHeader !== expectedSecret) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      hint: 'Include x-admin-secret header'
    });
  }

  const { id, all } = req.query;

  try {
    // GET - List or retrieve
    if (req.method === 'GET') {
      if (id) {
        // Get specific webhook
        const webhook = await getFailedWebhook(id);
        if (!webhook) {
          return res.status(404).json({ error: 'Not found' });
        }
        return res.status(200).json(webhook);
      } else {
        // List all
        const webhooks = await getFailedWebhooks(50);
        return res.status(200).json({
          count: webhooks.length,
          webhooks: webhooks.map(w => ({
            id: w.id,
            source: w.source,
            timestamp: w.timestamp,
            error: w.error,
            context: w.context,
            retried: w.retried,
            retriedAt: w.retriedAt
          }))
        });
      }
    }

    // POST - Retry a webhook
    if (req.method === 'POST') {
      if (!id) {
        return res.status(400).json({ error: 'Missing id parameter' });
      }

      const webhook = await getFailedWebhook(id);
      if (!webhook) {
        return res.status(404).json({ error: 'Not found' });
      }

      // Determine which endpoint to call
      const endpoint = webhook.source === 'woocommerce' 
        ? '/api/woo-qb-sync'
        : '/api/ycbm-qb';

      // Get the base URL
      const baseUrl = process.env.VERCEL_URL 
        ? `https://${process.env.VERCEL_URL}`
        : 'https://basler-webhooks.vercel.app';

      console.log(`🔄 Retrying webhook ${id} to ${endpoint}...`);

      // Replay the webhook
      const retryResponse = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Retry-Webhook': id // Mark as retry to prevent re-logging on failure
        },
        body: JSON.stringify(webhook.payload)
      });

      const retryResult = await retryResponse.text();
      const success = retryResponse.ok;

      // Mark as retried
      await markRetried(id, success);

      if (success) {
        return res.status(200).json({
          success: true,
          message: `Webhook ${id} retried successfully`,
          result: retryResult
        });
      } else {
        return res.status(200).json({
          success: false,
          message: `Webhook ${id} retry failed`,
          error: retryResult
        });
      }
    }

    // DELETE - Remove webhook(s)
    if (req.method === 'DELETE') {
      if (all === '1' || all === 'true') {
        await clearAllFailedWebhooks();
        return res.status(200).json({ 
          success: true, 
          message: 'All failed webhooks cleared' 
        });
      }
      
      if (!id) {
        return res.status(400).json({ error: 'Missing id parameter' });
      }

      await deleteFailedWebhook(id);
      return res.status(200).json({ 
        success: true, 
        message: `Webhook ${id} deleted` 
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('Failed webhooks API error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}
