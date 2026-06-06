class EmailService {
  constructor() {
    this.frontendUrl = process.env.FRONTEND_URL || 'https://app.stellar-privacy.com';
    this.fromEmail = process.env.FROM_EMAIL || 'noreply@stellar-privacy.com';
  }

  async sendInvitationEmail(invitation, organization, inviter) {
    try {
      const invitationUrl = `${this.frontendUrl}/invitations/${invitation.token}`;
      
      const emailContent = this.generateInvitationEmailContent(invitation, organization, inviter, invitationUrl);
      
      // In a real implementation, you would use an email service like SendGrid, AWS SES, or Nodemailer
      // For now, we'll simulate the email sending
      console.log('=== INVITATION EMAIL ===');
      console.log(`To: ${invitation.email}`);
      console.log(`From: ${this.fromEmail}`);
      console.log(`Subject: ${emailContent.subject}`);
      console.log(`Body: ${emailContent.html}`);
      console.log('======================');
      
      // Simulate successful email sending
      return {
        success: true,
        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        invitationUrl
      };
    } catch (error) {
      console.error('Error sending invitation email:', error);
      throw new Error('Failed to send invitation email');
    }
  }

  generateInvitationEmailContent(invitation, organization, inviter, invitationUrl) {
    const roleDescriptions = {
      'ADMIN': 'full administrative access',
      'VIEWER': 'read-only access',
      'BILLING_MANAGER': 'billing and financial access'
    };

    const subject = `You're invited to join ${organization.name}`;
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Organization Invitation</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
            border-radius: 10px 10px 0 0;
        }
        .content {
            background: white;
            padding: 40px;
            border: 1px solid #e0e0e0;
            border-top: none;
        }
        .button {
            display: inline-block;
            background: #667eea;
            color: white;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            margin: 20px 0;
        }
        .footer {
            background: #f8f9fa;
            padding: 20px;
            text-align: center;
            border: 1px solid #e0e0e0;
            border-top: none;
            border-radius: 0 0 10px 10px;
            font-size: 12px;
            color: #666;
        }
        .invitation-details {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
        }
        .role-badge {
            background: #28a745;
            color: white;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 12px;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎉 You're Invited!</h1>
        <p>Join ${organization.name} on AgreeStellar</p>
    </div>
    
    <div class="content">
        <p>Hello,</p>
        
        <p>${inviter.name || inviter.email} has invited you to join <strong>${organization.name}</strong> on the AgreeStellar platform.</p>
        
        <div class="invitation-details">
            <h3>Invitation Details:</h3>
            <p><strong>Organization:</strong> ${organization.name}</p>
            <p><strong>Role:</strong> <span class="role-badge">${invitation.role}</span></p>
            <p><strong>Access Level:</strong> ${roleDescriptions[invitation.role] || 'custom access'}</p>
            ${invitation.message ? `<p><strong>Message:</strong> "${invitation.message}"</p>` : ''}
        </div>
        
        <p>To accept this invitation and join the organization, click the button below:</p>
        
        <a href="${invitationUrl}" class="button">Accept Invitation</a>
        
        <p><small>This invitation will expire in ${this.getDaysUntilExpiration(invitation.expiresAt)} days.</small></p>
        
        <p><small>If you didn't expect this invitation, you can safely ignore this email.</small></p>
    </div>
    
    <div class="footer">
        <p>This email was sent by AgreeStellar</p>
        <p>If you have questions, contact us at support@stellar-privacy.com</p>
        <p>&copy; 2024 AgreeStellar. All rights reserved.</p>
    </div>
</body>
</html>
    `;

    return { subject, html };
  }

  async sendWelcomeEmail(member, organization) {
    try {
      const emailContent = this.generateWelcomeEmailContent(member, organization);
      
      console.log('=== WELCOME EMAIL ===');
      console.log(`To: ${member.email}`);
      console.log(`From: ${this.fromEmail}`);
      console.log(`Subject: ${emailContent.subject}`);
      console.log(`Body: ${emailContent.html}`);
      console.log('====================');
      
      return {
        success: true,
        messageId: `welcome_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      };
    } catch (error) {
      console.error('Error sending welcome email:', error);
      throw new Error('Failed to send welcome email');
    }
  }

  generateWelcomeEmailContent(member, organization) {
    const subject = `Welcome to ${organization.name}!`;
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to Organization</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
            border-radius: 10px 10px 0 0;
        }
        .content {
            background: white;
            padding: 40px;
            border: 1px solid #e0e0e0;
            border-top: none;
        }
        .button {
            display: inline-block;
            background: #667eea;
            color: white;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            margin: 20px 0;
        }
        .footer {
            background: #f8f9fa;
            padding: 20px;
            text-align: center;
            border: 1px solid #e0e0e0;
            border-top: none;
            border-radius: 0 0 10px 10px;
            font-size: 12px;
            color: #666;
        }
        .role-badge {
            background: #28a745;
            color: white;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 12px;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎊 Welcome!</h1>
        <p>You're now part of ${organization.name}</p>
    </div>
    
    <div class="content">
        <p>Hello ${member.email},</p>
        
        <p>Welcome to <strong>${organization.name}</strong>! Your account has been successfully created and you now have access to the organization.</p>
        
        <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3>Your Account Details:</h3>
            <p><strong>Organization:</strong> ${organization.name}</p>
            <p><strong>Role:</strong> <span class="role-badge">${member.role}</span></p>
            <p><strong>Status:</strong> Active</p>
        </div>
        
        <p>You can now log in to your account and start using the AgreeStellar platform.</p>
        
        <a href="${this.frontendUrl}/login" class="button">Log In to Your Account</a>
        
        <p>If you have any questions or need assistance, please don't hesitate to contact our support team.</p>
    </div>
    
    <div class="footer">
        <p>This email was sent by AgreeStellar</p>
        <p>If you have questions, contact us at support@stellar-privacy.com</p>
        <p>&copy; 2024 AgreeStellar. All rights reserved.</p>
    </div>
</body>
</html>
    `;

    return { subject, html };
  }

  async sendMemberRemovedEmail(member, organization, removedBy) {
    try {
      const emailContent = this.generateMemberRemovedEmailContent(member, organization, removedBy);
      
      console.log('=== MEMBER REMOVED EMAIL ===');
      console.log(`To: ${member.email}`);
      console.log(`From: ${this.fromEmail}`);
      console.log(`Subject: ${emailContent.subject}`);
      console.log(`Body: ${emailContent.html}`);
      console.log('=============================');
      
      return {
        success: true,
        messageId: `removed_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      };
    } catch (error) {
      console.error('Error sending member removed email:', error);
      throw new Error('Failed to send member removed email');
    }
  }

  generateMemberRemovedEmailContent(member, organization, removedBy) {
    const subject = `Your access to ${organization.name} has been removed`;
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Access Removed</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .header {
            background: linear-gradient(135deg, #dc3545 0%, #c82333 100%);
            color: white;
            padding: 30px;
            text-align: center;
            border-radius: 10px 10px 0 0;
        }
        .content {
            background: white;
            padding: 40px;
            border: 1px solid #e0e0e0;
            border-top: none;
        }
        .footer {
            background: #f8f9fa;
            padding: 20px;
            text-align: center;
            border: 1px solid #e0e0e0;
            border-top: none;
            border-radius: 0 0 10px 10px;
            font-size: 12px;
            color: #666;
        }
        .alert {
            background: #f8d7da;
            color: #721c24;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            border: 1px solid #f5c6cb;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📢 Important Notice</h1>
        <p>Your access has been updated</p>
    </div>
    
    <div class="content">
        <p>Hello ${member.email},</p>
        
        <div class="alert">
            <strong>Your access to ${organization.name} has been removed.</strong>
        </div>
        
        <p>This action was taken by ${removedBy.name || removedBy.email || 'an administrator'}.</p>
        
        <p><strong>What this means:</strong></p>
        <ul>
            <li>You no longer have access to ${organization.name}'s resources</li>
            <li>Your account remains active but without organization access</li>
            <li>You can be re-invited to the organization in the future</li>
        </ul>
        
        <p>If you believe this was done in error, please contact the organization administrator or our support team.</p>
        
        <p>Thank you for your contribution to ${organization.name}.</p>
    </div>
    
    <div class="footer">
        <p>This email was sent by AgreeStellar</p>
        <p>If you have questions, contact us at support@stellar-privacy.com</p>
        <p>&copy; 2024 AgreeStellar. All rights reserved.</p>
    </div>
</body>
</html>
    `;

    return { subject, html };
  }

  getDaysUntilExpiration(expiresAt) {
    const now = new Date();
    const expiration = new Date(expiresAt);
    const diffTime = Math.abs(expiration - now);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  }

  async sendPasswordResetEmail(email, resetToken) {
    try {
      const resetUrl = `${this.frontendUrl}/reset-password?token=${resetToken}`;
      const emailContent = this.generatePasswordResetEmailContent(email, resetUrl);
      
      console.log('=== PASSWORD RESET EMAIL ===');
      console.log(`To: ${email}`);
      console.log(`From: ${this.fromEmail}`);
      console.log(`Subject: ${emailContent.subject}`);
      console.log(`Body: ${emailContent.html}`);
      console.log('===========================');
      
      return {
        success: true,
        messageId: `reset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      };
    } catch (error) {
      console.error('Error sending password reset email:', error);
      throw new Error('Failed to send password reset email');
    }
  }

  generatePasswordResetEmailContent(email, resetUrl) {
    const subject = 'Reset your AgreeStellar password';
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Password Reset</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .header {
            background: linear-gradient(135deg, #ffc107 0%, #ff9800 100%);
            color: white;
            padding: 30px;
            text-align: center;
            border-radius: 10px 10px 0 0;
        }
        .content {
            background: white;
            padding: 40px;
            border: 1px solid #e0e0e0;
            border-top: none;
        }
        .button {
            display: inline-block;
            background: #ffc107;
            color: #333;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            margin: 20px 0;
        }
        .footer {
            background: #f8f9fa;
            padding: 20px;
            text-align: center;
            border: 1px solid #e0e0e0;
            border-top: none;
            border-radius: 0 0 10px 10px;
            font-size: 12px;
            color: #666;
        }
        .alert {
            background: #fff3cd;
            color: #856404;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            border: 1px solid #ffeaa7;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔐 Password Reset</h1>
        <p>Reset your AgreeStellar password</p>
    </div>
    
    <div class="content">
        <p>Hello,</p>
        
        <p>We received a request to reset the password for your AgreeStellar account associated with this email address.</p>
        
        <div class="alert">
            <strong>This password reset link will expire in 1 hour.</strong>
        </div>
        
        <p>To reset your password, click the button below:</p>
        
        <a href="${resetUrl}" class="button">Reset Password</a>
        
        <p><small>If you didn't request this password reset, you can safely ignore this email. Your account remains secure.</small></p>
        
        <p><small>If the button doesn't work, you can copy and paste this link into your browser:</small></p>
        <p><small>${resetUrl}</small></p>
    </div>
    
    <div class="footer">
        <p>This email was sent by AgreeStellar</p>
        <p>If you have questions, contact us at support@stellar-privacy.com</p>
        <p>&copy; 2024 AgreeStellar. All rights reserved.</p>
    </div>
</body>
</html>
    `;

    return { subject, html };
  }
}

module.exports = { EmailService };
