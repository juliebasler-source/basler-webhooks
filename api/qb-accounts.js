/**
 * List QuickBooks Chart of Accounts
 *
 * GET /api/qb-accounts
 * GET /api/qb-accounts?type=Bank
 * GET /api/qb-accounts?type=Expense
 *
 * Lists accounts in QuickBooks so you can find IDs for:
 *   - The Stripe clearing Bank account (currently QB_DEPOSIT_ACCOUNT, default 154)
 *   - The Stripe Fees Expense account (for the upcoming QB_ACCOUNT_STRIPE_FEES env var)
 *
 * Optional ?type= filter matches AccountType (e.g. Bank, Expense, Income, Equity).
 */

import { getQBClient } from '../lib/quickbooks.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  try {
    const filterType = req.query?.type || null;

    console.log('🔍 Fetching QuickBooks Chart of Accounts...');
    if (filterType) console.log(`   Filtering by AccountType=${filterType}`);

    const qb = await getQBClient();

    const accounts = await new Promise((resolve, reject) => {
      qb.findAccounts({ fetchAll: true }, (err, result) => {
        if (err) {
          reject(new Error(`Failed to fetch accounts: ${JSON.stringify(err)}`));
        } else {
          resolve(result?.QueryResponse?.Account || []);
        }
      });
    });

    console.log(`   Found ${accounts.length} accounts`);

    const formatted = accounts
      .filter(a => !filterType || a.AccountType === filterType)
      .map(a => ({
        id: a.Id,
        name: a.Name,
        fullyQualifiedName: a.FullyQualifiedName,
        accountType: a.AccountType,
        accountSubType: a.AccountSubType,
        classification: a.Classification,
        currentBalance: a.CurrentBalance,
        currency: a.CurrencyRef?.value,
        active: a.Active
      }))
      .sort((a, b) => {
        if (a.accountType !== b.accountType) {
          return a.accountType.localeCompare(b.accountType);
        }
        return a.name.localeCompare(b.name);
      });

    // Highlight the accounts most relevant to the Stripe-fees JE work
    const currentDepositAccountId = process.env.QB_DEPOSIT_ACCOUNT || '154';
    const depositAccount = formatted.find(a => String(a.id) === String(currentDepositAccountId));

    const stripeRelated = formatted.filter(a => {
      const n = a.name.toLowerCase();
      return n.includes('stripe') || n.includes('merchant') || n.includes('clearing');
    });

    const feeCandidates = formatted.filter(a => {
      const n = a.name.toLowerCase();
      return a.accountType === 'Expense' && (
        n.includes('fee') || n.includes('processing') || n.includes('merchant') || n.includes('bank charge')
      );
    });

    return res.status(200).json({
      totalAccounts: accounts.length,
      returned: formatted.length,
      filter: filterType,
      currentConfig: {
        QB_DEPOSIT_ACCOUNT: currentDepositAccountId,
        QB_DEPOSIT_ACCOUNT_resolved: depositAccount || 'NOT FOUND in chart of accounts',
        QB_ACCOUNT_STRIPE_FEES: process.env.QB_ACCOUNT_STRIPE_FEES || 'not set'
      },
      stripeRelated,
      feeExpenseCandidates: feeCandidates,
      allAccounts: formatted
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch QuickBooks accounts',
      message: error.message
    });
  }
}
