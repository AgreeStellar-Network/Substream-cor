// utils/email.js
// Simple email utility (stub for integration with real email provider)

const nodemailer = require('nodemailer');

// Configure your SMTP or email provider here
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'user@example.com',
    pass: process.env.SMTP_PASS || 'password',
  },
});

/**
 * Send an email
 * @param {string} to
 * @param {string} subject
 * @param {string} text
 * @param {string} [html]
 */
async function sendEmail({ to, subject, text, html }) {
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || 'no-reply@substream.app',
    to,
    subject,
    text,
    html,
  });
  return info;
}

module.exports = { sendEmail };