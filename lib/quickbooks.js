/**
 * QuickBooks Online API Client
 * 
 * Handles OAuth 2.0 authentication and API calls to QuickBooks.
 * 
 * SETUP REQUIRED:
 * 1. Create app at developer.intuit.com
 * 2. Complete OAuth flow to get refresh token
 * 3. Set environment variables (see .env.example)
 * 
 * @version 1.0.0
 */

const QB_API_BASE = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com'
};

const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

export class QuickBooksClient {
  constructor() {
    this.clientId = process.env.QB_CLIENT_ID;
    this.clientSecret = process.env.QB_CLIENT_SECRET;
    this.refreshToken = process.env.QB_REFRESH_TOKEN;
    this.realmId = process.env.QB_REALM_ID;
    this.environment = process.env.QB_ENVIRONMENT || 'sandbox';
    
    this.accessToken = null;
    this.baseUrl = QB_API_BASE[this.environment];
  }

  /**
   * Initialize client and get access token
   */
  async initialize() {
    this.validateConfig();
    await this.refreshAccessToken();
    console.log(`✓ QuickBooks client initialized (${this.environment})`);
  }

  /**
   * Validate required configuration
   */
  validateConfig() {
    const required = ['clientId', 'clientSecret', 'refreshToken', 'realmId'];
    const missing = required.filter(key => !this[key]);
    
    if (missing.length > 0) {
      throw new Error(`Missing QuickBooks config: ${missing.join(', ')}. Check environment variables.`);
    }
  }

  /**
   * Refresh OAuth access token
   * QuickBooks tokens expire after 1 hour
   */
  async refreshAccessToken() {
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    
    const response = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to refresh QB token: ${error}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    
    // Note: In production, you'd want to save the new refresh_token
    // as it rotates with each refresh. For now, we log a warning.
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      console.warn('⚠ QB refresh token rotated - update QB_REFRESH_TOKEN env var');
      console.warn(`  New token: ${data.refresh_token.substring(0, 20)}...`);
    }
  }

  /**
   * Make authenticated API request to QuickBooks
   */
  async apiRequest(method, endpoint, body = null) {
    const url = `${this.baseUrl}/v3/company/${this.realmId}${endpoint}`;
    
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    
    // Handle token expiration
    if (response.status === 401) {
      console.log('Token expired, refreshing...');
      await this.refreshAccessToken();
      return this.apiRequest(method, endpoint, body);
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`QB API error (${response.status}): ${error}`);
    }

    return response.json();
  }

  /**
   * Query QuickBooks using SQL-like syntax
   */
  async query(sql) {
    const encoded = encodeURIComponent(sql);
    const result = await this.apiRequest('GET', `/query?query=${encoded}`);
    return result.QueryResponse;
  }

  // ──────────────────────────────────────────────────────────
  // CUSTOMER OPERATIONS
  // ──────────────────────────────────────────────────────────

  /**
   * Find customer by email
   */
  async findCustomerByEmail(email) {
    const sql = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email}'`;
    const result = await this.query(sql);
    return result.Customer?.[0] || null;
  }

  /**
   * Find customer by display name
   */
  async findCustomerByName(displayName) {
    const sql = `SELECT * FROM Customer WHERE DisplayName = '${displayName}'`;
    const result = await this.query(sql);
    return result.Customer?.[0] || null;
  }

  /**
   * Create new customer
   */
  async createCustomer(customerData) {
    const qbCustomer = {
      DisplayName: customerData.displayName,
      PrimaryEmailAddr: { Address: customerData.email },
      CompanyName: customerData.company || null,
      GivenName: customerData.firstName,
      FamilyName: customerData.lastName,
      PrimaryPhone: customerData.phone ? { FreeFormNumber: customerData.phone } : null,
      BillAddr: customerData.address ? {
        Line1: customerData.address.line1,
        Line2: customerData.address.line2,
        City: customerData.address.city,
        CountrySubDivisionCode: customerData.address.state,
        PostalCode: customerData.address.postalCode,
        Country: customerData.address.country
      } : null
    };

    // Remove null values
    Object.keys(qbCustomer).forEach(key => {
      if (qbCustomer[key] === null) delete qbCustomer[key];
    });

    const result = await this.apiRequest('POST', '/customer', qbCustomer);
    return result.Customer;
  }

  /**
   * Find or create customer
   */
  async findOrCreateCustomer(customerData) {
    // First, try to find by email
    let customer = await this.findCustomerByEmail(customerData.email);
    
    if (customer) {
      console.log(`   Found existing customer: ${customer.DisplayName}`);
      return customer;
    }

    // Check if display name already exists (QB requires unique)
    const existingName = await this.findCustomerByName(customerData.displayName);
    if (existingName) {
      // Append email to make unique
      customerData.displayName = `${customerData.displayName} (${customerData.email})`;
    }

    // Create new customer
    console.log(`   Creating new customer: ${customerData.displayName}`);
    return this.createCustomer(customerData);
  }

  // ──────────────────────────────────────────────────────────
  // INVOICE OPERATIONS (for paylater flow)
  // ──────────────────────────────────────────────────────────

  /**
   * Create invoice with NET 30 terms
   */
  async createInvoice(customer, order) {
    // Calculate due date (30 days from now)
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);
    const dueDateStr = dueDate.toISOString().split('T')[0];

    const invoice = {
      CustomerRef: { value: customer.Id },
      BillEmail: { Address: order.customer.email },
      DueDate: dueDateStr,
      
      // NET 30 terms - you may need to create this term in QB first
      // or use SalesTermRef if you have a specific term ID
      // SalesTermRef: { value: 'NET_30_ID' },
      
      Line: order.lineItems.map(item => ({
        DetailType: 'SalesItemLineDetail',
        Amount: item.total,
        Description: item.name,
        SalesItemLineDetail: {
          ItemRef: item.qbItemId 
            ? { value: item.qbItemId }
            : { value: item.qbItemName, name: item.qbItemName },
          Qty: item.quantity,
          UnitPrice: item.unitPrice
        }
      })),

      // Add memo with WooCommerce order reference
      PrivateNote: `WooCommerce Order #${order.orderNumber}`,
      CustomerMemo: { value: 'Thank you for your business!' }
    };

    const result = await this.apiRequest('POST', '/invoice', invoice);
    return result.Invoice;
  }

  /**
   * Send invoice via email
   */
  async sendInvoice(invoiceId) {
    const result = await this.apiRequest(
      'POST', 
      `/invoice/${invoiceId}/send`
    );
    return result.Invoice;
  }

  // ──────────────────────────────────────────────────────────
  // SALES RECEIPT OPERATIONS (for paid orders)
  // ──────────────────────────────────────────────────────────

  /**
   * Create sales receipt (for already-paid orders)
   */
  async createSalesReceipt(customer, order) {
    const receipt = {
      CustomerRef: { value: customer.Id },
      
      Line: order.lineItems.map(item => ({
        DetailType: 'SalesItemLineDetail',
        Amount: item.total,
        Description: item.name,
        SalesItemLineDetail: {
          ItemRef: item.qbItemId 
            ? { value: item.qbItemId }
            : { value: item.qbItemName, name: item.qbItemName },
          Qty: item.quantity,
          UnitPrice: item.unitPrice
        }
      })),

      // Reference to Stripe transaction
      PrivateNote: `WooCommerce Order #${order.orderNumber}${order.transactionId ? ` | Stripe: ${order.transactionId}` : ''}`,
      
      // Payment method reference (optional - requires setup in QB)
      // PaymentMethodRef: { value: 'STRIPE_PAYMENT_METHOD_ID' },
      
      // Deposit to account (optional - requires account ID)
      // DepositToAccountRef: { value: 'CHECKING_ACCOUNT_ID' }
    };

    const result = await this.apiRequest('POST', '/salesreceipt', receipt);
    return result.SalesReceipt;
  }

  // ──────────────────────────────────────────────────────────
  // UTILITY METHODS
  // ──────────────────────────────────────────────────────────

  /**
   * Get company info (useful for testing connection)
   */
  async getCompanyInfo() {
    const result = await this.apiRequest('GET', `/companyinfo/${this.realmId}`);
    return result.CompanyInfo;
  }

  /**
   * List all items/products in QuickBooks
   */
  async listItems() {
    const result = await this.query('SELECT * FROM Item');
    return result.Item || [];
  }

  /**
   * Find item by name
   */
  async findItemByName(name) {
    const sql = `SELECT * FROM Item WHERE Name = '${name}'`;
    const result = await this.query(sql);
    return result.Item?.[0] || null;
  }
}
