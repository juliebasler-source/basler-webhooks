/**
 * YCBM Webhook Payload Parser
 * 
 * @version 1.1.0
 * @description Parse and validate YouCanBookMe webhook payloads
 * @lastUpdated 2025-01-02
 * 
 * CHANGELOG v1.1.0:
 * - Changed to CommonJS syntax for Vercel compatibility
 * 
 * EXPECTED PAYLOAD:
 * {
 *   "source": "ycbm",
 *   "bookingId": "fd971df7-7b65-435e-a568-629b7e0d858c",
 *   "firstName": "Test",
 *   "lastName": "User",
 *   "email": "test@example.com",
 *   "phone": "+14802064580",
 *   "additionalTeamMembers": "3",
 *   "appointmentType": "60 Minute Phase 1 - Leader Only",
 *   "price": "$ 1,750.00",
 *   "startDate": "2025-12-31T07:00:00-07:00",
 *   "endDate": "2025-12-31T08:00:00-07:00",
 *   "timeZone": "US/Mountain",
 *   "bookingStatus": "UPCOMING",
 *   "bookingRef": "GJPA-YYBP-QMUT"
 * }
 */

/**
 * Parse and validate YCBM webhook payload
 * 
 * @param {Object} payload - Raw webhook payload from YCBM
 * @returns {Object} Normalized booking data
 * @throws {Error} If required fields are missing
 */
function parseYCBMPayload(payload) {
  // Validate source
  if (payload.source !== 'ycbm') {
    console.warn('Warning: Payload source is not "ycbm":', payload.source);
  }

  // Validate required fields
  const required = ['firstName', 'lastName', 'email'];
  const missing = required.filter(field => !payload[field]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }

  // Parse and normalize the data
  return {
    // Booking identification
    bookingId: payload.bookingId || null,
    bookingRef: payload.bookingRef || null,
    bookingStatus: payload.bookingStatus || 'UPCOMING',
    
    // Customer info
    firstName: normalizeString(payload.firstName),
    lastName: normalizeString(payload.lastName),
    email: payload.email.toLowerCase().trim(),
    phone: normalizePhone(payload.phone),
    
    // Booking details
    appointmentType: payload.appointmentType || '',
    additionalTeamMembers: parseAdditionalMembers(payload.additionalTeamMembers),
    basePrice: parsePrice(payload.price),
    
    // Dates
    startDate: payload.startDate ? new Date(payload.startDate) : null,
    endDate: payload.endDate ? new Date(payload.endDate) : null,
    timeZone: payload.timeZone || 'America/New_York',
    
    // Raw payload for debugging
    _raw: payload
  };
}

/**
 * Parse price string to number
 * Handles formats: "$ 1,750.00", "$1750", "1750.00", etc.
 * 
 * @param {string} priceStr - Price string from YCBM
 * @returns {number} Price as decimal number
 */
function parsePrice(priceStr) {
  if (!priceStr) return 0;
  
  // Remove currency symbols, spaces, and commas
  const cleaned = String(priceStr)
    .replace(/[$€£¥]/g, '')
    .replace(/,/g, '')
    .replace(/\s/g, '')
    .trim();
  
  const parsed = parseFloat(cleaned);
  
  if (isNaN(parsed)) {
    console.warn(`Could not parse price: "${priceStr}"`);
    return 0;
  }
  
  return parsed;
}

/**
 * Parse additional team members field
 * Handles: "3", "0", "", null, undefined
 * 
 * @param {string|number} value - Additional members value from YCBM
 * @returns {number} Number of additional team members (0 or more)
 */
function parseAdditionalMembers(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  
  const parsed = parseInt(String(value), 10);
  
  if (isNaN(parsed) || parsed < 0) {
    return 0;
  }
  
  return parsed;
}

/**
 * Normalize string (trim, capitalize properly)
 * 
 * @param {string} str - Input string
 * @returns {string} Normalized string
 */
function normalizeString(str) {
  if (!str) return '';
  
  return String(str)
    .trim()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Normalize phone number
 * 
 * @param {string} phone - Phone number string
 * @returns {string} Cleaned phone number
 */
function normalizePhone(phone) {
  if (!phone) return '';
  
  // Keep only digits and leading +
  return String(phone).trim();
}

/**
 * Validate booking is processable
 * Returns array of validation errors (empty = valid)
 * 
 * @param {Object} booking - Parsed booking data
 * @returns {string[]} Array of error messages
 */
function validateBooking(booking) {
  const errors = [];
  
  if (!booking.email || !isValidEmail(booking.email)) {
    errors.push('Invalid or missing email address');
  }
  
  if (!booking.firstName) {
    errors.push('Missing first name');
  }
  
  if (!booking.lastName) {
    errors.push('Missing last name');
  }
  
  if (booking.bookingStatus === 'CANCELLED') {
    errors.push('Booking is cancelled');
  }
  
  return errors;
}

/**
 * Simple email validation
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Check if booking is a Phase 1 booking
 * 
 * @param {Object} booking - Parsed booking data
 * @returns {boolean}
 */
function isPhase1Booking(booking) {
  const type = (booking.appointmentType || '').toLowerCase();
  return type.includes('phase 1') || type.includes('phase1');
}

/**
 * Check if booking is a Phase 2 booking
 * 
 * @param {Object} booking - Parsed booking data
 * @returns {boolean}
 */
function isPhase2Booking(booking) {
  const type = (booking.appointmentType || '').toLowerCase();
  return type.includes('phase 2') || type.includes('phase2');
}

// CommonJS exports
module.exports = {
  parseYCBMPayload,
  validateBooking,
  isPhase1Booking,
  isPhase2Booking
};
