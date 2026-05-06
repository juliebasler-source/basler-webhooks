/**
 * Inspect Recent Stripe Charges
 *
 * GET /api/stripe-recent-charges
 * GET /api/stripe-recent-charges?limit=20
 * GET /api/stripe-recent-charges?email=foo@bar.com
 *
 * Pulls recent Stripe charges with the balance_transaction expanded so we can
 * see the actual `fee` and `net` values we'll need for the Stripe-fees journal
 * entry. Also surfaces metadata, payment_intent, and any application_fee_amount
 * so we can confirm the data shape before wiring up the JE code.
 *
 * READ-ONLY. Does not write to QuickBooks or Stripe.
 */

import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const limit = Math.min(parseInt(req.query?.limit, 10) || 10, 100);
  const emailFilter = req.query?.email ? req.query.email.toLowerCase() : null;

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    console.log(`🔍 Fetching last ${limit} Stripe charges...`);
    if (emailFilter) console.log(`   Filtering by email=${emailFilter}`);

    const charges = await stripe.charges.list({
      limit,
      expand: ['data.balance_transaction', 'data.payment_intent']
    });

    let data = charges.data;
    if (emailFilter) {
      data = data.filter(c => {
        const e = (c.billing_details?.email || c.receipt_email || '').toLowerCase();
        return e === emailFilter;
      });
    }

    const formatted = data.map(charge => {
      const bt = charge.balance_transaction || null;
      const pi = charge.payment_intent || null;

      return {
        chargeId: charge.id,
        created: new Date(charge.created * 1000).toISOString(),
        status: charge.status,
        paid: charge.paid,
        refunded: charge.refunded,
        amount: charge.amount / 100,
        amountRefunded: charge.amount_refunded / 100,
        currency: charge.currency,
        description: charge.description,
        email: charge.billing_details?.email || charge.receipt_email,
        name: charge.billing_details?.name,
        paymentIntentId: typeof pi === 'string' ? pi : pi?.id,
        paymentIntentMetadata: typeof pi === 'object' ? pi?.metadata : undefined,
        chargeMetadata: charge.metadata,
        applicationFeeAmount: charge.application_fee_amount
          ? charge.application_fee_amount / 100
          : null,
        balanceTransaction: bt ? {
          id: bt.id,
          fee: bt.fee / 100,
          net: bt.net / 100,
          gross: bt.amount / 100,
          currency: bt.currency,
          available_on: new Date(bt.available_on * 1000).toISOString().slice(0, 10),
          feeBreakdown: (bt.fee_details || []).map(f => ({
            type: f.type,
            amount: f.amount / 100,
            description: f.description,
            currency: f.currency
          }))
        } : null
      };
    });

    // Quick aggregate so we can eyeball fee patterns
    const withFees = formatted.filter(c => c.balanceTransaction);
    const totalGross = withFees.reduce((s, c) => s + c.balanceTransaction.gross, 0);
    const totalFees = withFees.reduce((s, c) => s + c.balanceTransaction.fee, 0);
    const totalNet = withFees.reduce((s, c) => s + c.balanceTransaction.net, 0);
    const effectiveFeeRate = totalGross > 0 ? (totalFees / totalGross) * 100 : 0;

    return res.status(200).json({
      count: formatted.length,
      summary: {
        chargesWithBalanceTransaction: withFees.length,
        totalGross: round2(totalGross),
        totalFees: round2(totalFees),
        totalNet: round2(totalNet),
        effectiveFeeRatePct: round2(effectiveFeeRate)
      },
      charges: formatted
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch Stripe charges',
      message: error.message
    });
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
