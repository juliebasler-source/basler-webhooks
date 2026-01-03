/**
 * Email Report Module
 * 
 * Sends billing reports via Gmail SMTP using Nodemailer
 * 
 * Required Environment Variables:
 *   GMAIL_USER - Email address to send from
 *   GMAIL_APP_PASSWORD - Google App Password (not regular password)
 *   BILLING_EMAIL - Recipient email address
 */

import nodemailer from 'nodemailer';

// ============================================================================
// CONFIGURATION
// ============================================================================

function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD environment variables required');
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * Send billing report email
 * 
 * @param {Object} reportData - The full response from ids-monthly-invoice
 * @returns {Promise<Object>} Send result
 */
export async function sendBillingReport(reportData) {
  const transporter = getTransporter();
  const billingEmail = process.env.BILLING_EMAIL || 'billing@basleracademy.com';
  const fromEmail = process.env.GMAIL_USER;

  const { subject, html, text } = buildEmailContent(reportData);
  const csv = buildCSVAttachment(reportData);

  const mailOptions = {
    from: `"Basler Academy Billing" <${fromEmail}>`,
    to: billingEmail,
    subject,
    text,
    html,
    attachments: [
      {
        filename: `assessment-billing-${reportData.billingMonth}.csv`,
        content: csv,
        contentType: 'text/csv'
      }
    ]
  };

  console.log(`\n📧 SENDING BILLING REPORT TO ${billingEmail}...`);
  
  try {
    const result = await transporter.sendMail(mailOptions);
    console.log(`   ✅ Email sent: ${result.messageId}`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error(`   ❌ Email failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// EMAIL CONTENT BUILDERS
// ============================================================================

/**
 * Build email subject, HTML, and text content
 */
function buildEmailContent(data) {
  const { mode, billingMonth, summary, leaderInvoices, details, invoices, duration } = data;
  const isDryRun = mode === 'dry-run';
  const modeLabel = isDryRun ? '🧪 DRY RUN' : '✅ LIVE';
  
  // Calculate totals
  const totalAmount = calculateTotalAmount(invoices, isDryRun);
  
  const subject = `${isDryRun ? '[DRY RUN] ' : ''}IDS Assessment Billing Report - ${formatMonth(billingMonth)}`;

  // Build HTML email
  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 800px; margin: 0 auto; padding: 20px; }
    .header { background: ${isDryRun ? '#f0ad4e' : '#5cb85c'}; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
    .header h1 { margin: 0; font-size: 24px; }
    .header .mode { font-size: 14px; opacity: 0.9; }
    .content { background: #f9f9f9; padding: 20px; border: 1px solid #ddd; }
    .summary-box { background: white; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid ${isDryRun ? '#f0ad4e' : '#5cb85c'}; }
    .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; }
    .stat { text-align: center; }
    .stat-value { font-size: 28px; font-weight: bold; color: #333; }
    .stat-label { font-size: 12px; color: #666; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; background: white; }
    th { background: #f5f5f5; padding: 12px; text-align: left; border-bottom: 2px solid #ddd; font-size: 12px; text-transform: uppercase; }
    td { padding: 12px; border-bottom: 1px solid #eee; }
    tr:hover { background: #f9f9f9; }
    .section-title { font-size: 16px; font-weight: bold; margin: 25px 0 10px 0; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 5px; }
    .skip-reason { color: #666; font-style: italic; }
    .error { color: #d9534f; }
    .footer { font-size: 12px; color: #999; margin-top: 20px; padding-top: 15px; border-top: 1px solid #ddd; }
    .dry-run-banner { background: #fcf8e3; border: 1px solid #f0ad4e; color: #8a6d3b; padding: 10px 15px; border-radius: 5px; margin-bottom: 20px; }
    .amount { font-family: monospace; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Assessment Billing Report</h1>
      <div class="mode">${modeLabel} • ${formatMonth(billingMonth)} • Generated ${formatDateTime(new Date())}</div>
    </div>
    
    <div class="content">
      ${isDryRun ? `
      <div class="dry-run-banner">
        <strong>🧪 This is a DRY RUN</strong> - No invoices were created. Review this report and run with <code>?mode=live</code> to create actual invoices.
      </div>
      ` : ''}
      
      <div class="summary-box">
        <div class="summary-grid">
          <div class="stat">
            <div class="stat-value">${isDryRun ? summary.uniqueLeaders : (Array.isArray(invoices) ? invoices.filter(i => i.status === 'created').length : 0)}</div>
            <div class="stat-label">${isDryRun ? 'Leaders to Invoice' : 'Invoices Created'}</div>
          </div>
          <div class="stat">
            <div class="stat-value">${summary.totalFullAssessments + summary.totalInterviewAssessments}</div>
            <div class="stat-label">Total Assessments</div>
          </div>
          <div class="stat">
            <div class="stat-value">${isDryRun ? 'TBD' : '$' + totalAmount}</div>
            <div class="stat-label">Total Amount</div>
          </div>
        </div>
      </div>
      
      <div class="summary-box" style="border-left-color: #5bc0de;">
        <div class="summary-grid">
          <div class="stat">
            <div class="stat-value">${summary.totalFullAssessments}</div>
            <div class="stat-label">Full Assessments</div>
          </div>
          <div class="stat">
            <div class="stat-value">${summary.totalInterviewAssessments}</div>
            <div class="stat-label">Interview Assessments</div>
          </div>
          <div class="stat">
            <div class="stat-value">${summary.linksWithActivity}</div>
            <div class="stat-label">Links with Activity</div>
          </div>
        </div>
      </div>

      ${leaderInvoices && leaderInvoices.length > 0 ? `
      <div class="section-title">${isDryRun ? 'Invoices to Create' : 'Invoices Created'}</div>
      <table>
        <thead>
          <tr>
            <th>Leader</th>
            <th>Email</th>
            <th style="text-align:center">Full</th>
            <th style="text-align:center">Interview</th>
            ${!isDryRun ? '<th>Invoice #</th><th style="text-align:right">Amount</th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${leaderInvoices.map((leader, idx) => {
            const invoice = !isDryRun && Array.isArray(invoices) ? invoices[idx] : null;
            return `
            <tr>
              <td><strong>${leader.displayName}</strong></td>
              <td>${leader.email}</td>
              <td style="text-align:center">${leader.fullAssessments || 0}</td>
              <td style="text-align:center">${leader.interviewAssessments || 0}</td>
              ${!isDryRun ? `
                <td>${invoice?.invoiceNumber || invoice?.error || '-'}</td>
                <td style="text-align:right" class="amount">${invoice?.total ? '$' + invoice.total : '-'}</td>
              ` : ''}
            </tr>
            `;
          }).join('')}
        </tbody>
      </table>
      ` : '<p>No invoices to create for this period.</p>'}

      ${details.skipped && details.skipped.length > 0 ? `
      <div class="section-title">Skipped Links (${details.skipped.length})</div>
      <table>
        <thead>
          <tr>
            <th>Link</th>
            <th>Code</th>
            <th>Reason</th>
            <th style="text-align:center">Activity</th>
          </tr>
        </thead>
        <tbody>
          ${details.skipped.map(skip => `
          <tr>
            <td>${skip.name}</td>
            <td><code>${skip.link}</code></td>
            <td class="skip-reason">${skip.reason}</td>
            <td style="text-align:center">${skip.total || '-'}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
      ` : ''}

      ${details.errors && details.errors.length > 0 ? `
      <div class="section-title">⚠️ Errors (${details.errors.length})</div>
      <table>
        <thead>
          <tr>
            <th>Link</th>
            <th>Code</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          ${details.errors.map(err => `
          <tr>
            <td>${err.name}</td>
            <td><code>${err.link}</code></td>
            <td class="error">${err.error}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
      ` : ''}

      <div class="footer">
        <p>
          <strong>Processing Details:</strong> 
          ${summary.linksProcessed} processed, 
          ${summary.linksSkipped} skipped, 
          ${summary.linksErrored} errors • 
          Duration: ${duration}
        </p>
        <p>This report was automatically generated by the Basler Academy billing system.</p>
      </div>
    </div>
  </div>
</body>
</html>
  `;

  // Plain text version
  const text = `
BASLER ACADEMY ASSESSMENT BILLING REPORT
========================================
${modeLabel}
Period: ${formatMonth(billingMonth)}
Generated: ${formatDateTime(new Date())}

${isDryRun ? '⚠️  THIS IS A DRY RUN - No invoices were created.\n' : ''}

SUMMARY
-------
${isDryRun ? 'Leaders to Invoice' : 'Invoices Created'}: ${isDryRun ? summary.uniqueLeaders : (Array.isArray(invoices) ? invoices.filter(i => i.status === 'created').length : 0)}
Total Assessments: ${summary.totalFullAssessments + summary.totalInterviewAssessments}
  - Full Assessments: ${summary.totalFullAssessments}
  - Interview Assessments: ${summary.totalInterviewAssessments}
${!isDryRun ? `Total Amount: $${totalAmount}` : ''}

${leaderInvoices && leaderInvoices.length > 0 ? `
${isDryRun ? 'INVOICES TO CREATE' : 'INVOICES CREATED'}
-------------------
${leaderInvoices.map((leader, idx) => {
  const invoice = !isDryRun && Array.isArray(invoices) ? invoices[idx] : null;
  return `• ${leader.displayName} (${leader.email})
    Full: ${leader.fullAssessments || 0}, Interview: ${leader.interviewAssessments || 0}${!isDryRun && invoice ? `
    Invoice #${invoice.invoiceNumber || 'N/A'}: $${invoice.total || '0'}` : ''}`;
}).join('\n')}
` : 'No invoices to create for this period.'}

${details.skipped && details.skipped.length > 0 ? `
SKIPPED LINKS
-------------
${details.skipped.map(s => `• ${s.name} (${s.link}): ${s.reason}`).join('\n')}
` : ''}

${details.errors && details.errors.length > 0 ? `
ERRORS
------
${details.errors.map(e => `• ${e.name} (${e.link}): ${e.error}`).join('\n')}
` : ''}

---
Processing: ${summary.linksProcessed} processed, ${summary.linksSkipped} skipped, ${summary.linksErrored} errors
Duration: ${duration}
  `;

  return { subject, html, text };
}

/**
 * Build CSV attachment content
 */
function buildCSVAttachment(data) {
  const { billingMonth, details, leaderInvoices, invoices, mode } = data;
  const isDryRun = mode === 'dry-run';
  
  const rows = [
    ['Basler Academy Assessment Billing Report'],
    [`Period: ${billingMonth}`],
    [`Mode: ${mode.toUpperCase()}`],
    [`Generated: ${new Date().toISOString()}`],
    [],
    ['PROCESSED LINKS'],
    ['Link Name', 'Code', 'Type', 'Leader Email', 'Total', 'Allocation', 'Billable', 'Created Date', 'Created This Month'],
  ];

  // Add processed links
  if (details.processed) {
    for (const p of details.processed) {
      rows.push([
        p.name,
        p.link,
        p.assessmentType,
        p.leaderEmail,
        p.total,
        p.allocation,
        p.billable,
        p.createdAt,
        p.createdInBillingMonth ? 'Yes' : 'No'
      ]);
    }
  }

  rows.push([]);
  rows.push(['SKIPPED LINKS']);
  rows.push(['Link Name', 'Code', 'Reason', 'Total', 'Allocation']);

  // Add skipped links
  if (details.skipped) {
    for (const s of details.skipped) {
      rows.push([
        s.name,
        s.link,
        s.reason,
        s.total || '',
        s.allocation || ''
      ]);
    }
  }

  rows.push([]);
  rows.push(['INVOICE SUMMARY']);
  rows.push(['Leader', 'Email', 'Full Assessments', 'Interview Assessments', 'Invoice #', 'Amount']);

  // Add invoice summary
  if (leaderInvoices) {
    leaderInvoices.forEach((leader, idx) => {
      const invoice = !isDryRun && Array.isArray(invoices) ? invoices[idx] : null;
      rows.push([
        leader.displayName,
        leader.email,
        leader.fullAssessments || 0,
        leader.interviewAssessments || 0,
        invoice?.invoiceNumber || (isDryRun ? 'DRY RUN' : 'N/A'),
        invoice?.total || ''
      ]);
    });
  }

  // Convert to CSV
  return rows.map(row => 
    row.map(cell => {
      const str = String(cell ?? '');
      // Escape quotes and wrap in quotes if contains comma or quote
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(',')
  ).join('\n');
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function formatMonth(monthStr) {
  const [year, month] = monthStr.split('-');
  const date = new Date(year, month - 1);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatDateTime(date) {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  });
}

function calculateTotalAmount(invoices, isDryRun) {
  if (isDryRun || !Array.isArray(invoices)) return '0.00';
  
  const total = invoices
    .filter(i => i.status === 'created' && i.total)
    .reduce((sum, i) => sum + parseFloat(i.total), 0);
  
  return total.toFixed(2);
}

export default { sendBillingReport };
