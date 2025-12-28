# Basler Webhooks

Webhook handlers for Basler Academy integrations.

## WooCommerce → QuickBooks Sync

Automatically syncs WooCommerce orders to QuickBooks Online:

- **Paid orders** → Creates Sales Receipt in QuickBooks
- **Paylater orders** (100% coupon) → Creates Invoice with NET 30 terms, auto-sends

### Architecture

```
WooCommerce (order.completed)
        │
        ▼ webhook
Vercel Function (/api/woo-qb-sync)
        │
        ├── Parse order
        ├── Detect paylater vs paid
        ├── Find/create QB customer
        └── Create receipt or invoice
        │
        ▼
QuickBooks Online
```

---

## Setup

### 1. QuickBooks Developer Account

1. Go to [developer.intuit.com](https://developer.intuit.com)
2. Create an account and app
3. Get your Client ID and Client Secret
4. Use the OAuth Playground to get initial refresh token
5. Note your Realm ID (Company ID)

### 2. Create Products in QuickBooks

Create these products/services in QuickBooks Online:

| Product Name | Type | Price |
|--------------|------|-------|
| Building Strong Teams | Service | $1,750.00 |
| Additional Team Member | Service | $99.00 |

Note the Item IDs after creating them.

### 3. Environment Variables

Set these in Vercel dashboard (Settings → Environment Variables):

```
QB_CLIENT_ID=xxx
QB_CLIENT_SECRET=xxx
QB_REFRESH_TOKEN=xxx
QB_REALM_ID=xxx
QB_ENVIRONMENT=sandbox  (or 'production')
QB_ITEM_BST=xxx  (Building Strong Teams Item ID)
QB_ITEM_ADD=xxx  (Additional Team Member Item ID)
WOO_WEBHOOK_SECRET=xxx
```

### 4. Deploy to Vercel

```bash
npm install
vercel --prod
```

Note your deployment URL (e.g., `https://basler-webhooks.vercel.app`)

### 5. Configure WooCommerce Webhook

1. WooCommerce → Settings → Advanced → Webhooks
2. Add webhook:
   - **Name:** QuickBooks Sync
   - **Status:** Active
   - **Topic:** Order completed
   - **Delivery URL:** `https://your-vercel-url.vercel.app/api/woo-qb-sync`
   - **Secret:** (generate one, save it as WOO_WEBHOOK_SECRET)
3. Save

---

## Testing

### Test with Sandbox

1. Set `QB_ENVIRONMENT=sandbox`
2. Use QuickBooks sandbox company
3. Place test order in WooCommerce

### Check Logs

View logs in Vercel dashboard → Deployments → Functions → Logs

---

## File Structure

```
basler-webhooks/
├── api/
│   └── woo-qb-sync.js      # Main webhook handler
├── lib/
│   ├── quickbooks.js       # QB API client
│   ├── parse-order.js      # WooCommerce parsing
│   ├── product-map.js      # Product ID mapping
│   └── validate-webhook.js # Signature validation
├── scripts/
│   └── test-quickbooks.js  # QB connection test
├── package.json
├── vercel.json
├── .env.example
└── README.md
```

---

## Adding New Products

1. Create product in WooCommerce
2. Create matching product in QuickBooks
3. Add entry to `lib/product-map.js`:

```javascript
'new-product-slug': {
  keywords: ['product name', 'alternate name'],
  sku: 'NEW-001',
  qbItemId: process.env.QB_ITEM_NEW || null,
  qbItemName: 'New Product Name',
  defaultPrice: 0.00
}
```

4. Add environment variable `QB_ITEM_NEW` with the QB Item ID

---

## Troubleshooting

### "Missing QuickBooks config"
→ Check environment variables are set in Vercel

### "Failed to refresh QB token"
→ Refresh token may have expired (100 days). Re-authorize via OAuth playground.

### "No QuickBooks mapping found for product"
→ Add product to `lib/product-map.js`

### Invoice not sending
→ Check customer email is valid in QuickBooks

---

## Related

- [WooCommerce Webhooks Docs](https://woocommerce.com/document/webhooks/)
- [QuickBooks API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice)
- Strong Teams Apps Script automation (separate repo)
