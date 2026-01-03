/**
 * IDS Monthly Invoice Generator
 * 
 * Pulls assessment activity from TTI IDS API for the previous month,
 * calculates billable assessments per leader, and creates QuickBooks invoices.
 * 
 * Usage:
 *   POST /api/ids-monthly-invoice?mode=dry-run     → Analyze only, no invoices
 *   POST /api/ids-monthly-invoice?mode=live        → Create actual invoices
 *   POST /api/ids-monthly-invoice?mode=dry-run&month=2024-12  → Specific month
 * 
 * Environment Variables Required:
 *   - IDS_API_KEY: TTI IDS API key
 *   - QB_* variables: QuickBooks OAuth (existing)
 *   - QB_ITEM_FULL_ASSESSMENT: QB Item ID for Full Assessment
 *   - QB_ITEM_INTERVIEW: QB Item ID for Interview Assessment
 */

import { getQBClient, findOrCreateCustomer, createInvoice } from '../lib/quickbooks.js';
import { 
  getAccountActivityReport, 
  getLinkDetails, 
  parseLeaderEmail,
  calculateBillable 
} from '../lib/ids-api.js';
import { sendBillingReport } from '../lib/email-report.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  IDS_ACCOUNT_LOGIN: 'BASLERACADEMY',
  
  // Reportview IDs
  REPORTVIEW_FULL: '6217',
  REPORTVIEW_INTERVIEW: '6217/1056',
  
  // QB Item IDs (from environment)
  QB_ITEM_FULL: process.env.QB_ITEM_FULL_ASSESSMENT || '23',
  QB_ITEM_INTERVIEW: process.env.QB_ITEM_INTERVIEW || '24',
};

// ============================================================================
// MAIN HANDLER
// ============================================================================

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const startTime = Date.now();
  const mode = req.query.mode || 'dry-run';
  const targetMonth = req.query.month || getPreviousMonth();
  
  console.log('============================================================');
  console.log('IDS MONTHLY INVOICE GENERATOR');
  console.log('============================================================');
  console.log(`Mode: ${mode.toUpperCase()}`);
  console.log(`Billing Month: ${targetMonth}`);
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('============================================================');

  // Validate mode
  if (!['dry-run', 'live'].includes(mode)) {
    return res.status(400).json({ 
      error: 'Invalid mode. Use ?mode=dry-run or ?mode=live' 
    });
  }

  try {
    // =========================================================================
    // Step 1: Get date range for billing month
    // =========================================================================
    const { startDate, endDate, billingMonth, billingYear } = parseBillingMonth(targetMonth);
    console.log(`\n📅 DATE RANGE: ${startDate} to ${endDate}`);

    // =========================================================================
    // Step 2: Pull account activity report
    // =========================================================================
    console.log('\n📊 FETCHING ACCOUNT ACTIVITY REPORT...');
    const activityReport = await getAccountActivityReport(
      CONFIG.IDS_ACCOUNT_LOGIN,
      startDate,
      endDate
    );

    if (!activityReport || !activityReport[0]?.links?.length) {
      console.log('   No activity found for this period.');
      return res.status(200).json({
        mode,
        billingMonth: targetMonth,
        message: 'No activity found',
        summary: { totalLinks: 0, totalBillable: 0 }
      });
    }

    const linksWithActivity = activityReport[0].links;
    console.log(`   Found ${linksWithActivity.length} links with activity`);
    console.log(`   Account total: ${activityReport[0].account_total} assessments`);

    // =========================================================================
    // Step 3: Process each link
    // =========================================================================
    console.log('\n🔍 PROCESSING LINKS...');
    
    const results = {
      processed: [],
      skipped: [],
      errors: []
    };

    for (const link of linksWithActivity) {
      console.log(`\n--- ${link.name} (${link.code}) ---`);
      console.log(`    Activity total: ${link.total}`);

      // Skip test and marketing links
      const linkNameLower = link.name.toLowerCase();
      if (linkNameLower.includes('test') || linkNameLower.includes('marketing')) {
        console.log(`    ⏭️ Test/Marketing link - SKIP`);
        results.skipped.push({
          link: link.code,
          name: link.name,
          reason: 'Test/Marketing link',
          total: link.total
        });
        continue;
      }

      try {
        // Get link details
        const linkDetails = await getLinkDetails(link.code);
        
        // Determine assessment type from reportview
        const reportviewId = linkDetails.reportviews?.[0]?.id || '';
        const isInterview = reportviewId.includes('/');
        const assessmentType = isInterview ? 'Interview' : 'Full';
        console.log(`    Type: ${assessmentType} Assessment (${reportviewId})`);

        // Find limit settings (record_type: 3)
        const limitSettings = linkDetails.activity_report_options?.find(
          opt => opt.record_type === 3
        );

        if (!limitSettings) {
          console.log(`    ⚠️ No limit settings found - skipping`);
          results.skipped.push({
            link: link.code,
            name: link.name,
            reason: 'No limit settings found'
          });
          continue;
        }

        // Check for hard limit
        if (limitSettings.limit === 'H') {
          console.log(`    ⏭️ Hard limit - SKIP`);
          results.skipped.push({
            link: link.code,
            name: link.name,
            reason: 'Hard limit (H)',
            total: link.total
          });
          continue;
        }

        // Calculate billable amount
        const linkCreatedAt = new Date(linkDetails.created_at);
        const linkCreatedMonth = linkCreatedAt.getMonth() + 1;
        const linkCreatedYear = linkCreatedAt.getFullYear();
        const createdInBillingMonth = (
          linkCreatedMonth === billingMonth && 
          linkCreatedYear === billingYear
        );

        const billableResult = calculateBillable({
          total: link.total,
          optionValue: limitSettings.option_value,
          createdInBillingMonth,
          isInterview
        });

        console.log(`    Created: ${linkDetails.created_at}`);
        console.log(`    Created in billing month: ${createdInBillingMonth}`);
        console.log(`    Initial allocation: ${limitSettings.option_value}`);
        console.log(`    Billable: ${billableResult.billable}`);

        if (billableResult.billable <= 0) {
          console.log(`    ⏭️ No billable assessments - SKIP`);
          results.skipped.push({
            link: link.code,
            name: link.name,
            reason: 'No billable assessments',
            total: link.total,
            allocation: limitSettings.option_value,
            calculated: billableResult.billable
          });
          continue;
        }

        // Parse leader email from cc_to
        const leaderEmail = parseLeaderEmail(linkDetails.cc_to);
        console.log(`    Leader email: ${leaderEmail || 'NOT FOUND'}`);

        if (!leaderEmail) {
          console.log(`    ⚠️ Could not determine leader email - skipping`);
          results.errors.push({
            link: link.code,
            name: link.name,
            error: 'Could not parse leader email from cc_to'
          });
          continue;
        }

        // Add to processed
        results.processed.push({
          link: link.code,
          name: link.name,
          leaderEmail,
          assessmentType,
          reportviewId,
          total: link.total,
          allocation: createdInBillingMonth ? limitSettings.option_value : 0,
          billable: billableResult.billable,
          createdAt: linkDetails.created_at,
          createdInBillingMonth
        });

        console.log(`    ✅ BILLABLE: ${billableResult.billable} ${assessmentType} assessments`);

      } catch (linkError) {
        console.error(`    ❌ Error processing link: ${linkError.message}`);
        results.errors.push({
          link: link.code,
          name: link.name,
          error: linkError.message
        });
      }
    }

    // =========================================================================
    // Step 4: Group by leader for invoicing
    // =========================================================================
    console.log('\n📋 GROUPING BY LEADER...');
    
    const leaderInvoices = groupByLeader(results.processed);
    
    for (const [email, data] of Object.entries(leaderInvoices)) {
      console.log(`\n${data.displayName} (${email}):`);
      if (data.fullAssessments > 0) {
        console.log(`   Full Assessments: ${data.fullAssessments}`);
      }
      if (data.interviewAssessments > 0) {
        console.log(`   Interview Assessments: ${data.interviewAssessments}`);
      }
    }

    // =========================================================================
    // Step 5: Create invoices (if live mode)
    // =========================================================================
    const invoiceResults = [];

    if (mode === 'live' && Object.keys(leaderInvoices).length > 0) {
      console.log('\n💰 CREATING QUICKBOOKS INVOICES...');
      
      const qb = await getQBClient();

      for (const [email, data] of Object.entries(leaderInvoices)) {
        try {
          console.log(`\n   Creating invoice for ${data.displayName}...`);

          // Find or create customer
          const customer = await findOrCreateCustomer(qb, {
            email,
            firstName: data.displayName.split(' ')[0],
            lastName: data.displayName.split(' ').slice(1).join(' ') || ''
          });

          // Build line items
          const lineItems = [];
          
          if (data.fullAssessments > 0) {
            lineItems.push({
              itemId: CONFIG.QB_ITEM_FULL,
              quantity: data.fullAssessments,
              description: `Full Assessment - Leading From Your Strengths (${targetMonth})`
            });
          }
          
          if (data.interviewAssessments > 0) {
            lineItems.push({
              itemId: CONFIG.QB_ITEM_INTERVIEW,
              quantity: data.interviewAssessments,
              description: `Interview Assessment - Leading From Your Strengths (${targetMonth})`
            });
          }

          // Build memo with link names
          const memo = `Assessment usage for ${targetMonth}: ${data.linkNames.join(', ')}`;

          // Create invoice
          const invoice = await createInvoice(qb, {
            customerId: customer.Id,
            lineItems,
            memo,
            dueDate: calculateDueDate(30)
          });

          console.log(`   ✅ Invoice #${invoice.DocNumber} created - $${invoice.TotalAmt}`);
          
          invoiceResults.push({
            email,
            name: data.displayName,
            invoiceId: invoice.Id,
            invoiceNumber: invoice.DocNumber,
            total: invoice.TotalAmt,
            status: 'created'
          });

        } catch (invoiceError) {
          console.error(`   ❌ Invoice error: ${invoiceError.message}`);
          invoiceResults.push({
            email,
            name: data.displayName,
            error: invoiceError.message,
            status: 'failed'
          });
        }
      }
    } else if (mode === 'dry-run') {
      console.log('\n🧪 DRY RUN - No invoices created');
      console.log('   Run with ?mode=live to create actual invoices');
    }

    // =========================================================================
    // Step 6: Build response
    // =========================================================================
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    const response = {
      mode,
      billingMonth: targetMonth,
      dateRange: { startDate, endDate },
      duration: `${duration}s`,
      summary: {
        linksWithActivity: linksWithActivity.length,
        linksProcessed: results.processed.length,
        linksSkipped: results.skipped.length,
        linksErrored: results.errors.length,
        totalFullAssessments: results.processed
          .filter(p => p.assessmentType === 'Full')
          .reduce((sum, p) => sum + p.billable, 0),
        totalInterviewAssessments: results.processed
          .filter(p => p.assessmentType === 'Interview')
          .reduce((sum, p) => sum + p.billable, 0),
        uniqueLeaders: Object.keys(leaderInvoices).length
      },
      leaderInvoices: Object.entries(leaderInvoices).map(([email, data]) => ({
        email,
        displayName: data.displayName,
        fullAssessments: data.fullAssessments,
        interviewAssessments: data.interviewAssessments,
        links: data.linkNames
      })),
      details: {
        processed: results.processed,
        skipped: results.skipped,
        errors: results.errors
      },
      invoices: mode === 'live' ? invoiceResults : 'DRY RUN - No invoices created'
    };

    console.log('\n============================================================');
    console.log('SUMMARY');
    console.log('============================================================');
    console.log(`Links with activity: ${response.summary.linksWithActivity}`);
    console.log(`Links processed: ${response.summary.linksProcessed}`);
    console.log(`Links skipped: ${response.summary.linksSkipped}`);
    console.log(`Links errored: ${response.summary.linksErrored}`);
    console.log(`Total Full Assessments billable: ${response.summary.totalFullAssessments}`);
    console.log(`Total Interview Assessments billable: ${response.summary.totalInterviewAssessments}`);
    console.log(`Unique leaders: ${response.summary.uniqueLeaders}`);
    console.log(`Duration: ${duration}s`);
    console.log('============================================================');

    // =========================================================================
    // Step 7: Send email report to billing
    // =========================================================================
    let emailResult = null;
    try {
      emailResult = await sendBillingReport(response);
      response.emailReport = emailResult;
    } catch (emailError) {
      console.error(`\n❌ Email report failed: ${emailError.message}`);
      response.emailReport = { success: false, error: emailError.message };
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('\n❌ FATAL ERROR:', error);
    return res.status(500).json({
      error: 'Invoice generation failed',
      message: error.message,
      mode,
      billingMonth: targetMonth
    });
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get previous month in YYYY-MM format
 */
function getPreviousMonth() {
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Parse billing month string into date range
 */
function parseBillingMonth(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  
  // First day of month
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  
  // Last day of month
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
  
  return {
    startDate,
    endDate,
    billingMonth: month,
    billingYear: year
  };
}

/**
 * Group processed links by leader email for invoicing
 */
function groupByLeader(processedLinks) {
  const grouped = {};

  for (const link of processedLinks) {
    const email = link.leaderEmail.toLowerCase();
    
    if (!grouped[email]) {
      grouped[email] = {
        displayName: link.name.replace(' Interview Assessment', '').trim(),
        fullAssessments: 0,
        interviewAssessments: 0,
        linkNames: []
      };
    }

    if (link.assessmentType === 'Interview') {
      grouped[email].interviewAssessments += link.billable;
    } else {
      grouped[email].fullAssessments += link.billable;
    }

    grouped[email].linkNames.push(link.name);
  }

  return grouped;
}

/**
 * Calculate due date N days from now
 */
function calculateDueDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}
