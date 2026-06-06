
const PdfPrinter = require('pdfmake');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Invoice Service
 * Generates localized PDF invoices and stores them in S3
 */
class InvoiceService {
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;
    
    // Initialize S3
    this.s3 = new AWS.S3({
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
      region: config.s3.region
    });

    // pdfmake fonts
    this.fonts = {
      Roboto: {
        normal: path.join(__dirname, '../fonts/Roboto-Regular.ttf'),
        bold: path.join(__dirname, '../fonts/Roboto-Medium.ttf'),
        italics: path.join(__dirname, '../fonts/Roboto-Italic.ttf'),
        bolditalics: path.join(__dirname, '../fonts/Roboto-MediumItalic.ttf')
      }
    };
    
    this.printer = new PdfPrinter(this.fonts);
  }

  /**
   * Generate an invoice PDF for a billing event
   * @param {Object} billingData 
   * @returns {Promise<Object>} S3 upload result
   */
  async generateInvoice(billingData) {
    const { 
      invoiceId, 
      creatorId, 
      walletAddress, 
      amount, 
      currency, 
      timestamp, 
      transactionHash,
      locale = 'en-US'
    } = billingData;

    this.logger.info(`Generating invoice ${invoiceId} for ${walletAddress}`);

    try {
      // 1. Define document structure
      const docDefinition = this.createDocDefinition(billingData, locale);

      // 2. Generate PDF buffer
      const pdfDoc = this.printer.createPdfKitDocument(docDefinition);
      const chunks = [];
      
      return new Promise((resolve, reject) => {
        pdfDoc.on('data', chunk => chunks.push(chunk));
        pdfDoc.on('end', async () => {
          const buffer = Buffer.concat(chunks);
          
          // 3. Upload to S3
          const s3Key = `invoices/${creatorId}/${invoiceId}.pdf`;
          const uploadResult = await this.s3.upload({
            Bucket: this.config.s3.bucket,
            Key: s3Key,
            Body: buffer,
            ContentType: 'application/pdf',
            Metadata: {
              transactionHash,
              walletAddress,
              timestamp
            }
          }).promise();

          this.logger.info(`Invoice ${invoiceId} uploaded to S3: ${uploadResult.Location}`);
          
          resolve({
            url: uploadResult.Location,
            key: s3Key,
            hash: this.calculateHash(buffer)
          });
        });
        pdfDoc.on('error', reject);
        pdfDoc.end();
      });

    } catch (error) {
      this.logger.error(`Failed to generate invoice ${invoiceId}:`, error);
      throw error;
    }
  }

  /**
   * Create pdfmake document definition
   */
  createDocDefinition(data, locale) {
    const i18n = {
      'en-US': { title: 'INVOICE', date: 'Date', amount: 'Amount', hash: 'On-chain Hash' },
      'es-ES': { title: 'FACTURA', date: 'Fecha', amount: 'Monto', hash: 'Hash en cadena' }
    };
    const t = i18n[locale] || i18n['en-US'];

    return {
      content: [
        { text: t.title, style: 'header' },
        { text: `Invoice ID: ${data.invoiceId}`, margin: [0, 0, 0, 10] },
        {
          table: {
            widths: ['*', 'auto'],
            body: [
              [t.date, data.timestamp],
              ['Merchant', data.creatorId],
              ['Customer', data.walletAddress],
              [t.amount, `${data.amount} ${data.currency}`],
              [t.hash, data.transactionHash]
            ]
          }
        },
        { text: '\nThank you for using AgreeStellar!', style: 'footer' }
      ],
      styles: {
        header: { fontSize: 22, bold: true, margin: [0, 0, 0, 20] },
        footer: { fontSize: 10, italics: true, alignment: 'center', margin: [0, 20, 0, 0] }
      }
    };
  }

  /**
   * Calculate SHA-256 hash of buffer
   */
  calculateHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}

module.exports = { InvoiceService };
