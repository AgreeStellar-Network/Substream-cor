/**
 * Pre-Billing Email Service
 * Handles sending warning emails for pre-billing health checks
 */
class PreBillingEmailService {
  constructor(config = {}) {
    this.fromEmail = config.fromEmail || process.env.FROM_EMAIL || 'noreply@substream.app';
    this.baseUrl = config.baseUrl || process.env.FRONTEND_URL || 'https://app.substream.app';
    this.supportEmail = config.supportEmail || process.env.SUPPORT_EMAIL || 'support@substream.app';
  }

  /**
   * Send pre-billing warning email
   * @param {Object} emailData - Email data
   * @returns {Promise<void>}
   */
  async sendEmail(emailData) {
    const { to, subject, template, data } = emailData;
    
    if (!to || !template || !data) {
      throw new Error('Missing required email fields: to, template, data');
    }

    try {
      // Generate email content based on template
      const emailContent = this.generateEmailContent(template, data);
      
      // This would integrate with your actual email service
      // For now, we'll log the email that would be sent
      console.log('=== PRE-BILLING WARNING EMAIL ===');
      console.log(`To: ${to}`);
      console.log(`Subject: ${subject}`);
      console.log(`Template: ${template}`);
      console.log('Content:');
      console.log(emailContent.text);
      console.log('HTML Content:');
      console.log(emailContent.html);
      console.log('=== END EMAIL ===');
      
      // In a real implementation, you would use your email service here:
      // await this.emailProvider.send({
      //   to,
      //   from: this.fromEmail,
      //   subject,
      //   text: emailContent.text,
      //   html: emailContent.html
      // });
      
      return {
        success: true,
        messageId: `mock-${Date.now()}`,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('Failed to send pre-billing warning email:', error);
      throw error;
    }
  }

  /**
   * Generate email content based on template
   * @param {string} template - Template name
   * @param {Object} data - Template data
   * @returns {Object} Email content with text and HTML
   */
  generateEmailContent(template, data) {
    switch (template) {
      case 'pre_billing_warning':
        return this.generatePreBillingWarningContent(data);
      default:
        throw new Error(`Unknown email template: ${template}`);
    }
  }

  /**
   * Generate pre-billing warning email content
   * @param {Object} data - Template data
   * @returns {Object} Email content
   */
  generatePreBillingWarningContent(data) {
    const {
      walletAddress,
      creatorId,
      nextBillingDate,
      requiredAmount,
      issues,
      balanceCheck,
      authCheck,
      warningDays
    } = data;

    // Format the billing date
    const billingDate = new Date(nextBillingDate).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    // Generate issue descriptions
    const issueDescriptions = issues.map(issue => {
      switch (issue.type) {
        case 'insufficient_balance':
          return `Your wallet balance (${this.formatBalance(issue.balance)}) is insufficient to cover the required payment (${this.formatBalance(issue.required)}).`;
        case 'missing_authorization':
          return 'Your wallet authorization for SubStream payments has been revoked or was never granted.';
        case 'check_failed':
          return `Unable to verify your wallet status: ${issue.message}`;
        default:
          return issue.message;
      }
    });

    // Generate action URLs
    const addFundsUrl = `${this.baseUrl}/wallet/add-funds`;
    const authorizeUrl = `${this.baseUrl}/wallet/authorize`;
    const manageSubscriptionsUrl = `${this.baseUrl}/subscriptions`;

    // Text version
    const text = `
Action Required: Your Substream payment will fail in ${warningDays} days

Dear User,

We've detected an issue with your upcoming subscription payment that will cause it to fail:

Subscription Details:
- Creator: ${creatorId}
- Next Billing Date: ${billingDate}
- Required Amount: ${this.formatBalance(requiredAmount)}
- Wallet Address: ${walletAddress}

Issues Found:
${issueDescriptions.map(issue => `  - ${issue}`).join('\n')}

What you need to do:

${issueDescriptions.some(issue => issue.type === 'insufficient_balance') ? `
1. Add funds to your wallet:
   ${addFundsUrl}

` : ''}${issueDescriptions.some(issue => issue.type === 'missing_authorization') ? `
2. Re-authorize SubStream to access your wallet:
   ${authorizeUrl}

` : ''}3. Review your subscription settings:
   ${manageSubscriptionsUrl}

Important Notes:
- Your subscription will be canceled if payment fails
- You have ${warningDays} days to resolve these issues
- This is an automated warning message

If you need help, please contact our support team:
${this.supportEmail}

Best regards,
The SubStream Team
    `.trim();

    // HTML version
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Action Required: Your Substream payment will fail in ${warningDays} days</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1a1a1a; color: white; padding: 20px; text-align: center; }
        .content { padding: 30px 20px; background: #f9f9f9; }
        .alert { background: #ff6b6b; color: white; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .details { background: white; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
        .issues { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .actions { margin-bottom: 20px; }
        .btn { display: inline-block; padding: 12px 24px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; margin-right: 10px; margin-bottom: 10px; }
        .btn:hover { background: #0056b3; }
        .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        .wallet-address { font-family: monospace; background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>AgreeStellar</h1>
        <p>Payment Warning</p>
    </div>
    
    <div class="content">
        <div class="alert">
            <strong>Action Required:</strong> Your payment will fail in ${warningDays} days
        </div>
        
        <div class="details">
            <h2>Subscription Details</h2>
            <p><strong>Creator:</strong> ${creatorId}</p>
            <p><strong>Next Billing Date:</strong> ${billingDate}</p>
            <p><strong>Required Amount:</strong> ${this.formatBalance(requiredAmount)}</p>
            <p><strong>Wallet Address:</strong> <span class="wallet-address">${walletAddress}</span></p>
        </div>
        
        <div class="issues">
            <h2>Issues Found</h2>
            <ul>
                ${issueDescriptions.map(issue => `<li>${issue}</li>`).join('')}
            </ul>
        </div>
        
        <div class="actions">
            <h2>What you need to do:</h2>
            ${issueDescriptions.some(issue => issue.type === 'insufficient_balance') ? `
                <p><a href="${addFundsUrl}" class="btn">Add Funds to Wallet</a></p>
            ` : ''}
            ${issueDescriptions.some(issue => issue.type === 'missing_authorization') ? `
                <p><a href="${authorizeUrl}" class="btn">Re-authorize Wallet</a></p>
            ` : ''}
            <p><a href="${manageSubscriptionsUrl}" class="btn">Manage Subscriptions</a></p>
        </div>
        
        <div class="details">
            <h3>Important Notes</h3>
            <ul>
                <li>Your subscription will be canceled if payment fails</li>
                <li>You have ${warningDays} days to resolve these issues</li>
                <li>This is an automated warning message</li>
            </ul>
        </div>
        
        <div class="details">
            <h3>Need Help?</h3>
            <p>If you need assistance, please contact our support team:</p>
            <p>Email: <a href="mailto:${this.supportEmail}">${this.supportEmail}</a></p>
        </div>
    </div>
    
    <div class="footer">
        <p>&copy; 2024 AgreeStellar. All rights reserved.</p>
        <p>This is an automated message. Please do not reply to this email.</p>
    </div>
</body>
</html>
    `.trim();

    return { text, html };
  }

  /**
   * Format balance for display
   * @param {number} balance - Balance in stroops
   * @returns {string} Formatted balance
   */
  formatBalance(balance) {
    if (typeof balance !== 'number' || !isFinite(balance)) {
      return '0 XLM';
    }
    
    const xlm = balance / 10000000; // Convert from stroops to XLM
    return `${xlm.toFixed(6)} XLM`;
  }

  /**
   * Send test email for development
   * @param {Object} testData - Test data
   * @returns {Promise<Object>} Test result
   */
  async sendTestEmail(testData) {
    const emailData = {
      to: testData.email || 'test@example.com',
      subject: 'Test: Pre-billing Warning',
      template: 'pre_billing_warning',
      data: {
        walletAddress: testData.walletAddress || 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        creatorId: testData.creatorId || 'test-creator',
        nextBillingDate: testData.nextBillingDate || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        requiredAmount: testData.requiredAmount || 10000000, // 1 XLM
        issues: testData.issues || [
          {
            type: 'insufficient_balance',
            message: 'Insufficient balance for payment',
            balance: 5000000,
            required: 10000000
          }
        ],
        balanceCheck: testData.balanceCheck || { isSufficient: false },
        authCheck: testData.authCheck || { hasAuthorization: true },
        warningDays: 3
      }
    };

    return this.sendEmail(emailData);
  }
}

module.exports = PreBillingEmailService;
