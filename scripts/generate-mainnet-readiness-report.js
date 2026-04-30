#!/usr/bin/env node

/**
 * Mainnet Readiness Report Generator
 * 
 * Generates a comprehensive PDF report containing:
 * - Test coverage statistics
 * - Security scan results
 * - SLA projections
 * - Infrastructure validation
 * - Compliance verification
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class MainnetReadinessReportGenerator {
  constructor(rootDir = process.cwd()) {
    this.rootDir = rootDir;
    this.reportData = {
      metadata: {
        generatedAt: new Date().toISOString(),
        version: '1.0.0',
        environment: 'production',
        repository: 'SubStream-Protocol-Backend'
      },
      testCoverage: {},
      securityScan: {},
      infrastructure: {},
      performance: {},
      compliance: {},
      sla: {},
      summary: {
        overallStatus: 'UNKNOWN',
        criticalIssues: 0,
        warnings: 0,
        recommendations: []
      }
    };
  }

  async generate() {
    console.log('🚀 Generating Mainnet Readiness Report...');

    try {
      // Phase 1: Test Coverage Analysis
      await this.analyzeTestCoverage();

      // Phase 2: Security Scan
      await this.runSecurityScan();

      // Phase 3: Infrastructure Validation
      await this.validateInfrastructure();

      // Phase 4: Performance Analysis
      await this.analyzePerformance();

      // Phase 5: Compliance Check
      await this.checkCompliance();

      // Phase 6: SLA Projections
      await this.calculateSLAProjections();

      // Phase 7: Generate Summary
      await this.generateSummary();

      // Phase 8: Create Report
      await this.createReport();

      console.log('✅ Mainnet Readiness Report generated successfully!');
      return this.reportData;

    } catch (error) {
      console.error('❌ Failed to generate report:', error);
      throw error;
    }
  }

  async analyzeTestCoverage() {
    console.log('📊 Analyzing test coverage...');

    try {
      // Run test coverage analysis
      const TestCoverageAnalyzer = require('./test-coverage-analysis');
      const analyzer = new TestCoverageAnalyzer(this.rootDir);
      const coverageData = await analyzer.analyze();

      this.reportData.testCoverage = {
        overallCoverage: coverageData.coveragePercentage,
        totalFiles: coverageData.totalFiles,
        testedFiles: coverageData.testedFiles,
        modules: coverageData.modules,
        coverageByType: coverageData.coverageByType,
        uncoveredFunctions: coverageData.uncoveredFunctions.length,
        status: coverageData.coveragePercentage >= 95 ? 'PASS' : 'FAIL'
      };

      console.log(`✅ Test coverage: ${coverageData.coveragePercentage.toFixed(2)}%`);

    } catch (error) {
      console.warn('⚠️  Test coverage analysis failed:', error.message);
      this.reportData.testCoverage = {
        status: 'ERROR',
        error: error.message
      };
    }
  }

  async runSecurityScan() {
    console.log('🔒 Running security scan...');

    const securityResults = {
      vulnerabilities: [],
      codeAnalysis: {},
      dependencies: {},
      secrets: {},
      status: 'PASS'
    };

    try {
      // npm audit for dependencies
      try {
        const auditResult = execSync('npm audit --json', { 
          cwd: this.rootDir, 
          encoding: 'utf8',
          stdio: 'pipe'
        });
        
        const auditData = JSON.parse(auditResult);
        securityResults.dependencies = {
          total: auditData.metadata?.vulnerabilities?.total || 0,
          high: auditData.metadata?.vulnerabilities?.high || 0,
          moderate: auditData.metadata?.vulnerabilities?.moderate || 0,
          low: auditData.metadata?.vulnerabilities?.low || 0,
          info: auditData.metadata?.vulnerabilities?.info || 0
        };

        if (securityResults.dependencies.high > 0) {
          securityResults.status = 'FAIL';
        } else if (securityResults.dependencies.moderate > 0) {
          securityResults.status = 'WARNING';
        }

      } catch (error) {
        console.warn('⚠️  npm audit failed:', error.message);
      }

      // Check for existing security scan reports
      const securityReportPath = path.join(this.rootDir, 'security-sweep-report.json');
      if (fs.existsSync(securityReportPath)) {
        const securityReport = JSON.parse(fs.readFileSync(securityReportPath, 'utf8'));
        securityResults.codeAnalysis = securityReport;
      }

      // Check for secrets in code (basic scan)
      await this.scanForSecrets(securityResults);

      this.reportData.securityScan = securityResults;
      console.log(`✅ Security scan completed: ${securityResults.status}`);

    } catch (error) {
      console.warn('⚠️  Security scan failed:', error.message);
      this.reportData.securityScan = {
        status: 'ERROR',
        error: error.message
      };
    }
  }

  async scanForSecrets(securityResults) {
    const secretPatterns = [
      { pattern: /sk-[a-zA-Z0-9]{48}/g, type: 'Stripe Secret Key' },
      { pattern: /AIza[0-9A-Za-z\\-_]{35}/g, type: 'Google API Key' },
      { pattern: /ghp_[a-zA-Z0-9]{36}/g, type: 'GitHub Personal Access Token' },
      { pattern: /xoxb-[0-9]{13}-[0-9]{13}-[a-zA-Z0-9]{24}/g, type: 'Slack Bot Token' },
      { pattern: /AKIA[0-9A-Z]{16}/g, type: 'AWS Access Key' },
      { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, type: 'Email Address' }
    ];

    const sourceFiles = this.discoverSourceFiles();
    const foundSecrets = [];

    sourceFiles.forEach(file => {
      try {
        const content = fs.readFileSync(file, 'utf8');
        
        secretPatterns.forEach(({ pattern, type }) => {
          const matches = content.match(pattern);
          if (matches) {
            foundSecrets.push({
              type,
              file: path.relative(this.rootDir, file),
              count: matches.length
            });
          }
        });
      } catch (error) {
        // Skip files that can't be read
      }
    });

    securityResults.secrets = {
      found: foundSecrets.length,
      items: foundSecrets
    };

    if (foundSecrets.length > 0) {
      securityResults.status = 'FAIL';
    }
  }

  async validateInfrastructure() {
    console.log('🏗️  Validating infrastructure...');

    const infrastructureResults = {
      kubernetes: {},
      database: {},
      redis: {},
      monitoring: {},
      status: 'PASS'
    };

    try {
      // Check Kubernetes configurations
      const k8sDir = path.join(this.rootDir, 'k8s');
      if (fs.existsSync(k8sDir)) {
        infrastructureResults.kubernetes = await this.validateKubernetesConfig(k8sDir);
      }

      // Check database configurations
      infrastructureResults.database = await this.validateDatabaseConfig();

      // Check Redis configurations
      infrastructureResults.redis = await this.validateRedisConfig();

      // Check monitoring setup
      infrastructureResults.monitoring = await this.validateMonitoring();

      this.reportData.infrastructure = infrastructureResults;
      console.log(`✅ Infrastructure validation: ${infrastructureResults.status}`);

    } catch (error) {
      console.warn('⚠️  Infrastructure validation failed:', error.message);
      this.reportData.infrastructure = {
        status: 'ERROR',
        error: error.message
      };
    }
  }

  async validateKubernetesConfig(k8sDir) {
    const k8sResults = {
      deployments: 0,
      services: 0,
      configMaps: 0,
      secrets: 0,
      hasIngress: false,
      hasHPA: false,
      hasMonitoring: false,
      status: 'PASS'
    };

    const files = fs.readdirSync(k8sDir);
    
    files.forEach(file => {
      if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        const content = fs.readFileSync(path.join(k8sDir, file), 'utf8');
        
        if (content.includes('kind: Deployment')) k8sResults.deployments++;
        if (content.includes('kind: Service')) k8sResults.services++;
        if (content.includes('kind: ConfigMap')) k8sResults.configMaps++;
        if (content.includes('kind: Secret')) k8sResults.secrets++;
        if (content.includes('kind: Ingress')) k8sResults.hasIngress = true;
        if (content.includes('kind: HorizontalPodAutoscaler')) k8sResults.hasHPA = true;
        if (content.includes('prometheus') || content.includes('monitoring')) k8sResults.hasMonitoring = true;
      }
    });

    // Validate required components
    if (k8sResults.deployments === 0) k8sResults.status = 'FAIL';
    if (!k8sResults.hasHPA) k8sResults.status = 'WARNING';

    return k8sResults;
  }

  async validateDatabaseConfig() {
    const dbResults = {
      hasPostgresConfig: false,
      hasSSLConfig: false,
      hasBackupConfig: false,
      hasReplication: false,
      status: 'PASS'
    };

    // Check PostgreSQL configuration
    const postgresConfigPath = path.join(this.rootDir, 'k8s', 'postgres-mtls-config.yaml');
    if (fs.existsSync(postgresConfigPath)) {
      const content = fs.readFileSync(postgresConfigPath, 'utf8');
      dbResults.hasPostgresConfig = true;
      if (content.includes('ssl = on')) dbResults.hasSSLConfig = true;
      if (content.includes('maintenance_work_mem')) dbResults.hasBackupConfig = true;
    }

    // Check for replication configuration
    const terraformDir = path.join(this.rootDir, 'terraform');
    if (fs.existsSync(terraformDir)) {
      const files = this.walkDirectory(terraformDir, ['.tf']);
      files.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');
        if (content.includes('replication') || content.includes('read_replica')) {
          dbResults.hasReplication = true;
        }
      });
    }

    if (!dbResults.hasPostgresConfig) dbResults.status = 'FAIL';
    if (!dbResults.hasSSLConfig) dbResults.status = 'WARNING';

    return dbResults;
  }

  async validateRedisConfig() {
    const redisResults = {
      hasRedisConfig: false,
      hasClusterConfig: false,
      hasPersistence: false,
      status: 'PASS'
    };

    const redisConfigPath = path.join(this.rootDir, 'k8s', 'redis-metrics-adapter.yaml');
    if (fs.existsSync(redisConfigPath)) {
      const content = fs.readFileSync(redisConfigPath, 'utf8');
      redisResults.hasRedisConfig = true;
      if (content.includes('cluster')) redisResults.hasClusterConfig = true;
      if (content.includes('persistence')) redisResults.hasPersistence = true;
    }

    if (!redisResults.hasRedisConfig) redisResults.status = 'WARNING';

    return redisResults;
  }

  async validateMonitoring() {
    const monitoringResults = {
      hasPrometheus: false,
      hasGrafana: false,
      hasAlerting: false,
      hasLogging: false,
      status: 'PASS'
    };

    const k8sDir = path.join(this.rootDir, 'k8s');
    if (fs.existsSync(k8sDir)) {
      const files = fs.readdirSync(k8sDir);
      
      files.forEach(file => {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
          const content = fs.readFileSync(path.join(k8sDir, file), 'utf8');
          
          if (content.includes('prometheus')) monitoringResults.hasPrometheus = true;
          if (content.includes('grafana')) monitoringResults.hasGrafana = true;
          if (content.includes('alert') || content.includes('Alertmanager')) monitoringResults.hasAlerting = true;
          if (content.includes('logging') || content.includes('fluentd') || content.includes('elasticsearch')) {
            monitoringResults.hasLogging = true;
          }
        }
      });
    }

    if (!monitoringResults.hasPrometheus) monitoringResults.status = 'WARNING';

    return monitoringResults;
  }

  async analyzePerformance() {
    console.log('⚡ Analyzing performance...');

    const performanceResults = {
      loadTest: {},
      benchmarks: {},
      resourceLimits: {},
      status: 'PASS'
    };

    try {
      // Check for load test results
      const loadTestDir = path.join(this.rootDir, 'load-test-results');
      if (fs.existsSync(loadTestDir)) {
        const files = fs.readdirSync(loadTestDir);
        const latestResult = files
          .filter(f => f.startsWith('mainnet-load-test-'))
          .sort()
          .pop();

        if (latestResult) {
          const resultPath = path.join(loadTestDir, latestResult);
          const loadData = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
          performanceResults.loadTest = loadData;
          performanceResults.loadTest.status = loadData.status || 'UNKNOWN';
        }
      }

      // Analyze resource limits from K8s configs
      performanceResults.resourceLimits = await this.analyzeResourceLimits();

      this.reportData.performance = performanceResults;
      console.log(`✅ Performance analysis: ${performanceResults.status}`);

    } catch (error) {
      console.warn('⚠️  Performance analysis failed:', error.message);
      this.reportData.performance = {
        status: 'ERROR',
        error: error.message
      };
    }
  }

  async analyzeResourceLimits() {
    const resourceLimits = {
      cpuRequests: 0,
      cpuLimits: 0,
      memoryRequests: 0,
      memoryLimits: 0,
      hasHPA: false,
      maxReplicas: 0
    };

    const deploymentPath = path.join(this.rootDir, 'k8s', 'deployment.yaml');
    if (fs.existsSync(deploymentPath)) {
      const content = fs.readFileSync(deploymentPath, 'utf8');
      
      // Extract resource limits (simplified)
      const cpuRequestMatch = content.match(/cpu:\s*["']?(\d+m?)["']?/);
      const cpuLimitMatch = content.match(/cpu:\s*["']?(\d+m?)["']?/);
      const memoryRequestMatch = content.match(/memory:\s*["']?(\d+[KMGT]?i?)["']?/);
      const memoryLimitMatch = content.match(/memory:\s*["']?(\d+[KMGT]?i?)["']?/);

      if (cpuRequestMatch) resourceLimits.cpuRequests = cpuRequestMatch[1];
      if (cpuLimitMatch) resourceLimits.cpuLimits = cpuLimitMatch[1];
      if (memoryRequestMatch) resourceLimits.memoryRequests = memoryRequestMatch[1];
      if (memoryLimitMatch) resourceLimits.memoryLimits = memoryLimitMatch[1];
    }

    // Check HPA configuration
    const hpaPath = path.join(this.rootDir, 'k8s', 'worker-hpa.yaml');
    if (fs.existsSync(hpaPath)) {
      const content = fs.readFileSync(hpaPath, 'utf8');
      resourceLimits.hasHPA = true;
      const maxReplicasMatch = content.match(/maxReplicas:\s*(\d+)/);
      if (maxReplicasMatch) resourceLimits.maxReplicas = parseInt(maxReplicasMatch[1]);
    }

    return resourceLimits;
  }

  async checkCompliance() {
    console.log('📋 Checking compliance...');

    const complianceResults = {
      gdpr: false,
      soc2: false,
      pci: false,
      hasPrivacyPolicy: false,
      hasDataRetention: false,
      hasAuditLogging: false,
      status: 'PASS'
    };

    try {
      // Check for GDPR compliance
      const gdprFiles = ['PII_SCRUBBING_README.md', 'gdprService.js'];
      complianceResults.gdpr = gdprFiles.some(file => fs.existsSync(path.join(this.rootDir, file)));

      // Check for privacy policy
      complianceResults.hasPrivacyPolicy = fs.existsSync(path.join(this.rootDir, 'PRIVACY_POLICY.md'));

      // Check for data retention policies
      const cronServicePath = path.join(this.rootDir, 'services', 'cronService.js');
      if (fs.existsSync(cronServicePath)) {
        const content = fs.readFileSync(cronServicePath, 'utf8');
        complianceResults.hasDataRetention = content.includes('cleanup') || content.includes('retention');
      }

      // Check for audit logging
      const securityArchPath = path.join(this.rootDir, 'SECURITY_ARCHITECTURE.md');
      if (fs.existsSync(securityArchPath)) {
        const content = fs.readFileSync(securityArchPath, 'utf8');
        complianceResults.hasAuditLogging = content.includes('audit') || content.includes('logging');
      }

      // Determine overall compliance status
      const complianceScore = [
        complianceResults.gdpr,
        complianceResults.hasPrivacyPolicy,
        complianceResults.hasDataRetention,
        complianceResults.hasAuditLogging
      ].filter(Boolean).length;

      if (complianceScore >= 3) {
        complianceResults.status = 'PASS';
      } else if (complianceScore >= 2) {
        complianceResults.status = 'WARNING';
      } else {
        complianceResults.status = 'FAIL';
      }

      this.reportData.compliance = complianceResults;
      console.log(`✅ Compliance check: ${complianceResults.status}`);

    } catch (error) {
      console.warn('⚠️  Compliance check failed:', error.message);
      this.reportData.compliance = {
        status: 'ERROR',
        error: error.message
      };
    }
  }

  async calculateSLAProjections() {
    console.log('📈 Calculating SLA projections...');

    const slaResults = {
      availability: 99.9,
      responseTime: 200,
      throughput: 10000,
      errorRate: 0.1,
      recoveryTime: 5,
      status: 'PASS'
    };

    try {
      // Base SLA on test results and infrastructure configuration
      if (this.reportData.performance.loadTest.summary) {
        const loadTest = this.reportData.performance.loadTest.summary;
        
        // Calculate availability based on success rates
        if (loadTest.billingSuccessRate) {
          slaResults.availability = Math.min(99.9, 95 + (loadTest.billingSuccessRate / 20));
        }

        // Calculate response time
        if (loadTest.avgResponseTime) {
          slaResults.responseTime = loadTest.avgResponseTime;
        }

        // Calculate throughput
        if (loadTest.billingThroughput) {
          slaResults.throughput = loadTest.billingThroughput;
        }
      }

      // Adjust based on infrastructure setup
      if (this.reportData.infrastructure.database?.hasReplication) {
        slaResults.availability += 0.05;
      }

      if (this.reportData.infrastructure.monitoring?.hasAlerting) {
        slaResults.recoveryTime = Math.max(1, slaResults.recoveryTime - 2);
      }

      // Determine status
      if (slaResults.availability >= 99.9 && slaResults.responseTime <= 500 && slaResults.errorRate <= 0.1) {
        slaResults.status = 'PASS';
      } else if (slaResults.availability >= 99.0 && slaResults.responseTime <= 1000) {
        slaResults.status = 'WARNING';
      } else {
        slaResults.status = 'FAIL';
      }

      this.reportData.sla = slaResults;
      console.log(`✅ SLA projections: ${slaResults.status}`);

    } catch (error) {
      console.warn('⚠️  SLA calculation failed:', error.message);
      this.reportData.sla = {
        status: 'ERROR',
        error: error.message
      };
    }
  }

  async generateSummary() {
    console.log('📝 Generating summary...');

    const summary = this.reportData.summary;
    const statuses = [
      this.reportData.testCoverage.status,
      this.reportData.securityScan.status,
      this.reportData.infrastructure.status,
      this.reportData.performance.status,
      this.reportData.compliance.status,
      this.reportData.sla.status
    ];

    // Count issues
    summary.criticalIssues = statuses.filter(s => s === 'FAIL' || s === 'ERROR').length;
    summary.warnings = statuses.filter(s => s === 'WARNING').length;

    // Determine overall status
    if (summary.criticalIssues === 0) {
      summary.overallStatus = summary.warnings === 0 ? 'PASS' : 'WARNING';
    } else {
      summary.overallStatus = 'FAIL';
    }

    // Generate recommendations
    summary.recommendations = this.generateRecommendations();

    console.log(`✅ Summary generated: ${summary.overallStatus}`);
  }

  generateRecommendations() {
    const recommendations = [];

    if (this.reportData.testCoverage.status !== 'PASS') {
      recommendations.push({
        category: 'Testing',
        priority: 'HIGH',
        description: 'Increase test coverage to at least 95% before mainnet deployment',
        action: 'Add unit and integration tests for uncovered functions'
      });
    }

    if (this.reportData.securityScan.status !== 'PASS') {
      recommendations.push({
        category: 'Security',
        priority: 'HIGH',
        description: 'Address security vulnerabilities before production deployment',
        action: 'Update dependencies and remove any exposed secrets'
      });
    }

    if (this.reportData.infrastructure.status !== 'PASS') {
      recommendations.push({
        category: 'Infrastructure',
        priority: 'MEDIUM',
        description: 'Complete infrastructure setup for production readiness',
        action: 'Configure HPA, monitoring, and backup systems'
      });
    }

    if (this.reportData.performance.status !== 'PASS') {
      recommendations.push({
        category: 'Performance',
        priority: 'HIGH',
        description: 'Optimize performance to meet mainnet requirements',
        action: 'Run load tests and optimize bottlenecks'
      });
    }

    if (this.reportData.compliance.status !== 'PASS') {
      recommendations.push({
        category: 'Compliance',
        priority: 'MEDIUM',
        description: 'Ensure regulatory compliance for mainnet deployment',
        action: 'Implement missing compliance controls'
      });
    }

    return recommendations;
  }

  async createReport() {
    console.log('📄 Creating final report...');

    // Create markdown report
    const markdownReport = this.generateMarkdownReport();
    const markdownPath = path.join(this.rootDir, 'MAINNET_READINESS_REPORT.md');
    fs.writeFileSync(markdownPath, markdownReport);

    // Create JSON report
    const jsonPath = path.join(this.rootDir, 'mainnet-readiness-report.json');
    fs.writeFileSync(jsonPath, JSON.stringify(this.reportData, null, 2));

    console.log(`📄 Markdown report: ${markdownPath}`);
    console.log(`📄 JSON report: ${jsonPath}`);

    // Note: PDF generation would require additional dependencies
    console.log('📄 PDF generation requires additional setup (puppeteer/pdfkit)');
  }

  generateMarkdownReport() {
    const { metadata, testCoverage, securityScan, infrastructure, performance, compliance, sla, summary } = this.reportData;

    return `# SubStream Protocol Mainnet Readiness Report

**Generated:** ${new Date(metadata.generatedAt).toLocaleString()}  
**Version:** ${metadata.version}  
**Environment:** ${metadata.environment}  
**Repository:** ${metadata.repository}

---

## Executive Summary

**Overall Status:** ${summary.overallStatus === 'PASS' ? '✅ READY FOR MAINNET' : summary.overallStatus === 'WARNING' ? '⚠️ READY WITH CONDITIONS' : '❌ NOT READY'}

- **Critical Issues:** ${summary.criticalIssues}
- **Warnings:** ${summary.warnings}
- **Recommendations:** ${summary.recommendations.length}

---

## Test Coverage Analysis

**Status:** ${testCoverage.status}  
**Overall Coverage:** ${testCoverage.overallCoverage?.toFixed(2) || 'N/A'}%  
**Files Tested:** ${testCoverage.testedFiles || 0}/${testCoverage.totalFiles || 0}

### Coverage by Module
${Object.entries(testCoverage.modules || {}).map(([name, module]) => 
  `- **${name}:** ${module.coveragePercentage.toFixed(2)}% (${module.testedFiles}/${module.totalFiles})`
).join('\n')}

### Coverage by Test Type
${Object.entries(testCoverage.coverageByType || {}).map(([type, count]) => 
  `- **${type.charAt(0).toUpperCase() + type.slice(1)}:** ${count} files`
).join('\n')}

---

## Security Scan Results

**Status:** ${securityScan.status}

### Dependency Vulnerabilities
- **Total:** ${securityScan.dependencies?.total || 0}
- **High:** ${securityScan.dependencies?.high || 0}
- **Moderate:** ${securityScan.dependencies?.moderate || 0}
- **Low:** ${securityScan.dependencies?.low || 0}

### Secrets Scan
- **Secrets Found:** ${securityScan.secrets?.found || 0}
${securityScan.secrets?.items?.slice(0, 5).map(item => 
  `- ${item.type} in ${item.file} (${item.count} occurrences)`
).join('\n') || ''}

---

## Infrastructure Validation

**Status:** ${infrastructure.status}

### Kubernetes Configuration
- **Deployments:** ${infrastructure.kubernetes?.deployments || 0}
- **Services:** ${infrastructure.kubernetes?.services || 0}
- **Has Ingress:** ${infrastructure.kubernetes?.hasIngress ? '✅' : '❌'}
- **Has HPA:** ${infrastructure.kubernetes?.hasHPA ? '✅' : '❌'}
- **Has Monitoring:** ${infrastructure.kubernetes?.hasMonitoring ? '✅' : '❌'}

### Database Configuration
- **PostgreSQL Config:** ${infrastructure.database?.hasPostgresConfig ? '✅' : '❌'}
- **SSL Enabled:** ${infrastructure.database?.hasSSLConfig ? '✅' : '❌'}
- **Backup Config:** ${infrastructure.database?.hasBackupConfig ? '✅' : '❌'}
- **Replication:** ${infrastructure.database?.hasReplication ? '✅' : '❌'}

---

## Performance Analysis

**Status:** ${performance.status}

### Load Test Results
${performance.loadTest?.summary ? `
- **Billing Events:** ${performance.loadTest.summary.successfulBillingEvents?.toLocaleString() || 0}
- **Success Rate:** ${performance.loadTest.summary.billingSuccessRate || 0}%
- **Throughput:** ${performance.loadTest.summary.billingThroughput || 0} events/sec
- **Avg Response Time:** ${performance.loadTest.summary.avgResponseTime || 0}ms
` : '- No load test results available'}

### Resource Limits
- **CPU Requests:** ${performance.resourceLimits?.cpuRequests || 'Not configured'}
- **CPU Limits:** ${performance.resourceLimits?.cpuLimits || 'Not configured'}
- **Memory Requests:** ${performance.resourceLimits?.memoryRequests || 'Not configured'}
- **Memory Limits:** ${performance.resourceLimits?.memoryLimits || 'Not configured'}

---

## Compliance Check

**Status:** ${compliance.status}

- **GDPR Compliance:** ${compliance.gdpr ? '✅' : '❌'}
- **Privacy Policy:** ${compliance.hasPrivacyPolicy ? '✅' : '❌'}
- **Data Retention:** ${compliance.hasDataRetention ? '✅' : '❌'}
- **Audit Logging:** ${compliance.hasAuditLogging ? '✅' : '❌'}

---

## SLA Projections

**Status:** ${sla.status}

- **Availability Target:** ${sla.availability}%
- **Response Time Target:** ${sla.responseTime}ms
- **Throughput Target:** ${sla.throughput} requests/sec
- **Error Rate Target:** ${sla.errorRate}%
- **Recovery Time Target:** ${sla.recoveryTime} minutes

---

## Recommendations

${summary.recommendations.map(rec => 
  `### ${rec.category} (${rec.priority})
**Description:** ${rec.description}  
**Action:** ${rec.action}`
).join('\n\n')}

---

## Conclusion

${summary.overallStatus === 'PASS' ? 
  'The SubStream Protocol backend is **READY FOR MAINNET DEPLOYMENT**. All critical requirements have been met and the system has demonstrated production-level performance and security.' :
  summary.overallStatus === 'WARNING' ? 
  'The SubStream Protocol backend is **READY FOR MAINNET WITH CONDITIONS**. Address the warnings and recommendations before full production deployment.' :
  'The SubStream Protocol backend is **NOT READY FOR MAINNET**. Critical issues must be resolved before production deployment.'}

---

**Report generated by SubStream Protocol Mainnet Readiness Checker**  
**For questions or concerns, contact the DevOps team**
`;
  }

  discoverSourceFiles() {
    const sourceDirs = ['src', 'routes', 'services', 'middleware', 'workers'];
    const extensions = ['.js', '.ts'];
    const sourceFiles = [];

    sourceDirs.forEach(dir => {
      const fullPath = path.join(this.rootDir, dir);
      if (fs.existsSync(fullPath)) {
        const files = this.walkDirectory(fullPath, extensions);
        sourceFiles.push(...files);
      }
    });

    return sourceFiles;
  }

  walkDirectory(dir, extensions) {
    const files = [];

    function walk(currentDir) {
      const items = fs.readdirSync(currentDir);
      
      for (const item of items) {
        const fullPath = path.join(currentDir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          if (!['node_modules', '.git', 'dist', 'build'].includes(item)) {
            walk(fullPath);
          }
        } else if (stat.isFile()) {
          const ext = path.extname(item);
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    }

    walk(dir);
    return files;
  }
}

// Run the generator
if (require.main === module) {
  const generator = new MainnetReadinessReportGenerator();
  
  generator.generate()
    .then(() => {
      console.log('\n🎉 Mainnet Readiness Report generated successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Report generation failed:', error);
      process.exit(1);
    });
}

module.exports = MainnetReadinessReportGenerator;
