const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Pluggable sanctions / risk providers.
 *
 * Every provider exposes a single async method:
 *
 *   provider.screenAddress(walletAddress) -> Promise<{
 *     riskLevel:    'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN',
 *     riskScore:    number,            // 0..100
 *     flaggedLists: string[],          // e.g. ['OFAC SDN', 'UN Consolidated']
 *     reason:       string|null,
 *     provider:     string,            // identifier of this provider
 *     raw?:         any,               // verbatim provider payload
 *   }>
 *
 * If a provider throws, the service treats it as a provider error and applies
 * the configured fail-open / fail-closed policy.
 */

class StaticListSanctionsProvider {
  /**
   * Built-in fallback: a static OFAC/UN/EU/UK address list bundled in process
   * memory. Useful in dev/test when no upstream API key is configured. Treat
   * production as configured-with-an-external-provider.
   *
   * @param {{ list?: Iterable<string>, name?: string }} [opts]
   */
  constructor(opts = {}) {
    this.name = opts.name || 'static-list';
    this.flaggedAddresses = new Map();
    if (opts.list) {
      for (const entry of opts.list) {
        if (typeof entry === 'string') {
          this.flaggedAddresses.set(entry.toUpperCase(), {
            riskLevel: 'HIGH',
            riskScore: 100,
            flaggedLists: ['OFAC SDN'],
            reason: 'Address present in built-in sanctions list',
          });
        } else if (entry && typeof entry === 'object' && entry.address) {
          this.flaggedAddresses.set(String(entry.address).toUpperCase(), {
            riskLevel: entry.riskLevel || 'HIGH',
            riskScore: entry.riskScore != null ? Number(entry.riskScore) : 100,
            flaggedLists: Array.isArray(entry.flaggedLists)
              ? entry.flaggedLists.slice()
              : ['OFAC SDN'],
            reason: entry.reason || 'Address present in built-in sanctions list',
          });
        }
      }
    }
  }

  // eslint-disable-next-line require-await
  async screenAddress(walletAddress) {
    const key = String(walletAddress || '').toUpperCase();
    const hit = this.flaggedAddresses.get(key);
    if (hit) {
      return { ...hit, provider: this.name };
    }
    return {
      riskLevel: 'LOW',
      riskScore: 0,
      flaggedLists: [],
      reason: null,
      provider: this.name,
    };
  }
}

/**
 * HTTP-backed sanctions provider — issues GET <baseUrl>/<address> with an
 * `Authorization: Token <apiKey>` header. The shape matches Chainalysis
 * Address Screening + Elliptic Wallet Risk closely enough that either can be
 * dropped in by setting SANCTIONS_PROVIDER_URL.
 *
 * The response is parsed loosely so we support several upstreams without
 * schema-locking. Anything that maps to risk/score/lists works.
 */
class HttpSanctionsProvider {
  /**
   * @param {{
   *   name?: string,
   *   baseUrl: string,
   *   apiKey?: string,
   *   timeoutMs?: number,
   *   pathTemplate?: string,
   *   httpClient?: typeof defaultHttpRequest,
   * }} opts
   */
  constructor(opts = {}) {
    if (!opts.baseUrl) {
      throw new Error('HttpSanctionsProvider: baseUrl is required');
    }
    this.name = opts.name || 'http-sanctions-provider';
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey || null;
    this.timeoutMs = opts.timeoutMs || 5000;
    this.pathTemplate = opts.pathTemplate || '/v1/address/{address}';
    this.httpClient = opts.httpClient || defaultHttpRequest;
  }

  async screenAddress(walletAddress) {
    const url =
      this.baseUrl +
      this.pathTemplate.replace(
        '{address}',
        encodeURIComponent(String(walletAddress))
      );
    const headers = { Accept: 'application/json' };
    if (this.apiKey) headers.Authorization = `Token ${this.apiKey}`;

    const response = await this.httpClient({
      url,
      method: 'GET',
      headers,
      timeoutMs: this.timeoutMs,
    });

    if (response.statusCode >= 400) {
      throw new Error(
        `Sanctions provider responded with HTTP ${response.statusCode}`
      );
    }

    return parseProviderResponse(response.body, this.name);
  }
}

function parseProviderResponse(body, providerName) {
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch (_e) {
      parsed = {};
    }
  }
  parsed = parsed || {};

  const riskLevel = normalizeRiskLevel(
    parsed.riskLevel || parsed.risk || parsed.risk_severity
  );
  const riskScore = Number(
    parsed.riskScore != null ? parsed.riskScore : parsed.score || 0
  );
  const flaggedLists = Array.isArray(parsed.flaggedLists)
    ? parsed.flaggedLists.slice()
    : Array.isArray(parsed.lists)
      ? parsed.lists.slice()
      : Array.isArray(parsed.sanctionLists)
        ? parsed.sanctionLists.slice()
        : [];
  const reason = parsed.reason || parsed.message || null;

  return {
    riskLevel: riskLevel || (riskScore >= 75 ? 'HIGH' : 'LOW'),
    riskScore: Number.isFinite(riskScore) ? riskScore : 0,
    flaggedLists,
    reason,
    provider: providerName,
    raw: parsed,
  };
}

function normalizeRiskLevel(value) {
  if (!value) return null;
  const v = String(value).toUpperCase();
  if (v === 'HIGH' || v === 'CRITICAL' || v === 'SEVERE') return 'HIGH';
  if (v === 'MEDIUM' || v === 'MODERATE') return 'MEDIUM';
  if (v === 'LOW' || v === 'CLEAN' || v === 'CLEAR') return 'LOW';
  if (v === 'UNKNOWN' || v === 'NOT_SCREENED') return 'UNKNOWN';
  return null;
}

/**
 * Tiny built-in HTTP client — avoids pulling axios into the hot path so the
 * provider can be used in environments where the bundled fetch is sufficient.
 *
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function defaultHttpRequest({ url, method, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;

    const req = lib.request(
      {
        method,
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, body });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = {
  StaticListSanctionsProvider,
  HttpSanctionsProvider,
  parseProviderResponse,
};
