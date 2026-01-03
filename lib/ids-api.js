/**
 * IDS API Helper Library
 * 
 * Utilities for interacting with TTI IDS API
 * Base URL: https://api.justrespond.com/api/v3
 */

const IDS_API_BASE = 'https://api.justrespond.com/api/v3';

/**
 * Get the IDS API key from environment
 */
function getApiKey() {
  const key = process.env.IDS_API_KEY;
  if (!key) {
    throw new Error('IDS_API_KEY environment variable not set');
  }
  return key;
}

/**
 * Make an authenticated request to IDS API
 */
async function idsRequest(endpoint, options = {}) {
  const url = `${IDS_API_BASE}${endpoint}`;
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': getApiKey(),
      'Content-Type': 'application/json',
      ...options.headers
    },
    redirect: 'follow' // Important: follow 302 redirects
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`IDS API error (${response.status}): ${errorText}`);
  }

  // Check if response is JSON
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  
  return response.text();
}

/**
 * Get account-level activity report
 * 
 * @param {string} accountLogin - Account login (e.g., 'BASLERACADEMY')
 * @param {string} startDate - Start date in YYYY-MM-DD format
 * @param {string} endDate - End date in YYYY-MM-DD format
 * @returns {Promise<Array>} Activity report data
 */
export async function getAccountActivityReport(accountLogin, startDate, endDate) {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    account_login: accountLogin
  });

  console.log(`   GET /accounts/activity_report?${params}`);
  
  const data = await idsRequest(`/accounts/activity_report?${params}`);
  
  // Response may be a string if redirected to a file - parse it
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (e) {
      console.error('Failed to parse activity report response:', data.substring(0, 200));
      throw new Error('Invalid activity report response format');
    }
  }
  
  return data;
}

/**
 * Get detailed information about a specific link
 * 
 * @param {string} linkCode - Link login code (e.g., '123432EGW')
 * @returns {Promise<Object>} Link details including activity_report_options
 */
export async function getLinkDetails(linkCode) {
  console.log(`   GET /links/${linkCode}`);
  return idsRequest(`/links/${linkCode}`);
}

/**
 * Get link-level activity report
 * 
 * @param {string} linkCode - Link login code
 * @param {string} startDate - Start date in YYYY-MM-DD format
 * @param {string} endDate - End date in YYYY-MM-DD format
 * @returns {Promise<Object>} Link activity report
 */
export async function getLinkActivityReport(linkCode, startDate, endDate) {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate
  });

  console.log(`   GET /links/${linkCode}/activity_report?${params}`);
  return idsRequest(`/links/${linkCode}/activity_report?${params}`);
}

/**
 * Parse leader email from cc_to field
 * 
 * The cc_to field may contain multiple emails separated by commas/newlines.
 * We want to extract the leader's email (not admin@basleracademy.com)
 * 
 * @param {string} ccTo - The cc_to field value
 * @returns {string|null} Leader email or null if not found
 */
export function parseLeaderEmail(ccTo) {
  if (!ccTo) return null;

  // Split by comma, newline, or both
  const emails = ccTo
    .split(/[,\r\n]+/)
    .map(e => e.trim().toLowerCase())
    .filter(e => e && e.includes('@'));

  // Filter out admin email
  const adminEmails = ['admin@basleracademy.com'];
  const leaderEmails = emails.filter(e => !adminEmails.includes(e));

  // Return first non-admin email
  return leaderEmails[0] || null;
}

/**
 * Calculate billable assessments
 * 
 * @param {Object} params
 * @param {number} params.total - Total assessments used
 * @param {number} params.optionValue - Initial allocation (option_value from record_type 3)
 * @param {boolean} params.createdInBillingMonth - Whether link was created in the billing month
 * @param {boolean} params.isInterview - Whether this is an interview link
 * @returns {Object} { billable, calculation }
 */
export function calculateBillable({ total, optionValue, createdInBillingMonth, isInterview }) {
  // Interview links: always bill full amount (no allocation)
  if (isInterview) {
    return {
      billable: total,
      calculation: `Interview: ${total} total, no allocation`
    };
  }

  // Full assessment links
  if (createdInBillingMonth) {
    // Subtract initial allocation for links created this month
    const billable = Math.max(0, total - optionValue);
    return {
      billable,
      calculation: `Created this month: ${total} - ${optionValue} allocation = ${billable}`
    };
  } else {
    // No allocation for links created in previous months
    return {
      billable: total,
      calculation: `Existing link: ${total} total, allocation already used`
    };
  }
}

/**
 * Determine assessment type from reportview ID
 * 
 * @param {string} reportviewId - The reportview ID (e.g., '6217' or '6217/1056')
 * @returns {Object} { type, isInterview }
 */
export function getAssessmentType(reportviewId) {
  const isInterview = reportviewId && reportviewId.includes('/');
  return {
    type: isInterview ? 'Interview' : 'Full',
    isInterview
  };
}

export default {
  getAccountActivityReport,
  getLinkDetails,
  getLinkActivityReport,
  parseLeaderEmail,
  calculateBillable,
  getAssessmentType
};
