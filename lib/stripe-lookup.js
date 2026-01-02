/**
 * Stripe Payment Lookup for YCBM Integration
 * 
 * @version 2.0.0
 * @description Search Stripe for payments by email and extract discount details
 * @lastUpdated 2025-01-02
 * 
 * CHANGELOG v2.0.0:
 * - Changed matching to email-only (removed amount tolerance check)
 * - Added discount extraction (fixed and percentage)
 * - Added coupon code extraction
 * - Added description and booking ref parsing
 * - Returns complete payment details for QB record creation
 */

const Stripe = require('stripe');

/**
 * Search Stripe for a recent payment matching the customer email
 * 
 * @param {string} email - Customer email to search for
 * @param {number} lookbackMinutes - How far back to search (default 30)
 * @returns {Object} Payment details or { found: false }
 */
async function findPaymentByEmail(email, lookbackMinutes = 30) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  
  console.log(`🔍 Searching Stripe for: ${email}`);
  console.log(`   Lookback: ${lookbackMinutes} minutes`);
  
  try {
    // Calculate time window
    const now = Math.floor(Date.now() / 1000);
    const lookbackSeconds = lookbackMinutes * 60;
    const startTime = now - lookbackSeconds;
    
    // Search for checkout sessions (has more detail than charges)
    const sessions = await stripe.checkout.sessions.list({
      limit: 10,
      created: { gte: startTime },
      expand: ['data.line_items', 'data.total_details']
    });
    
    console.log(`   Found ${sessions.data.length} checkout sessions in last ${lookbackMinutes} minutes`);
    
    // Find session matching email
    for (const session of sessions.data) {
      const sessionEmail = session.customer_details?.email || session.customer_email;
      
      if (sessionEmail && sessionEmail.toLowerCase() === email.toLowerCase()) {
        console.log(`   ✓ Found matching session: ${session.id}`);
        
        // Extract payment details
        const result = await extractSessionDetails(stripe, session);
        return result;
      }
    }
    
    // Fallback: search charges directly (older method, less detail)
    console.log(`   No checkout sessions found, searching charges...`);
    const charges = await stripe.charges.list({
      limit: 20,
      created: { gte: startTime }
    });
    
    console.log(`   Found ${charges.data.length} charges in last ${lookbackMinutes} minutes`);
    
    for (const charge of charges.data) {
      const chargeEmail = charge.billing_details?.email || charge.receipt_email;
      
      if (chargeEmail && chargeEmail.toLowerCase() === email.toLowerCase()) {
        console.log(`   ✓ Found matching charge: ${charge.id}`);
        
        // Extract from charge (less detail available)
        const result = extractChargeDetails(charge);
        return result;
      }
    }
    
    console.log(`   ✗ No matching payment found for ${email}`);
    return { found: false };
    
  } catch (error) {
    console.error(`   ❌ Stripe lookup error: ${error.message}`);
    return { found: false, error: error.message };
  }
}

/**
 * Extract detailed payment info from a Checkout Session
 */
async function extractSessionDetails(stripe, session) {
  const result = {
    found: true,
    sessionId: session.id,
    amountPaid: session.amount_total || 0,           // Amount actually charged (in cents)
    subtotal: session.amount_subtotal || 0,          // Before discount (in cents)
    discountAmount: 0,
    discountType: null,       // 'fixed' or 'percent'
    percentOff: null,
    couponCode: null,
    description: null,
    bookingRef: null,
    customerEmail: session.customer_details?.email || session.customer_email,
    customerName: session.customer_details?.name || null
  };
  
  // Calculate discount from subtotal vs total
  if (result.subtotal > result.amountPaid) {
    result.discountAmount = result.subtotal - result.amountPaid;
  }
  
  // Get discount details from total_details
  if (session.total_details?.breakdown?.discounts?.length > 0) {
    const discountInfo = session.total_details.breakdown.discounts[0];
    result.discountAmount = discountInfo.amount || result.discountAmount;
    
    // Try to get coupon details
    if (discountInfo.discount?.coupon) {
      const coupon = discountInfo.discount.coupon;
      result.couponCode = coupon.name || coupon.id;
      
      if (coupon.percent_off) {
        result.discountType = 'percent';
        result.percentOff = coupon.percent_off;
      } else if (coupon.amount_off) {
        result.discountType = 'fixed';
      }
    }
  }
  
  // If we still don't have coupon details, try fetching the payment intent
  if (!result.couponCode && session.payment_intent) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
      result.description = paymentIntent.description;
      
      // Parse booking ref from description
      // Format: "Booking with email@..., 1/2/26, 12:00 PM (timezone) [ref:XXXX-XXXX-XXXX]"
      if (result.description) {
        const refMatch = result.description.match(/\[ref:([A-Z0-9-]+)\]/);
        if (refMatch) {
          result.bookingRef = refMatch[1];
        }
      }
    } catch (e) {
      console.log(`   Could not fetch payment intent: ${e.message}`);
    }
  }
  
  // Also try to get description from the charge
  if (!result.description && session.payment_intent) {
    try {
      const charges = await stripe.charges.list({
        payment_intent: session.payment_intent,
        limit: 1
      });
      if (charges.data.length > 0) {
        result.description = charges.data[0].description;
        
        // Parse booking ref
        if (result.description && !result.bookingRef) {
          const refMatch = result.description.match(/\[ref:([A-Z0-9-]+)\]/);
          if (refMatch) {
            result.bookingRef = refMatch[1];
          }
        }
      }
    } catch (e) {
      console.log(`   Could not fetch charges: ${e.message}`);
    }
  }
  
  // Log what we found
  console.log(`   💳 Payment details:`);
  console.log(`      Subtotal: $${(result.subtotal / 100).toFixed(2)}`);
  console.log(`      Discount: $${(result.discountAmount / 100).toFixed(2)} (${result.discountType || 'none'})`);
  if (result.percentOff) console.log(`      Percent off: ${result.percentOff}%`);
  if (result.couponCode) console.log(`      Coupon: ${result.couponCode}`);
  console.log(`      Amount paid: $${(result.amountPaid / 100).toFixed(2)}`);
  if (result.bookingRef) console.log(`      Booking ref: ${result.bookingRef}`);
  
  return result;
}

/**
 * Extract payment info from a Charge (fallback, less detail)
 */
function extractChargeDetails(charge) {
  const result = {
    found: true,
    chargeId: charge.id,
    amountPaid: charge.amount || 0,
    subtotal: charge.amount || 0,    // Can't determine original amount from charge alone
    discountAmount: 0,
    discountType: null,
    percentOff: null,
    couponCode: null,
    description: charge.description,
    bookingRef: null,
    customerEmail: charge.billing_details?.email || charge.receipt_email,
    customerName: charge.billing_details?.name || null
  };
  
  // Parse booking ref from description
  if (result.description) {
    const refMatch = result.description.match(/\[ref:([A-Z0-9-]+)\]/);
    if (refMatch) {
      result.bookingRef = refMatch[1];
    }
  }
  
  console.log(`   💳 Charge details (limited):`);
  console.log(`      Amount: $${(result.amountPaid / 100).toFixed(2)}`);
  if (result.bookingRef) console.log(`      Booking ref: ${result.bookingRef}`);
  console.log(`      ⚠ Note: Discount details not available from charge object`);
  
  return result;
}

/**
 * Convert cents to dollars
 */
function centsToDollars(cents) {
  return cents / 100;
}

/**
 * Convert dollars to cents
 */
function dollarsToCents(dollars) {
  return Math.round(dollars * 100);
}

module.exports = {
  findPaymentByEmail,
  centsToDollars,
  dollarsToCents
};
