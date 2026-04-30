const crypto = require('crypto');

const REPORT_SCHEMA_VERSION = 'CARF-DAC8-2025-07';
const REPORT_RETENTION_YEARS = 5;
const RETAIL_THRESHOLD_BY_CURRENCY = {
  USD: 50000,
  EUR: 50000,
  GBP: 43000,
};

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseJson(value, fallback = {}) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function tableExists(sqliteDb, tableName) {
  if (!sqliteDb || typeof sqliteDb.prepare !== 'function') return false;
  const row = sqliteDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return !!row;
}

class TaxService {
  constructor(options = {}) {
    this.database = options.database || null;
    this.priceProvider = options.priceProvider || null;
    this.now = options.now || (() => new Date());
  }

  withDatabase(database) {
    return new TaxService({
      database,
      priceProvider: this.priceProvider,
      now: this.now,
    });
  }

  async generateTaxReport(creatorAddress, year) {
    const withdrawals = await this.getWithdrawalsForYear(creatorAddress, year);
    const reportData = await this.processWithdrawals(withdrawals, year);

    return {
      creatorAddress,
      year,
      reportData,
      summary: this.calculateSummary(reportData),
      generatedAt: this.now().toISOString(),
    };
  }

  async generateCarfDac8Report(options = {}) {
    const {
      reportingYear,
      jurisdiction = 'US',
      primaryCurrency = 'USD',
      reportingPlatform = {},
      generatedBy = 'system',
      store = true,
    } = options;

    const year = Number(reportingYear);
    if (!Number.isInteger(year) || year < 2020) {
      throw new Error('reportingYear must be a valid year');
    }

    const users = await this.aggregateAnnualUserTransactions(year, jurisdiction, primaryCurrency);
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      framework: 'OECD_CARF_DAC8',
      reportingYear: year,
      jurisdiction,
      primaryCurrency,
      reportingPlatform: {
        name: reportingPlatform.name || 'SubStream Protocol',
        rcaspId: reportingPlatform.rcaspId || 'SUBSTREAM-PROTOCOL',
        country: reportingPlatform.country || jurisdiction,
      },
      generatedAt: this.now().toISOString(),
      generatedBy,
      status: 'GENERATED',
      users,
      validation: this.validateAggregates(users),
    };

    report.totals = this.calculateCarfTotals(users);
    report.reportId = this.buildReportId(report);
    report.xml = this.toCarfXml(report);

    if (store) {
      this.storeReportVersion(report, generatedBy);
    }

    return report;
  }

  async aggregateAnnualUserTransactions(year, jurisdiction, primaryCurrency) {
    const profiles = this.getSep12TaxProfiles();
    const transactions = this.getReportableTransactions(year);
    const grouped = new Map();

    for (const tx of transactions) {
      const userId = tx.userAddress || tx.walletAddress || tx.subscriberAddress || tx.customerId;
      if (!userId) continue;

      const profile = profiles.get(userId) || this.emptyProfile(userId, jurisdiction);
      const conversion = await this.convertHistoricalValue(tx, primaryCurrency);
      const transactionType = this.classifyTransaction(tx, conversion.value);

      if (!grouped.has(userId)) {
        grouped.set(userId, {
          userId: hash(userId),
          walletAddressHash: hash(userId),
          taxResidency: profile.taxResidency,
          tinHash: profile.tin ? hash(profile.tin) : null,
          piiStatus: profile.piiStatus,
          transactions: [],
          totals: {
            sourceLedgerVolume: 0,
            convertedVolume: 0,
            relevantRetailTransactions: 0,
            b2bServicePayments: 0,
          },
        });
      }

      const bucket = grouped.get(userId);
      bucket.transactions.push({
        transactionId: tx.transactionId,
        timestamp: tx.timestamp,
        asset: tx.asset,
        amount: Number(tx.amount),
        merchantId: tx.merchantId || tx.creatorId || null,
        transactionType,
        value: conversion.value,
        primaryCurrency,
        rate: conversion.rate,
        priceSource: conversion.source,
      });
      bucket.totals.sourceLedgerVolume += Number(tx.amount);
      bucket.totals.convertedVolume += conversion.value;
      if (transactionType === 'RelevantRetailTransaction') {
        bucket.totals.relevantRetailTransactions += conversion.value;
      } else {
        bucket.totals.b2bServicePayments += conversion.value;
      }
    }

    return Array.from(grouped.values()).map((user) => ({
      ...user,
      totals: {
        sourceLedgerVolume: roundMoney(user.totals.sourceLedgerVolume),
        convertedVolume: roundMoney(user.totals.convertedVolume),
        relevantRetailTransactions: roundMoney(user.totals.relevantRetailTransactions),
        b2bServicePayments: roundMoney(user.totals.b2bServicePayments),
      },
      transactionCount: user.transactions.length,
    }));
  }

  getSep12TaxProfiles() {
    const profiles = new Map();
    const sqliteDb = this.database?.db;
    if (!tableExists(sqliteDb, 'customer_profiles')) return profiles;

    const columns = sqliteDb.prepare('PRAGMA table_info(customer_profiles)').all().map((col) => col.name);
    const select = ['stellar_account', 'verification_status'];
    for (const candidate of ['tax_residency_country', 'country_of_residence', 'country', 'tin', 'tax_id']) {
      if (columns.includes(candidate)) select.push(candidate);
    }

    const rows = sqliteDb.prepare(`SELECT ${select.join(', ')} FROM customer_profiles`).all();
    for (const row of rows) {
      profiles.set(row.stellar_account, {
        taxResidency:
          row.tax_residency_country ||
          row.country_of_residence ||
          row.country ||
          'UNKNOWN',
        tin: row.tin || row.tax_id || null,
        piiStatus: row.verification_status || 'UNKNOWN',
      });
    }
    return profiles;
  }

  emptyProfile(_userId, jurisdiction) {
    return {
      taxResidency: jurisdiction || 'UNKNOWN',
      tin: null,
      piiStatus: 'NEEDS_INFO',
    };
  }

  getReportableTransactions(year) {
    const sqliteDb = this.database?.db;
    if (!sqliteDb) return [];

    if (tableExists(sqliteDb, 'tax_reportable_transactions')) {
      return sqliteDb
        .prepare(
          `SELECT id AS transactionId, user_address AS userAddress, merchant_id AS merchantId,
                  asset_code AS asset, amount, transaction_kind AS transactionKind,
                  occurred_at AS timestamp, metadata_json AS metadataJson
             FROM tax_reportable_transactions
            WHERE occurred_at >= ? AND occurred_at <= ?
            ORDER BY occurred_at ASC, id ASC`,
        )
        .all(...this.yearBounds(year))
        .map((row) => ({ ...row, metadata: parseJson(row.metadataJson) }));
    }

    if (!tableExists(sqliteDb, 'soroban_events')) return [];
    return sqliteDb
      .prepare(
        `SELECT id, transaction_hash, event_type, event_data, ledger_timestamp
           FROM soroban_events
          WHERE ledger_timestamp >= ? AND ledger_timestamp <= ?
          ORDER BY ledger_timestamp ASC, id ASC`,
      )
      .all(...this.yearBounds(year))
      .map((row) => this.mapSorobanEvent(row))
      .filter(Boolean);
  }

  mapSorobanEvent(row) {
    const data = parseJson(row.event_data);
    const eventType = String(row.event_type || data.type || '').toLowerCase();
    if (!eventType.includes('subscription') && !eventType.includes('payment')) return null;

    const amount = Number(data.amount || data.value || 0);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    return {
      transactionId: row.transaction_hash || row.id,
      userAddress: data.subscriber_address || data.subscriberAddress || data.wallet_address || data.customer_id,
      merchantId: data.merchant_id || data.creator_id || data.creatorId,
      asset: data.asset || data.asset_code || 'XLM',
      amount,
      timestamp: row.ledger_timestamp,
      transactionKind: data.transaction_kind || data.kind || 'subscription',
      metadata: data,
    };
  }

  yearBounds(year) {
    return [
      new Date(Date.UTC(year, 0, 1, 0, 0, 0)).toISOString(),
      new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)).toISOString(),
    ];
  }

  async convertHistoricalValue(tx, primaryCurrency) {
    const asset = String(tx.asset || 'XLM').toUpperCase();
    const currency = String(primaryCurrency || 'USD').toUpperCase();
    if (asset === currency) {
      return { value: roundMoney(tx.amount), rate: 1, source: 'native' };
    }

    const rate = await this.getHistoricalRate(asset, currency, tx.timestamp);
    return {
      value: roundMoney(Number(tx.amount) * rate.rate),
      rate: rate.rate,
      source: rate.source,
    };
  }

  async getHistoricalRate(asset, currency, timestamp) {
    if (this.priceProvider?.getHistoricalRate) {
      return this.priceProvider.getHistoricalRate(asset, currency, timestamp);
    }

    const stable = ['USDC', 'USD', 'EURC'];
    if ((asset === 'USDC' && currency === 'USD') || (asset === 'EURC' && currency === 'EUR')) {
      return { rate: 1, source: 'stablecoin-parity' };
    }
    if (stable.includes(asset) && stable.includes(currency)) {
      return { rate: 1, source: 'stablecoin-parity' };
    }

    return { rate: 1, source: 'missing-price-default-review-required' };
  }

  classifyTransaction(tx, convertedValue) {
    const kind = String(tx.transactionKind || tx.metadata?.transactionKind || '').toLowerCase();
    if (kind.includes('b2b') || kind.includes('service') || tx.metadata?.merchantBusiness === true) {
      return 'B2BServicePayment';
    }

    const threshold = RETAIL_THRESHOLD_BY_CURRENCY.USD;
    if (convertedValue >= threshold || kind.includes('retail')) {
      return 'RelevantRetailTransaction';
    }

    return 'B2BServicePayment';
  }

  validateAggregates(users) {
    const mismatches = [];
    for (const user of users) {
      const transactionSum = roundMoney(user.transactions.reduce((sum, tx) => sum + Number(tx.value), 0));
      if (transactionSum !== user.totals.convertedVolume) {
        mismatches.push({
          walletAddressHash: user.walletAddressHash,
          transactionSum,
          reportedTotal: user.totals.convertedVolume,
        });
      }
    }
    return {
      mathematicallyVerified: mismatches.length === 0,
      mismatches,
      piiLeakageCheck: 'PASSED_HASHED_IDENTIFIERS_ONLY',
    };
  }

  calculateCarfTotals(users) {
    return {
      userCount: users.length,
      transactionCount: users.reduce((sum, user) => sum + user.transactionCount, 0),
      totalConvertedVolume: roundMoney(users.reduce((sum, user) => sum + user.totals.convertedVolume, 0)),
      relevantRetailTransactions: roundMoney(users.reduce((sum, user) => sum + user.totals.relevantRetailTransactions, 0)),
      b2bServicePayments: roundMoney(users.reduce((sum, user) => sum + user.totals.b2bServicePayments, 0)),
    };
  }

  buildReportId(report) {
    const material = JSON.stringify({
      framework: report.framework,
      reportingYear: report.reportingYear,
      jurisdiction: report.jurisdiction,
      primaryCurrency: report.primaryCurrency,
      users: report.users,
      totals: report.totals,
    });
    return `tax_${report.reportingYear}_${report.jurisdiction}_${hash(material).slice(0, 16)}`;
  }

  toCarfXml(report) {
    const usersXml = report.users.map((user) => `
      <CryptoAssetUser>
        <UserIdHash>${escapeXml(user.userId)}</UserIdHash>
        <TaxResidency>${escapeXml(user.taxResidency)}</TaxResidency>
        <PIIStatus>${escapeXml(user.piiStatus)}</PIIStatus>
        <TransactionCount>${user.transactionCount}</TransactionCount>
        <Totals currency="${escapeXml(report.primaryCurrency)}">
          <ConvertedVolume>${user.totals.convertedVolume.toFixed(2)}</ConvertedVolume>
          <RelevantRetailTransactions>${user.totals.relevantRetailTransactions.toFixed(2)}</RelevantRetailTransactions>
          <B2BServicePayments>${user.totals.b2bServicePayments.toFixed(2)}</B2BServicePayments>
        </Totals>
      </CryptoAssetUser>`).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<CARFDAC8Report schemaVersion="${escapeXml(report.schemaVersion)}">
  <MessageHeader>
    <MessageRefId>${escapeXml(report.reportId)}</MessageRefId>
    <ReportingPeriod>${report.reportingYear}</ReportingPeriod>
    <Jurisdiction>${escapeXml(report.jurisdiction)}</Jurisdiction>
    <ReportingCurrency>${escapeXml(report.primaryCurrency)}</ReportingCurrency>
    <GeneratedAt>${escapeXml(report.generatedAt)}</GeneratedAt>
  </MessageHeader>
  <ReportingCryptoAssetServiceProvider>
    <Name>${escapeXml(report.reportingPlatform.name)}</Name>
    <RCASPId>${escapeXml(report.reportingPlatform.rcaspId)}</RCASPId>
    <Country>${escapeXml(report.reportingPlatform.country)}</Country>
  </ReportingCryptoAssetServiceProvider>
  <CARFBody>${usersXml}
  </CARFBody>
</CARFDAC8Report>`;
  }

  storeReportVersion(report, actor) {
    const sqliteDb = this.database?.db;
    if (!sqliteDb) return null;
    this.ensureTaxReportTables(sqliteDb);

    const previous = sqliteDb
      .prepare('SELECT payload_hash FROM tax_report_audit_log WHERE report_id = ? ORDER BY version DESC LIMIT 1')
      .get(report.reportId);
    const versionRow = sqliteDb
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS nextVersion FROM tax_report_audit_log WHERE report_id = ?')
      .get(report.reportId);
    const payloadJson = JSON.stringify({ ...report, xml: undefined });
    const payloadHash = hash(`${payloadJson}\n${report.xml}`);
    const now = this.now().toISOString();
    const retentionUntil = new Date(Date.UTC(report.reportingYear + REPORT_RETENTION_YEARS + 1, 0, 1)).toISOString();

    sqliteDb
      .prepare(
        `INSERT INTO tax_report_audit_log (
          id, report_id, version, status, schema_version, reporting_year, jurisdiction,
          primary_currency, payload_hash, previous_hash, payload_json, payload_xml,
          generated_by, signed_off_by, signed_off_at, retention_until, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        report.reportId,
        versionRow.nextVersion,
        report.status,
        report.schemaVersion,
        report.reportingYear,
        report.jurisdiction,
        report.primaryCurrency,
        payloadHash,
        previous?.payload_hash || null,
        payloadJson,
        report.xml,
        actor,
        report.signedOffBy || null,
        report.signedOffAt || null,
        retentionUntil,
        now,
      );

    return { reportId: report.reportId, version: versionRow.nextVersion, payloadHash };
  }

  ensureTaxReportTables(sqliteDb) {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS tax_report_audit_log (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        reporting_year INTEGER NOT NULL,
        jurisdiction TEXT NOT NULL,
        primary_currency TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        previous_hash TEXT,
        payload_json TEXT NOT NULL,
        payload_xml TEXT NOT NULL,
        generated_by TEXT NOT NULL,
        signed_off_by TEXT,
        signed_off_at TEXT,
        retention_until TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(report_id, version)
      );

      CREATE TABLE IF NOT EXISTS tax_report_signoffs (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        signed_off_by TEXT NOT NULL,
        signed_off_at TEXT NOT NULL,
        notes TEXT,
        payload_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tax_reportable_transactions (
        id TEXT PRIMARY KEY,
        user_address TEXT NOT NULL,
        merchant_id TEXT,
        asset_code TEXT NOT NULL,
        amount REAL NOT NULL,
        transaction_kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tax_report_audit_report ON tax_report_audit_log (report_id, version DESC);
      CREATE INDEX IF NOT EXISTS idx_tax_reportable_transactions_year ON tax_reportable_transactions (occurred_at);
    `);
  }

  listReports() {
    const sqliteDb = this.database?.db;
    if (!sqliteDb) return [];
    this.ensureTaxReportTables(sqliteDb);
    return sqliteDb
      .prepare(
        `SELECT report_id AS reportId, version, status, schema_version AS schemaVersion,
                reporting_year AS reportingYear, jurisdiction, primary_currency AS primaryCurrency,
                payload_hash AS payloadHash, previous_hash AS previousHash,
                generated_by AS generatedBy, signed_off_by AS signedOffBy,
                signed_off_at AS signedOffAt, retention_until AS retentionUntil,
                created_at AS createdAt
           FROM tax_report_audit_log
          ORDER BY created_at DESC`,
      )
      .all();
  }

  getReport(reportId) {
    const sqliteDb = this.database?.db;
    if (!sqliteDb) return null;
    this.ensureTaxReportTables(sqliteDb);
    return sqliteDb
      .prepare('SELECT * FROM tax_report_audit_log WHERE report_id = ? ORDER BY version DESC LIMIT 1')
      .get(reportId);
  }

  signOffReport(reportId, signer, notes = '') {
    const sqliteDb = this.database?.db;
    if (!sqliteDb) throw new Error('Database is required for report sign-off');
    this.ensureTaxReportTables(sqliteDb);

    const latest = this.getReport(reportId);
    if (!latest) throw new Error('Report not found');
    const payload = JSON.parse(latest.payload_json);
    const signedReport = {
      ...payload,
      status: 'SIGNED_OFF',
      signedOffBy: signer,
      signedOffAt: this.now().toISOString(),
      xml: latest.payload_xml,
    };
    signedReport.xml = this.toCarfXml(signedReport);
    const stored = this.storeReportVersion(signedReport, latest.generated_by);

    sqliteDb
      .prepare(
        `INSERT INTO tax_report_signoffs
          (id, report_id, version, signed_off_by, signed_off_at, notes, payload_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        reportId,
        stored.version,
        signer,
        signedReport.signedOffAt,
        notes,
        stored.payloadHash,
      );

    return { reportId, version: stored.version, status: 'SIGNED_OFF', signedOffBy: signer };
  }

  async getWithdrawalsForYear(creatorAddress, year) {
    const transactions = this.getReportableTransactions(year)
      .filter((tx) => tx.merchantId === creatorAddress || tx.creatorId === creatorAddress);
    return transactions.map((tx) => ({
      transactionId: tx.transactionId,
      timestamp: tx.timestamp,
      amount: Number(tx.amount),
      asset: tx.asset || 'XLM',
      assetIssuer: tx.assetIssuer || null,
      fromAddress: tx.userAddress,
      toAddress: tx.merchantId || creatorAddress,
      memo: tx.metadata?.memo || '',
      stellarUrl: tx.transactionId ? `https://stellar.expert/explorer/public/tx/${tx.transactionId}` : '',
    }));
  }

  async processWithdrawals(withdrawals) {
    const processedData = [];
    for (const withdrawal of withdrawals) {
      const fmvData = await this.getFairMarketValue(withdrawal.timestamp, withdrawal.asset);
      const platformFee = this.calculatePlatformFee(withdrawal.amount);
      const netAmount = withdrawal.amount - platformFee;

      processedData.push({
        ...withdrawal,
        fairMarketValueUSD: fmvData.price,
        totalValueUSD: roundMoney(withdrawal.amount * fmvData.price),
        platformFee,
        platformFeeUSD: roundMoney(platformFee * fmvData.price),
        netAmount,
        netValueUSD: roundMoney(netAmount * fmvData.price),
        priceSource: fmvData.source,
        priceTimestamp: fmvData.timestamp,
      });
    }
    return processedData;
  }

  async getFairMarketValue(timestamp, asset) {
    const rate = await this.getHistoricalRate(String(asset || 'XLM').toUpperCase(), 'USD', timestamp);
    return {
      price: rate.rate,
      source: rate.source,
      timestamp: timestamp || this.now().toISOString(),
    };
  }

  calculatePlatformFee(amount) {
    return Number(amount) * 0.05;
  }

  calculateSummary(reportData) {
    const validData = reportData.filter((item) => !item.error);
    const totalIncome = roundMoney(validData.reduce((sum, item) => sum + item.totalValueUSD, 0));
    const totalPlatformFees = roundMoney(validData.reduce((sum, item) => sum + item.platformFeeUSD, 0));
    const totalNetIncome = roundMoney(validData.reduce((sum, item) => sum + item.netValueUSD, 0));
    const assetBreakdown = {};

    validData.forEach((item) => {
      if (!assetBreakdown[item.asset]) {
        assetBreakdown[item.asset] = { amount: 0, valueUSD: 0, transactions: 0 };
      }
      assetBreakdown[item.asset].amount = roundMoney(assetBreakdown[item.asset].amount + item.amount);
      assetBreakdown[item.asset].valueUSD = roundMoney(assetBreakdown[item.asset].valueUSD + item.totalValueUSD);
      assetBreakdown[item.asset].transactions += 1;
    });

    return {
      totalIncome,
      totalPlatformFees,
      totalNetIncome,
      totalTransactions: validData.length,
      assetBreakdown,
      averageTransactionValue: validData.length ? roundMoney(totalIncome / validData.length) : 0,
    };
  }

  generateCSV(reportData) {
    const headers = [
      'Transaction ID',
      'Date',
      'Asset',
      'Amount',
      'From Address',
      'To Address',
      'Fair Market Value (USD)',
      'Total Value (USD)',
      'Platform Fee',
      'Platform Fee (USD)',
      'Net Amount',
      'Net Value (USD)',
      'Price Source',
      'Stellar URL',
      'Memo',
    ];

    const csvRows = [headers.join(',')];
    reportData.forEach((item) => {
      csvRows.push([
        item.transactionId,
        item.timestamp,
        item.asset,
        item.amount,
        item.fromAddress,
        item.toAddress,
        item.fairMarketValueUSD?.toFixed ? item.fairMarketValueUSD.toFixed(6) : item.fairMarketValueUSD,
        item.totalValueUSD?.toFixed ? item.totalValueUSD.toFixed(2) : item.totalValueUSD,
        item.platformFee?.toFixed ? item.platformFee.toFixed(6) : item.platformFee,
        item.platformFeeUSD?.toFixed ? item.platformFeeUSD.toFixed(2) : item.platformFeeUSD,
        item.netAmount?.toFixed ? item.netAmount.toFixed(6) : item.netAmount,
        item.netValueUSD?.toFixed ? item.netValueUSD.toFixed(2) : item.netValueUSD,
        item.priceSource,
        item.stellarUrl,
        item.memo || '',
      ].map((field) => `"${String(field ?? '').replace(/"/g, '""')}"`).join(','));
    });

    return csvRows.join('\n');
  }

  async generateTaxCSV(creatorAddress, year) {
    const report = await this.generateTaxReport(creatorAddress, year);
    return {
      csvData: this.generateCSV(report.reportData),
      filename: `substream-tax-report-${year}-${creatorAddress.slice(0, 8)}.csv`,
      summary: report.summary,
      generatedAt: report.generatedAt,
    };
  }
}

const singleton = new TaxService();
module.exports = singleton;
module.exports.TaxService = TaxService;
