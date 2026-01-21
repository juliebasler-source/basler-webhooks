/**
 * List QuickBooks Items
 * 
 * GET /api/qb-items
 * 
 * Lists all products/services in QuickBooks so you can find the correct Item IDs.
 */

import { getQBClient } from '../lib/quickbooks.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  try {
    console.log('🔍 Fetching QuickBooks Items...');
    
    const qb = await getQBClient();

    // Query all items (products and services)
    const items = await new Promise((resolve, reject) => {
      qb.findItems({
        fetchAll: true
      }, (err, result) => {
        if (err) {
          reject(new Error(`Failed to fetch items: ${JSON.stringify(err)}`));
        } else {
          resolve(result?.QueryResponse?.Item || []);
        }
      });
    });

    console.log(`   Found ${items.length} items`);

    // Format for easy reading
    const formattedItems = items.map(item => ({
      id: item.Id,
      name: item.Name,
      type: item.Type,
      unitPrice: item.UnitPrice || 0,
      description: item.Description || '',
      active: item.Active
    }));

    // Sort by name
    formattedItems.sort((a, b) => a.name.localeCompare(b.name));

    // Also provide a quick lookup for assessment-related items
    const assessmentItems = formattedItems.filter(item => 
      item.name.toLowerCase().includes('assessment') ||
      item.name.toLowerCase().includes('lfys') ||
      item.name.toLowerCase().includes('strengths') ||
      item.name.toLowerCase().includes('leading')
    );

    return res.status(200).json({
      totalItems: items.length,
      assessmentRelated: assessmentItems,
      allItems: formattedItems,
      instructions: {
        step1: "Find your Full Assessment item in the list above",
        step2: "Note its 'id' value",
        step3: "Update QB_ITEM_FULL_ASSESSMENT in Vercel to that ID",
        step4: "Do the same for QB_ITEM_INTERVIEW",
        step5: "Redeploy"
      },
      currentConfig: {
        QB_ITEM_FULL_ASSESSMENT: process.env.QB_ITEM_FULL_ASSESSMENT || 'not set',
        QB_ITEM_INTERVIEW: process.env.QB_ITEM_INTERVIEW || 'not set'
      }
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch QuickBooks items',
      message: error.message
    });
  }
}
