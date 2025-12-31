/**
 * Stripe Payment Lookup
 * 
 * @version 1.0.0
 * @description Find Stripe payments matching YCBM bookings
 * @lastUpdated 2024-12-31
 * 
 * STRATEGY:
 * - Search recent Stripe charges by customer email
 * - Filter by approximate amount (base price)
 * - Exclude WooCommerce charges (have wc_order in metadata)
 * - Return most recent matching charge
 */

import Stripe from 'stripe';

// Initialize Stripe client
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Find a Stripe payment matching a YCBM booking
 * 
 * @param {string} email - Customer email from YCBM
 * @param {number} expectedAmount - Expected base payment amount (e.g., 1750)
 * @param {number} lookbackMinutes - How far back to search (default 30 min)
 * @returns {Object|null} - { amount, chargeId, paymentIntentId } or null if not found
 */
export async function findStripePayment(email, expectedAmount, lookbackMinutes = 30) {
  try {
    console.log(`   Searching Stripe for: ${email}`);
    console.log(`   Expected amount: ~$${expectedAmount}`);
    console.log(`   Lookback: ${lookbackMinutes} minutes`);

    // Calculate time range
    const now = Math.floor(Date.now() / 1000);
    const lookbackSeconds = lookbackMinutes * 60;
    const createdAfter = now - lookbackSeconds;

    // Search for payment intents by email
    // Note: Stripe doesn't directly filter by email, so we search recent charges
    // and filter client-side
    const charges = await stripe.charges.list({
      created: { gte: createdAfter },
      limit: 50 // Get recent charges
    });

    console.log(`   Found ${charges.data.length} charges in last ${lookbackMinutes} minutes`);

    // Filter charges
    for (const charge of charges.data) {
      // Skip failed charges
      if (charge.status !== 'succeeded') {
        continue;
      }

      // Check if email matches (case-insensitive)
      const chargeEmail = charge.billing_details?.email || 
                          charge.receipt_email || 
                          charge.metadata?.email;
      
      if (!chargeEmail || chargeEmail.toLowerCase() !== email.toLowerCase()) {
        continue;
      }

      // Skip WooCommerce charges (they have wc_order in metadata)
      if (charge.metadata?.wc_order || charge.metadata?.order_id) {
        console.log(`   Skipping WooCommerce charge: ${charge.id}`);
        continue;
      }

      // Check amount (within 5% tolerance for rounding/fees)
      const chargeAmount = charge.amount / 100; // Convert cents to dollars
      const tolerance = expectedAmount * 0.05;
      
      if (Math.abs(chargeAmount - expectedAmount) <= tolerance) {
        console.log(`   ✓ MATCH FOUND!`);
        console.log(`     Charge ID: ${charge.id}`);
        console.log(`     Amount: $${chargeAmount}`);
        console.log(`     Email: ${chargeEmail}`);
        console.log(`     Created: ${new Date(charge.created * 1000).toISOString()}`);

        return {
          amount: chargeAmount,
          chargeId: charge.id,
          paymentIntentId: charge.payment_intent,
          email: chargeEmail,
          created: new Date(charge.created * 1000)
        };
      }
    }

    // No matching payment found
    console.log(`   ✗ No matching Stripe payment found`);
    return null;

  } catch (error) {
    console.error(`   Stripe lookup error: ${error.message}`);
    
    // If Stripe key not configured, return null (will treat as paylater)
    if (error.message.includes('API key')) {
      console.log(`   ⚠️  Stripe not configured - treating as paylater`);
      return null;
    }
    
    throw error;
  }
}

/**
 * Get recent YCBM-related charges (for debugging)
 * 
 * @param {number} limit - Number of charges to retrieve
 * @returns {Array} - Recent charges
 */
export async function getRecentCharges(limit = 20) {
  try {
    const charges = await stripe.charges.list({
      limit: limit
    });

    return charges.data.map(charge => ({
      id: charge.id,
      amount: charge.amount / 100,
      email: charge.billing_details?.email || charge.receipt_email,
      status: charge.status,
      created: new Date(charge.created * 1000).toISOString(),
      metadata: charge.metadata,
      isWooCommerce: !!(charge.metadata?.wc_order || charge.metadata?.order_id)
    }));

  } catch (error) {
    console.error('Error fetching recent charges:', error.message);
    return [];
  }
}

/**
 * Verify Stripe connection (for testing)
 */
export async function verifyStripeConnection() {
  try {
    const balance = await stripe.balance.retrieve();
    console.log('✓ Stripe connection verified');
    console.log(`  Available: ${balance.available.map(b => `${b.currency.toUpperCase()} ${b.amount/100}`).join(', ')}`);
    return true;
  } catch (error) {
    console.error('✗ Stripe connection failed:', error.message);
    return false;
  }
}
