/**
 * YCBM Payload Parser
 * 
 * @version 1.1.1
 * @description Parse YouCanBookMe webhook payloads
 * @lastUpdated 2025-01-02
 * 
 * CHANGELOG v1.1.1:
 * - Fixed ES module syntax (export instead of module.exports)
 */

/**
 * Parse YCBM webhook payload into standardized format
 * 
 * @param {Object} payload - Raw YCBM webhook payload
 * @returns {Object} Parsed booking data
 */
export function parseYCBMPayload(payload) {
  // Parse additional team members (comes as string from YCBM)
  let additionalTeamMembers = 0;
  if (payload.additionalTeamMembers) {
    const parsed = parseInt(payload.additionalTeamMembers, 10);
    if (!isNaN(parsed) && parsed > 0) {
      additionalTeamMembers = parsed;
    }
  }
  
  return {
    // Customer info
    firstName: payload.firstName || '',
    lastName: payload.lastName || '',
    fullName: `${payload.firstName || ''} ${payload.lastName || ''}`.trim(),
    email: payload.email || '',
    phone: payload.phone || '',
    
    // Booking details
    bookingId: payload.bookingId || '',
    bookingRef: payload.bookingRef || '',
    appointmentType: payload.appointmentType || '',
    
    // Pricing
    price: parseFloat(payload.price) || 0,
    additionalTeamMembers: additionalTeamMembers,
    
    // Schedule
    startDate: payload.startDate || '',
    endDate: payload.endDate || '',
    timeZone: payload.timeZone || '',
    
    // Status
    bookingStatus: payload.bookingStatus || ''
  };
}
