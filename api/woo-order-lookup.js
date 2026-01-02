/**
 * WooCommerce Order Lookup Endpoint
 * 
 * @version 1.0.0
 * @description Fetches order data from WooCommerce REST API for testing/debugging
 * @lastUpdated 2026-01-01
 * 
 * USAGE:
 *   GET /api/woo-order-lookup?orderId=780
 *   GET /api/woo-order-lookup?orderId=780&format=summary
 * 
 * SETUP REQUIRED:
 *   Vercel env vars:
 *   - WOO_API_URL: https://basleracademy.com
 *   - WOO_CONSUMER_KEY: ck_xxxxxxxx
 *   - WOO_CONSUMER_SECRET: cs_xxxxxxxx
 */

export default async function handler(req, res) {
  // Only accept GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const { orderId, format } = req.query;

  // Validate order ID
  if (!orderId) {
    return res.status(400).json({ 
      error: 'Missing orderId parameter',
      usage: '/api/woo-order-lookup?orderId=780',
      example: '/api/woo-order-lookup?orderId=780&format=summary'
    });
  }

  // Check for required environment variables
  const apiUrl = process.env.WOO_API_URL;
  const consumerKey = process.env.WOO_CONSUMER_KEY;
  const consumerSecret = process.env.WOO_CONSUMER_SECRET;

  if (!apiUrl || !consumerKey || !consumerSecret) {
    return res.status(500).json({ 
      error: 'Missing WooCommerce API configuration',
      required: ['WOO_API_URL', 'WOO_CONSUMER_KEY', 'WOO_CONSUMER_SECRET'],
      configured: {
        WOO_API_URL: !!apiUrl,
        WOO_CONSUMER_KEY: !!consumerKey,
        WOO_CONSUMER_SECRET: !!consumerSecret
      }
    });
  }

  try {
    console.log(`🔍 Fetching WooCommerce order #${orderId}...`);

    // Build WooCommerce REST API URL
    const endpoint = `${apiUrl}/wp-json/wc/v3/orders/${orderId}`;
    
    // WooCommerce uses Basic Auth with consumer key/secret
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ WooCommerce API error: ${response.status}`);
      
      if (response.status === 404) {
        return res.status(404).json({ 
          error: `Order #${orderId} not found`,
          status: response.status
        });
      }
      
      return res.status(response.status).json({ 
        error: 'WooCommerce API error',
        status: response.status,
        details: errorText
      });
    }

    const order = await response.json();
    console.log(`✅ Order #${orderId} fetched successfully`);

    // Return summary format if requested
    if (format === 'summary') {
      return res.status(200).json({
        orderId: order.id,
        orderNumber: order.number,
        status: order.status,
        dateCreated: order.date_created,
        customer: {
          name: `${order.billing.first_name} ${order.billing.last_name}`,
          email: order.billing.email,
          company: order.billing.company
        },
        lineItems: order.line_items.map(item => ({
          name: item.name,
          sku: item.sku,
          quantity: item.quantity,
          price: item.price,
          total: item.total
        })),
        coupons: order.coupon_lines.map(c => ({
          code: c.code,
          discount: c.discount
        })),
        subtotal: order.subtotal,
        discountTotal: order.discount_total,
        total: order.total,
        paymentMethod: order.payment_method,
        paymentMethodTitle: order.payment_method_title,
        transactionId: order.transaction_id
      });
    }

    // Return full payload (this is what the webhook sends)
    return res.status(200).json(order);

  } catch (error) {
    console.error(`❌ Error fetching order: ${error.message}`);
    return res.status(500).json({ 
      error: 'Failed to fetch order',
      message: error.message
    });
  }
}
