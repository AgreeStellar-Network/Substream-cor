const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../src/db/knex');
const StellarSdk = require('@stellar/stellar-sdk');
const { logger } = require('../src/utils/logger');

class SEP24Service {
  constructor() {
    this.networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
    this.serverUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
    this.server = new StellarSdk.Horizon.Server(this.serverUrl);
    this.jwtSecret = process.env.SEP24_JWT_SECRET || crypto.randomBytes(64).toString('hex');
    this.sessionExpiry = parseInt(process.env.SEP24_SESSION_EXPIRY) || 3600000; // 1 hour
    this.allowedDomains = (process.env.SEP24_ALLOWED_DOMAINS || '').split(',').filter(Boolean);
  }

  /**
   * Generate SEP-24 interactive deposit flow
   * GET /transactions/deposit/interactive
   */
  async generateInteractiveDepositFlow(params) {
    const {
      account,
      asset_code,
      asset_issuer,
      amount,
      memo,
      lang = 'en',
      client_domain,
      callback_url,
      tenant_id
    } = params;

    try {
      // Validate required parameters
      this.validateInteractiveParams({ account, asset_code, client_domain });

      // Verify domain is allowed
      if (this.allowedDomains.length > 0 && !this.allowedDomains.includes(client_domain)) {
        throw new Error(`Domain ${client_domain} is not allowed`);
      }

      // Generate unique transaction ID
      const transactionId = `deposit_${uuidv4()}`;
      const sessionToken = this.generateSessionToken(transactionId, account);

      // Create anchor transaction record
      const anchorTransaction = await this.createAnchorTransaction({
        id: uuidv4(),
        tenant_id,
        stellar_public_key: account,
        transaction_id: transactionId,
        transaction_type: 'deposit',
        asset_code,
        asset_issuer,
        amount,
        amount_in_asset: `${amount} ${asset_code}`,
        status: 'pending_user_transfer_start',
        session_token: sessionToken,
        session_expires_at: new Date(Date.now() + this.sessionExpiry),
        interactive_url: `${process.env.BASE_URL}/sep24/interactive/${transactionId}`,
        customer_memo: memo || `DEPOSIT-${transactionId.slice(-8)}`,
        transaction_details: {
          lang,
          client_domain,
          callback_url,
          requested_at: new Date().toISOString()
        }
      });

      // Create interactive session
      const session = await this.createInteractiveSession({
        anchor_transaction_id: anchorTransaction.id,
        session_token: sessionToken,
        origin_domain: client_domain,
        callback_url,
        session_data: {
          account,
          asset_code,
          amount,
          lang,
          step: 'bank_details'
        },
        expires_at: new Date(Date.now() + this.sessionExpiry)
      });

      // Generate bank transfer details (mock implementation)
      const bankDetails = await this.generateBankDetails(asset_code, tenant_id);

      logger.info('SEP-24 interactive flow created', {
        transactionId,
        account,
        asset_code,
        amount,
        client_domain
      });

      return {
        success: true,
        transaction_id: transactionId,
        url: `${process.env.BASE_URL}/sep24/interactive/${transactionId}`,
        token: sessionToken,
        expires_at: session.expires_at,
        bank_details: bankDetails
      };

    } catch (error) {
      logger.error('Error generating SEP-24 interactive flow:', error);
      throw error;
    }
  }

  /**
   * Handle interactive flow requests
   */
  async handleInteractiveFlow(transactionId, sessionToken, action, data = {}) {
    try {
      // Verify session token
      const decoded = jwt.verify(sessionToken, this.jwtSecret);
      if (decoded.transaction_id !== transactionId) {
        throw new Error('Invalid session token');
      }

      // Get transaction and session
      const transaction = await db('anchor_transactions')
        .where({ transaction_id: transactionId, session_token: sessionToken })
        .first();

      const session = await db('sep24_interactive_sessions')
        .where({ session_token: sessionToken, status: 'active' })
        .first();

      if (!transaction || !session) {
        throw new Error('Transaction or session not found');
      }

      // Check if session is expired
      if (new Date() > new Date(session.expires_at)) {
        await this.updateSessionStatus(session.id, 'expired');
        await this.updateTransactionStatus(transaction.id, 'error', 'Session expired');
        throw new Error('Session expired');
      }

      // Handle different actions
      switch (action) {
        case 'get_status':
          return await this.getTransactionStatus(transaction);
        
        case 'submit_bank_transfer':
          return await this.submitBankTransfer(transaction, session, data);
        
        case 'confirm_transfer':
          return await this.confirmBankTransfer(transaction, session, data);
        
        case 'complete_flow':
          return await this.completeInteractiveFlow(transaction, session);
        
        default:
          throw new Error('Invalid action');
      }

    } catch (error) {
      logger.error('Error handling interactive flow:', error);
      throw error;
    }
  }

  /**
   * Submit bank transfer details
   */
  async submitBankTransfer(transaction, session, data) {
    const { bank_account_type, bank_account_number, bank_routing_number, bank_name, bank_country } = data;

    // Update transaction with bank details
    await db('anchor_transactions')
      .where({ id: transaction.id })
      .update({
        bank_account_type,
        bank_account_number: this.encryptSensitiveData(bank_account_number),
        bank_routing_number: this.encryptSensitiveData(bank_routing_number),
        bank_name,
        bank_country,
        status: 'pending_anchor',
        updated_at: new Date()
      });

    // Update session
    await db('sep24_interactive_sessions')
      .where({ id: session.id })
      .update({
        session_data: {
          ...session.session_data,
          step: 'transfer_confirmation',
          bank_details_submitted: true
        }
      });

    return {
      success: true,
      status: 'pending_anchor',
      message: 'Bank transfer details submitted. Awaiting confirmation.',
      next_action: 'confirm_transfer'
    };
  }

  /**
   * Confirm bank transfer completion
   */
  async confirmBankTransfer(transaction, session, data) {
    const { transfer_confirmed, confirmation_code } = data;

    if (!transfer_confirmed) {
      throw new Error('Transfer must be confirmed');
    }

    // Update transaction status
    await db('anchor_transactions')
      .where({ id: transaction.id })
      .update({
        status: 'pending_user_transfer_complete',
        updated_at: new Date()
      });

    // Update session
    await db('sep24_interactive_sessions')
      .where({ id: session.id })
      .update({
        session_data: {
          ...session.session_data,
          step: 'processing',
          transfer_confirmed: true,
          confirmation_code
        }
      });

    // Trigger webhook to anchor (if configured)
    await this.sendAnchorWebhook(transaction, 'transfer_confirmed');

    return {
      success: true,
      status: 'pending_user_transfer_complete',
      message: 'Transfer confirmed. Processing payment...',
      next_action: 'complete_flow'
    };
  }

  /**
   * Complete the interactive flow
   */
  async completeInteractiveFlow(transaction, session) {
    // Update transaction to completed
    await db('anchor_transactions')
      .where({ id: transaction.id })
      .update({
        status: 'completed',
        completed_at: new Date(),
        updated_at: new Date()
      });

    // Update session
    await db('sep24_interactive_sessions')
      .where({ id: session.id })
      .update({
        status: 'completed',
        completed_at: new Date(),
        session_data: {
          ...session.session_data,
          step: 'completed'
        }
      });

    // Send completion webhook
    await this.sendAnchorWebhook(transaction, 'completed');

    // Send email notification to user
    await this.sendCompletionNotification(transaction);

    logger.info('SEP-24 interactive flow completed', {
      transactionId: transaction.transaction_id,
      account: transaction.stellar_public_key
    });

    return {
      success: true,
      status: 'completed',
      message: 'Deposit completed successfully',
      completed_at: new Date()
    };
  }

  /**
   * Get transaction status
   */
  async getTransactionStatus(transaction) {
    return {
      success: true,
      transaction_id: transaction.transaction_id,
      status: transaction.status,
      amount: transaction.amount,
      asset_code: transaction.asset_code,
      created_at: transaction.created_at,
      completed_at: transaction.completed_at,
      status_message: transaction.status_message
    };
  }

  /**
   * Handle webhook from anchor
   */
  async handleAnchorWebhook(webhookData, signature) {
    try {
      // Verify webhook signature
      const isValid = this.verifyWebhookSignature(webhookData, signature);
      if (!isValid) {
        throw new Error('Invalid webhook signature');
      }

      const { transaction_id, status, amount, stellar_transaction_id } = webhookData;

      // Find transaction
      const transaction = await db('anchor_transactions')
        .where({ transaction_id })
        .first();

      if (!transaction) {
        throw new Error('Transaction not found');
      }

      // Update transaction based on webhook status
      const statusMapping = {
        'pending_user_transfer_start': 'pending_user_transfer_start',
        'pending_anchor': 'pending_anchor',
        'pending_user_transfer_complete': 'pending_user_transfer_complete',
        'completed': 'completed',
        'error': 'error'
      };

      const newStatus = statusMapping[status] || 'error';

      await db('anchor_transactions')
        .where({ id: transaction.id })
        .update({
          status: newStatus,
          anchor_transaction_id: stellar_transaction_id,
          updated_at: new Date(),
          completed_at: newStatus === 'completed' ? new Date() : null
        });

      // If completed, send notification
      if (newStatus === 'completed') {
        await this.sendCompletionNotification(transaction);
      }

      logger.info('Anchor webhook processed', {
        transaction_id,
        status: newStatus
      });

      return { success: true };

    } catch (error) {
      logger.error('Error processing anchor webhook:', error);
      throw error;
    }
  }

  /**
   * Create anchor transaction record
   */
  async createAnchorTransaction(data) {
    const [transaction] = await db('anchor_transactions').insert(data).returning('*');
    return transaction;
  }

  /**
   * Create interactive session record
   */
  async createInteractiveSession(data) {
    const [session] = await db('sep24_interactive_sessions').insert(data).returning('*');
    return session;
  }

  /**
   * Update transaction status
   */
  async updateTransactionStatus(transactionId, status, message = null) {
    await db('anchor_transactions')
      .where({ id: transactionId })
      .update({
        status,
        status_message: message,
        updated_at: new Date(),
        completed_at: status === 'completed' ? new Date() : null
      });
  }

  /**
   * Update session status
   */
  async updateSessionStatus(sessionId, status) {
    await db('sep24_interactive_sessions')
      .where({ id: sessionId })
      .update({
        status,
        completed_at: status === 'completed' ? new Date() : null
      });
  }

  /**
   * Generate JWT session token
   */
  generateSessionToken(transactionId, account) {
    return jwt.sign(
      {
        transaction_id: transactionId,
        account,
        type: 'sep24_session',
        iat: Math.floor(Date.now() / 1000)
      },
      this.jwtSecret,
      { expiresIn: '1h' }
    );
  }

  /**
   * Generate bank transfer details
   */
  async generateBankDetails(assetCode, tenantId) {
    // In production, this would integrate with actual banking partners
    // For now, returning mock data
    return {
      bank_name: 'AgreeStellar Bank',
      bank_account_type: 'IBAN',
      bank_account_number: 'DE89370400440532013000',
      bank_routing_number: 'DEUTDEFF',
      bank_country: 'DE',
      reference: `SUBSTREAM-${Date.now()}`,
      instructions: `Transfer funds to the above IBAN with reference SUBSTREAM-${Date.now()}. Funds will appear in your wallet within 1-2 business days.`
    };
  }

  /**
   * Encrypt sensitive data
   */
  encryptSensitiveData(data) {
    // In production, use proper encryption
    return Buffer.from(data).toString('base64');
  }

  /**
   * Decrypt sensitive data
   */
  decryptSensitiveData(encryptedData) {
    return Buffer.from(encryptedData, 'base64').toString('utf-8');
  }

  /**
   * Validate interactive flow parameters
   */
  validateInteractiveParams(params) {
    const { account, asset_code, client_domain } = params;
    
    if (!account) throw new Error('Account (Stellar public key) is required');
    if (!asset_code) throw new Error('Asset code is required');
    if (!client_domain) throw new Error('Client domain is required');

    // Validate Stellar public key format
    try {
      StellarSdk.Keypair.fromPublicKey(account);
    } catch (error) {
      throw new Error('Invalid Stellar public key format');
    }
  }

  /**
   * Send webhook to anchor
   */
  async sendAnchorWebhook(transaction, event) {
    try {
      const webhookConfig = await db('anchor_webhook_configs')
        .where({ tenant_id: transaction.tenant_id, active: true })
        .first();

      if (!webhookConfig) {
        logger.warn('No webhook configuration found for tenant', transaction.tenant_id);
        return;
      }

      const payload = {
        event,
        transaction_id: transaction.transaction_id,
        status: transaction.status,
        amount: transaction.amount,
        asset_code: transaction.asset_code,
        account: transaction.stellar_public_key,
        timestamp: new Date().toISOString()
      };

      // Generate HMAC signature
      const signature = crypto
        .createHmac('sha256', webhookConfig.webhook_secret)
        .update(JSON.stringify(payload))
        .digest('hex');

      // Send webhook (using axios in production)
      logger.info('Anchor webhook sent', {
        url: webhookConfig.webhook_url,
        event,
        transaction_id: transaction.transaction_id
      });

    } catch (error) {
      logger.error('Error sending anchor webhook:', error);
    }
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload, signature) {
    // In production, verify against stored webhook secret
    return true; // Simplified for now
  }

  /**
   * Send completion notification
   */
  async sendCompletionNotification(transaction) {
    try {
      const emailService = require('./emailService');
      await emailService.sendEmail({
        to: transaction.stellar_public_key, // In production, get actual email
        subject: 'Deposit Completed',
        template: 'deposit-completed',
        data: {
          amount: transaction.amount,
          asset_code: transaction.asset_code,
          transaction_id: transaction.transaction_id,
          completed_at: transaction.completed_at
        }
      });
    } catch (error) {
      logger.error('Error sending completion notification:', error);
    }
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions() {
    await db('sep24_interactive_sessions')
      .where('expires_at', '<', new Date())
      .where({ status: 'active' })
      .update({ status: 'expired' });

    await db('anchor_transactions')
      .where('session_expires_at', '<', new Date())
      .where({ status: 'pending_user_transfer_start' })
      .update({ 
        status: 'error',
        status_message: 'Session expired',
        updated_at: new Date()
      });
  }
}

module.exports = SEP24Service;
