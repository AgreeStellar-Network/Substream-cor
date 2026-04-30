const express = require('express');
const router = express.Router();
const taxService = require('../services/taxService');

function getService(req) {
  const database = req.app?.get?.('database') || req.database || null;
  return database ? taxService.withDatabase(database) : taxService;
}

function parseYear(year) {
  const parsed = Number(year);
  return Number.isInteger(parsed) ? parsed : null;
}

router.post('/carf-dac8/report', async (req, res) => {
  try {
    const year = parseYear(req.body.reportingYear);
    if (!year) {
      return res.status(400).json({ success: false, error: 'reportingYear is required' });
    }

    const report = await getService(req).generateCarfDac8Report({
      reportingYear: year,
      jurisdiction: req.body.jurisdiction || 'US',
      primaryCurrency: req.body.primaryCurrency || 'USD',
      reportingPlatform: req.body.reportingPlatform || {},
      generatedBy: req.user?.id || req.body.generatedBy || 'system',
      store: req.body.store !== false,
    });

    return res.status(201).json({ success: true, data: report });
  } catch (error) {
    console.error('Error generating CARF/DAC8 report:', error);
    return res.status(500).json({ success: false, error: 'Failed to generate CARF/DAC8 report' });
  }
});

router.get('/admin/reports', (req, res) => {
  try {
    return res.json({ success: true, data: getService(req).listReports() });
  } catch (error) {
    console.error('Error listing tax reports:', error);
    return res.status(500).json({ success: false, error: 'Failed to list tax reports' });
  }
});

router.get('/admin/reports/:reportId', (req, res) => {
  try {
    const report = getService(req).getReport(req.params.reportId);
    if (!report) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    return res.json({
      success: true,
      data: {
        reportId: report.report_id,
        version: report.version,
        status: report.status,
        payloadHash: report.payload_hash,
        previousHash: report.previous_hash,
        json: JSON.parse(report.payload_json),
        xml: report.payload_xml,
      },
    });
  } catch (error) {
    console.error('Error fetching tax report:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch tax report' });
  }
});

router.post('/admin/reports/:reportId/sign-off', (req, res) => {
  try {
    const signer = req.user?.id || req.body.signedOffBy;
    if (!signer) {
      return res.status(400).json({ success: false, error: 'signedOffBy is required' });
    }

    const result = getService(req).signOffReport(req.params.reportId, signer, req.body.notes || '');
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error.message === 'Report not found') {
      return res.status(404).json({ success: false, error: error.message });
    }
    console.error('Error signing off tax report:', error);
    return res.status(500).json({ success: false, error: 'Failed to sign off tax report' });
  }
});

router.get('/report/:creatorAddress/:year', async (req, res) => {
  try {
    const { creatorAddress, year } = req.params;
    const parsedYear = parseYear(year);
    if (!creatorAddress || !parsedYear) {
      return res.status(400).json({ success: false, error: 'Creator address and year are required' });
    }

    const report = await getService(req).generateTaxReport(creatorAddress, parsedYear);
    return res.json({ success: true, data: report });
  } catch (error) {
    console.error('Error generating tax report:', error);
    return res.status(500).json({ success: false, error: 'Failed to generate tax report' });
  }
});

router.get('/csv/:creatorAddress/:year', async (req, res) => {
  try {
    const { creatorAddress, year } = req.params;
    const parsedYear = parseYear(year);
    if (!creatorAddress || !parsedYear) {
      return res.status(400).json({ success: false, error: 'Creator address and year are required' });
    }

    const csvReport = await getService(req).generateTaxCSV(creatorAddress, parsedYear);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${csvReport.filename}"`);
    return res.send(csvReport.csvData);
  } catch (error) {
    console.error('Error generating tax CSV:', error);
    return res.status(500).json({ success: false, error: 'Failed to generate tax CSV' });
  }
});

router.get('/summary/:creatorAddress/:year', async (req, res) => {
  try {
    const { creatorAddress, year } = req.params;
    const parsedYear = parseYear(year);
    if (!creatorAddress || !parsedYear) {
      return res.status(400).json({ success: false, error: 'Creator address and year are required' });
    }

    const report = await getService(req).generateTaxReport(creatorAddress, parsedYear);
    return res.json({
      success: true,
      data: {
        creatorAddress,
        year: parsedYear,
        summary: report.summary,
        generatedAt: report.generatedAt,
      },
    });
  } catch (error) {
    console.error('Error generating tax summary:', error);
    return res.status(500).json({ success: false, error: 'Failed to generate tax summary' });
  }
});

router.get('/years/:creatorAddress', async (req, res) => {
  try {
    const { creatorAddress } = req.params;
    if (!creatorAddress) {
      return res.status(400).json({ success: false, error: 'Creator address is required' });
    }

    const currentYear = new Date().getFullYear();
    const years = [];
    const startYear = Math.max(2020, currentYear - 5);
    for (let year = startYear; year <= currentYear; year++) years.push(year);

    return res.json({
      success: true,
      data: { creatorAddress, availableYears: years, currentYear },
    });
  } catch (error) {
    console.error('Error fetching available years:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch available years' });
  }
});

router.get('/fmv/:asset/:timestamp', async (req, res) => {
  try {
    const { asset, timestamp } = req.params;
    if (!asset || !timestamp) {
      return res.status(400).json({ success: false, error: 'Asset and timestamp are required' });
    }

    const fmvData = await getService(req).getFairMarketValue(timestamp, asset.toUpperCase());
    return res.json({ success: true, data: fmvData });
  } catch (error) {
    console.error('Error fetching fair market value:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch fair market value' });
  }
});

module.exports = router;
