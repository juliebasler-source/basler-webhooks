import { QuickBooksClient } from '../lib/quickbooks.js';

export default async function handler(req, res) {
  try {
    const qb = new QuickBooksClient();
    await qb.initialize();
    
    const items = await qb.listItems();
    
    return res.status(200).json({
      count: items.length,
      items: items.map(item => ({
        Id: item.Id,
        Name: item.Name,
        Type: item.Type,
        Active: item.Active
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
