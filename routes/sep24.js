const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../src/db/knex');
const SEP24Service = require('../services/sep24Service');
const { authenticateTenant } = require('../middleware/tenantAuth');
const rateLimit = require('express-rate-limit');
const { logger } = require('../src/utils/logger');

const sep24Service = new SEP24Service();

// Rate limiting for SEP-24 endpoints
const sep24RateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all SEP-24 routes
router.use(sep24RateLimit);

/**
 * SEP-24 Interactive Deposit Flow
 * GET /transactions/deposit/interactive
 * 
 * This endpoint initiates the SEP-24 hosted deposit flow.
 * Stellar wallets call this endpoint to start the interactive process.
 */
router.get('/transactions/deposit/interactive', authenticateTenant, async (req, res) => {
  try {
    const {
      account,
      asset_code,
      asset_issuer,
      amount,
      memo,
      lang = 'en',
      client_domain,
      callback_url
    } = req.query;

    const tenant_id = req.tenant.id;

    const result = await sep24Service.generateInteractiveDepositFlow({
      account,
      asset_code,
      asset_issuer,
      amount,
      memo,
      lang,
      client_domain,
      callback_url,
      tenant_id
    });

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('SEP-24 interactive deposit flow error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * SEP-24 Interactive Withdrawal Flow
 * GET /transactions/withdrawal/interactive
 */
router.get('/transactions/withdrawal/interactive', authenticateTenant, async (req, res) => {
  try {
    const {
      account,
      asset_code,
      asset_issuer,
      amount,
      memo,
      lang = 'en',
      client_domain,
      callback_url
    } = req.query;

    // For now, withdrawal is not implemented
    res.status(501).json({
      success: false,
      error: 'Withdrawal flow not yet implemented'
    });

  } catch (error) {
    logger.error('SEP-24 interactive withdrawal flow error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Interactive Flow Handler
 * POST /sep24/interactive/:transactionId
 * 
 * This handles the interactive flow steps within the web view.
 */
router.post('/sep24/interactive/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { action, token, data } = req.body;

    if (!action || !token) {
      return res.status(400).json({
        success: false,
        error: 'Action and token are required'
      });
    }

    const result = await sep24Service.handleInteractiveFlow(transactionId, token, action, data);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('SEP-24 interactive flow handler error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get Transaction Status
 * GET /sep24/transaction/:transactionId/status
 */
router.get('/sep24/transaction/:transactionId/status', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Session token is required'
      });
    }

    const result = await sep24Service.handleInteractiveFlow(transactionId, token, 'get_status');

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('SEP-24 transaction status error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Anchor Webhook Handler
 * POST /sep24/webhook
 * 
 * Receives webhooks from fiat anchors about transaction status updates.
 */
router.post('/sep24/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-stellar-signature'] || req.headers['signature'];
    const webhookData = req.body;

    const result = await sep24Service.handleAnchorWebhook(webhookData, signature);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('SEP-24 webhook error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * SEP-24 Interactive UI Page
 * GET /sep24/interactive/:transactionId
 * 
 * This serves the HTML page for the interactive flow.
 * In production, this would be a proper React/Vue application.
 */
router.get('/sep24/interactive/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { token } = req.query;

    if (!token) {
      return res.status(400).send('Session token is required');
    }

    // Verify session exists and is valid
    const decoded = jwt.decode(token);
    if (!decoded || decoded.transaction_id !== transactionId) {
      return res.status(400).send('Invalid session token');
    }

    // Serve the interactive HTML page
    res.send(generateInteractivePageHTML(transactionId, token));

  } catch (error) {
    logger.error('SEP-24 interactive page error:', error);
    res.status(500).send('Internal server error');
  }
});

/**
 * Get Supported Assets
 * GET /sep24/assets
 * 
 * Returns list of supported assets for SEP-24 transactions.
 */
router.get('/sep24/assets', authenticateTenant, async (req, res) => {
  try {
    const tenant_id = req.tenant.id;

    // Get supported assets from webhook configs
    const webhookConfigs = await db('anchor_webhook_configs')
      .where({ tenant_id, active: true })
      .select('supported_assets');

    const supportedAssets = new Set();
    webhookConfigs.forEach(config => {
      if (config.supported_assets) {
        const assets = Array.isArray(config.supported_assets) 
          ? config.supported_assets 
          : JSON.parse(config.supported_assets || '[]');
        assets.forEach(asset => supportedAssets.add(asset));
      }
    });

    res.json({
      success: true,
      assets: Array.from(supportedAssets).map(asset => ({
        code: asset,
        status: 'active',
        type: 'fiat'
      }))
    });

  } catch (error) {
    logger.error('SEP-24 assets error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get supported assets'
    });
  }
});

/**
 * Transaction History
 * GET /sep24/transactions
 * 
 * Get transaction history for a user.
 */
router.get('/sep24/transactions', authenticateTenant, async (req, res) => {
  try {
    const { account, limit = 10, offset = 0 } = req.query;
    const tenant_id = req.tenant.id;

    if (!account) {
      return res.status(400).json({
        success: false,
        error: 'Account (Stellar public key) is required'
      });
    }

    const transactions = await db('anchor_transactions')
      .where({
        tenant_id,
        stellar_public_key: account.toLowerCase()
      })
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset))
      .select([
        'transaction_id',
        'transaction_type',
        'asset_code',
        'amount',
        'status',
        'created_at',
        'completed_at',
        'status_message'
      ]);

    res.json({
      success: true,
      transactions,
      total: transactions.length
    });

  } catch (error) {
    logger.error('SEP-24 transaction history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get transaction history'
    });
  }
});

/**
 * Admin: Configure Anchor Webhook
 * POST /sep24/admin/webhook-config
 */
router.post('/sep24/admin/webhook-config', authenticateTenant, async (req, res) => {
  try {
    const {
      anchor_name,
      webhook_url,
      webhook_secret,
      supported_assets
    } = req.body;

    const tenant_id = req.tenant.id;

    const [config] = await db('anchor_webhook_configs')
      .insert({
        tenant_id,
        anchor_name,
        webhook_url,
        webhook_secret,
        supported_assets: JSON.stringify(supported_assets || []),
        active: true
      })
      .returning('*');

    res.json({
      success: true,
      config
    });

  } catch (error) {
    logger.error('SEP-24 webhook config error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to configure webhook'
    });
  }
});

/**
 * Cleanup expired sessions (admin endpoint)
 * POST /sep24/admin/cleanup-sessions
 */
router.post('/sep24/admin/cleanup-sessions', authenticateTenant, async (req, res) => {
  try {
    await sep24Service.cleanupExpiredSessions();

    res.json({
      success: true,
      message: 'Expired sessions cleaned up'
    });

  } catch (error) {
    logger.error('SEP-24 cleanup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cleanup sessions'
    });
  }
});

/**
 * Generate HTML for interactive page
 * This is a simplified version - in production, use a proper frontend framework
 */
function generateInteractivePageHTML(transactionId, token) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AgreeStellar - Deposit</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
        .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .step { display: none; }
        .step.active { display: block; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input, select { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; }
        button { background: #007bff; color: white; padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px; }
        button:hover { background: #0056b3; }
        button:disabled { background: #ccc; cursor: not-allowed; }
        .status { padding: 10px; border-radius: 4px; margin: 10px 0; }
        .status.info { background: #d1ecf1; color: #0c5460; }
        .status.success { background: #d4edda; color: #155724; }
        .status.error { background: #f8d7da; color: #721c24; }
        .loading { text-align: center; padding: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>AgreeStellar</h1>
            <h2>Fiat Deposit</h2>
        </div>

        <div id="status-message" class="status info" style="display: none;"></div>

        <!-- Step 1: Bank Details -->
        <div id="step-bank-details" class="step active">
            <h3>Step 1: Bank Transfer Details</h3>
            <div class="form-group">
                <label>Bank Account Type:</label>
                <select id="bank_account_type" required>
                    <option value="IBAN">IBAN</option>
                    <option value="SWIFT">SWIFT</option>
                    <option value="ACH">ACH</option>
                </select>
            </div>
            <div class="form-group">
                <label>Bank Account Number:</label>
                <input type="text" id="bank_account_number" required>
            </div>
            <div class="form-group">
                <label>Bank Routing Number:</label>
                <input type="text" id="bank_routing_number" required>
            </div>
            <div class="form-group">
                <label>Bank Name:</label>
                <input type="text" id="bank_name" required>
            </div>
            <div class="form-group">
                <label>Bank Country:</label>
                <select id="bank_country" required>
                    <option value="US">United States</option>
                    <option value="DE">Germany</option>
                    <option value="GB">United Kingdom</option>
                    <option value="FR">France</option>
                </select>
            </div>
            <button onclick="submitBankDetails()">Submit Bank Details</button>
        </div>

        <!-- Step 2: Transfer Confirmation -->
        <div id="step-transfer-confirmation" class="step">
            <h3>Step 2: Confirm Transfer</h3>
            <p>Please confirm that you have initiated the bank transfer.</p>
            <div class="form-group">
                <label>Confirmation Code (if provided by bank):</label>
                <input type="text" id="confirmation_code">
            </div>
            <button onclick="confirmTransfer()">I have made the transfer</button>
            <button onclick="goBack()">Go Back</button>
        </div>

        <!-- Step 3: Processing -->
        <div id="step-processing" class="step">
            <h3>Processing Your Deposit</h3>
            <div class="loading">
                <p>We are processing your deposit. This usually takes 1-2 business days.</p>
                <p>Please keep this window open to receive updates.</p>
            </div>
        </div>

        <!-- Step 4: Completed -->
        <div id="step-completed" class="step">
            <h3>Deposit Completed!</h3>
            <p>Your deposit has been successfully processed and the funds should appear in your wallet.</p>
            <button onclick="closeWindow()">Close Window</button>
        </div>
    </div>

    <script>
        const transactionId = '${transactionId}';
        const token = '${token}';
        let currentStep = 'bank-details';

        function showStep(stepName) {
            document.querySelectorAll('.step').forEach(step => {
                step.classList.remove('active');
            });
            document.getElementById('step-' + stepName).classList.add('active');
            currentStep = stepName;
        }

        function showStatus(message, type = 'info') {
            const statusEl = document.getElementById('status-message');
            statusEl.textContent = message;
            statusEl.className = 'status ' + type;
            statusEl.style.display = 'block';
            
            setTimeout(() => {
                statusEl.style.display = 'none';
            }, 5000);
        }

        async function submitBankDetails() {
            const data = {
                bank_account_type: document.getElementById('bank_account_type').value,
                bank_account_number: document.getElementById('bank_account_number').value,
                bank_routing_number: document.getElementById('bank_routing_number').value,
                bank_name: document.getElementById('bank_name').value,
                bank_country: document.getElementById('bank_country').value
            };

            try {
                const response = await fetch('/sep24/interactive/' + transactionId, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        action: 'submit_bank_transfer',
                        token: token,
                        data: data
                    })
                });

                const result = await response.json();
                
                if (result.success) {
                    showStatus('Bank details submitted successfully', 'success');
                    showStep('transfer-confirmation');
                } else {
                    showStatus(result.error || 'Failed to submit bank details', 'error');
                }
            } catch (error) {
                showStatus('Network error. Please try again.', 'error');
            }
        }

        async function confirmTransfer() {
            const confirmationCode = document.getElementById('confirmation_code').value;

            try {
                const response = await fetch('/sep24/interactive/' + transactionId, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        action: 'confirm_transfer',
                        token: token,
                        data: {
                            transfer_confirmed: true,
                            confirmation_code: confirmationCode
                        }
                    })
                });

                const result = await response.json();
                
                if (result.success) {
                    showStatus('Transfer confirmed. Processing payment...', 'success');
                    showStep('processing');
                    
                    // Poll for completion
                    pollForCompletion();
                } else {
                    showStatus(result.error || 'Failed to confirm transfer', 'error');
                }
            } catch (error) {
                showStatus('Network error. Please try again.', 'error');
            }
        }

        async function pollForCompletion() {
            const pollInterval = setInterval(async () => {
                try {
                    const response = await fetch('/sep24/transaction/' + transactionId + '/status?token=' + token);
                    const result = await response.json();
                    
                    if (result.success && result.status === 'completed') {
                        clearInterval(pollInterval);
                        showStep('completed');
                        showStatus('Deposit completed successfully!', 'success');
                        
                        // Notify parent window
                        if (window.parent) {
                            window.parent.postMessage({
                                type: 'SEP24_COMPLETED',
                                transactionId: transactionId,
                                status: 'completed'
                            }, '*');
                        }
                    }
                } catch (error) {
                    console.error('Error polling for completion:', error);
                }
            }, 5000); // Poll every 5 seconds

            // Stop polling after 5 minutes
            setTimeout(() => {
                clearInterval(pollInterval);
            }, 300000);
        }

        function goBack() {
            showStep('bank-details');
        }

        function closeWindow() {
            if (window.parent) {
                window.parent.postMessage({
                    type: 'SEP24_CLOSE',
                    transactionId: transactionId
                }, '*');
            } else {
                window.close();
            }
        }

        // Initialize
        showStatus('Welcome! Please provide your bank transfer details.', 'info');
    </script>
</body>
</html>
  `;
}

module.exports = router;
