#!/usr/bin/env node

/**
 * SubStream Protocol Mainnet Load Test
 * 
 * This script simulates production-level load to validate backend readiness:
 * - 1 million billing events
 * - 50,000 concurrent WebSocket connections
 * - Database vacuuming and cache eviction validation
 * 
 * Usage: node mainnet-load-test.js [options]
 */

const WebSocket = require('ws');
const axios = require('axios');
const { performance } = require('perf_hooks');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const fs = require('fs');
const path = require('path');

class MainnetLoadTest {
  constructor(options = {}) {
    this.config = {
      apiUrl: options.apiUrl || 'http://localhost:3000',
      wsUrl: options.wsUrl || 'ws://localhost:3000',
      billingEvents: options.billingEvents || 1000000,
      concurrentConnections: options.concurrentConnections || 50000,
      duration: options.duration || 3600, // 1 hour
      workers: options.workers || os.cpus().length,
      outputDir: options.outputDir || './load-test-results',
      ...options
    };

    this.metrics = {
      billingEvents: {
        total: 0,
        successful: 0,
        failed: 0,
        avgLatency: 0,
        p95Latency: 0,
        p99Latency: 0,
        throughput: 0
      },
      websockets: {
        connected: 0,
        disconnected: 0,
        messages: 0,
        errors: 0,
        avgLatency: 0
      },
      database: {
        connections: 0,
        queryTime: 0,
        vacuumStatus: 'unknown',
        cacheHitRate: 0
      },
      system: {
        cpu: 0,
        memory: 0,
        disk: 0,
        network: 0
      }
    };

    this.startTime = null;
    this.endTime = null;
    this.workers = [];
    this.results = [];

    // Ensure output directory exists
    if (!fs.existsSync(this.config.outputDir)) {
      fs.mkdirSync(this.config.outputDir, { recursive: true });
    }
  }

  async run() {
    console.log('🚀 Starting SubStream Protocol Mainnet Load Test');
    console.log(`📊 Target: ${this.config.billingEvents.toLocaleString()} billing events`);
    console.log(`🔌 Target: ${this.config.concurrentConnections.toLocaleString()} WebSocket connections`);
    console.log(`⏱️  Duration: ${this.config.duration} seconds`);
    console.log(`👥 Workers: ${this.config.workers}`);

    this.startTime = performance.now();

    try {
      // Phase 1: System Health Check
      await this.healthCheck();

      // Phase 2: Baseline Metrics
      await this.captureBaseline();

      // Phase 3: Load Test Execution
      await this.executeLoadTest();

      // Phase 4: System Validation
      await this.validateSystem();

      // Phase 5: Generate Report
      await this.generateReport();

      this.endTime = performance.now();
      console.log(`✅ Load test completed in ${((this.endTime - this.startTime) / 1000).toFixed(2)} seconds`);

    } catch (error) {
      console.error('❌ Load test failed:', error);
      await this.generateErrorReport(error);
      throw error;
    }
  }

  async healthCheck() {
    console.log('\n🏥 Phase 1: System Health Check');

    try {
      // Check API health
      const apiHealth = await axios.get(`${this.config.apiUrl}/health`, { timeout: 5000 });
      console.log(`✅ API Health: ${apiHealth.status}`);

      // Check WebSocket health
      const wsHealth = await this.testWebSocketConnection();
      console.log(`✅ WebSocket Health: ${wsHealth ? 'Connected' : 'Failed'}`);

      // Check database connectivity
      const dbHealth = await this.testDatabaseConnection();
      console.log(`✅ Database Health: ${dbHealth ? 'Connected' : 'Failed'}`);

      // Check Redis connectivity
      const redisHealth = await this.testRedisConnection();
      console.log(`✅ Redis Health: ${redisHealth ? 'Connected' : 'Failed'}`);

    } catch (error) {
      throw new Error(`Health check failed: ${error.message}`);
    }
  }

  async captureBaseline() {
    console.log('\n📏 Phase 2: Capturing Baseline Metrics');

    this.metrics.system = await this.getSystemMetrics();
    this.metrics.database = await this.getDatabaseMetrics();

    console.log('📊 Baseline captured:', {
      cpu: `${this.metrics.system.cpu}%`,
      memory: `${this.metrics.system.memory}%`,
      dbConnections: this.metrics.database.connections,
      cacheHitRate: `${this.metrics.database.cacheHitRate}%`
    });
  }

  async executeLoadTest() {
    console.log('\n⚡ Phase 3: Executing Load Test');

    // Create worker threads for parallel execution
    const workerPromises = [];

    // Billing Events Worker
    workerPromises.push(this.runBillingEventsWorker());

    // WebSocket Connections Worker
    workerPromises.push(this.runWebSocketWorker());

    // System Monitoring Worker
    workerPromises.push(this.runSystemMonitoringWorker());

    // Wait for all workers to complete
    const results = await Promise.allSettled(workerPromises);

    // Aggregate results
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        this.results[index] = result.value;
      } else {
        console.error(`Worker ${index} failed:`, result.reason);
      }
    });
  }

  async runBillingEventsWorker() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: {
          type: 'billing',
          config: this.config,
          eventsPerWorker: Math.ceil(this.config.billingEvents / this.config.workers)
        }
      });

      worker.on('message', (data) => {
        if (data.type === 'metrics') {
          this.metrics.billingEvents = { ...this.metrics.billingEvents, ...data.metrics };
        } else if (data.type === 'complete') {
          resolve(data.result);
        }
      });

      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Billing worker stopped with exit code ${code}`));
        }
      });

      this.workers.push(worker);
    });
  }

  async runWebSocketWorker() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: {
          type: 'websocket',
          config: this.config,
          connectionsPerWorker: Math.ceil(this.config.concurrentConnections / this.config.workers)
        }
      });

      worker.on('message', (data) => {
        if (data.type === 'metrics') {
          this.metrics.websockets = { ...this.metrics.websockets, ...data.metrics };
        } else if (data.type === 'complete') {
          resolve(data.result);
        }
      });

      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`WebSocket worker stopped with exit code ${code}`));
        }
      });

      this.workers.push(worker);
    });
  }

  async runSystemMonitoringWorker() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: {
          type: 'monitoring',
          config: this.config,
          interval: 5000 // Monitor every 5 seconds
        }
      });

      worker.on('message', (data) => {
        if (data.type === 'metrics') {
          this.metrics.system = { ...this.metrics.system, ...data.metrics };
        } else if (data.type === 'complete') {
          resolve(data.result);
        }
      });

      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Monitoring worker stopped with exit code ${code}`));
        }
      });

      this.workers.push(worker);
    });
  }

  async validateSystem() {
    console.log('\n🔍 Phase 4: System Validation');

    // Check database vacuuming
    const vacuumStatus = await this.checkDatabaseVacuuming();
    this.metrics.database.vacuumStatus = vacuumStatus;
    console.log(`🧹 Database Vacuuming: ${vacuumStatus}`);

    // Check log rotation
    const logRotationStatus = await this.checkLogRotation();
    console.log(`📋 Log Rotation: ${logRotationStatus}`);

    // Check cache eviction
    const cacheEvictionStatus = await this.checkCacheEviction();
    console.log(`💾 Cache Eviction: ${cacheEvictionStatus}`);

    // Validate data integrity
    const dataIntegrity = await this.validateDataIntegrity();
    console.log(`🔒 Data Integrity: ${dataIntegrity ? 'Pass' : 'Fail'}`);
  }

  async generateReport() {
    console.log('\n📄 Phase 5: Generating Report');

    const report = {
      timestamp: new Date().toISOString(),
      duration: ((this.endTime - this.startTime) / 1000).toFixed(2),
      config: this.config,
      metrics: this.metrics,
      results: this.results,
      summary: {
        totalBillingEvents: this.metrics.billingEvents.total,
        successfulBillingEvents: this.metrics.billingEvents.successful,
        billingSuccessRate: ((this.metrics.billingEvents.successful / this.metrics.billingEvents.total) * 100).toFixed(2),
        websocketConnections: this.metrics.websockets.connected,
        billingThroughput: this.metrics.billingEvents.throughput,
        avgResponseTime: this.metrics.billingEvents.avgLatency,
        systemLoad: this.metrics.system.cpu
      },
      status: this.determineOverallStatus()
    };

    // Save detailed report
    const reportPath = path.join(this.config.outputDir, `mainnet-load-test-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // Generate summary
    this.printSummary(report);

    return report;
  }

  determineOverallStatus() {
    const billingSuccessRate = (this.metrics.billingEvents.successful / this.metrics.billingEvents.total) * 100;
    const websocketSuccessRate = (this.metrics.websockets.connected / this.config.concurrentConnections) * 100;

    if (billingSuccessRate >= 99.9 && websocketSuccessRate >= 99.0) {
      return 'PASS';
    } else if (billingSuccessRate >= 95.0 && websocketSuccessRate >= 95.0) {
      return 'WARNING';
    } else {
      return 'FAIL';
    }
  }

  printSummary(report) {
    console.log('\n' + '='.repeat(80));
    console.log('📊 MAINNET LOAD TEST SUMMARY');
    console.log('='.repeat(80));
    console.log(`⏱️  Duration: ${report.duration} seconds`);
    console.log(`💳 Billing Events: ${report.summary.successfulBillingEvents.toLocaleString()}/${report.summary.totalBillingEvents.toLocaleString()} (${report.summary.billingSuccessRate}%)`);
    console.log(`🔌 WebSocket Connections: ${report.summary.websocketConnections.toLocaleString()}/${this.config.concurrentConnections.toLocaleString()}`);
    console.log(`📈 Billing Throughput: ${report.summary.billingThroughput.toFixed(2)} events/sec`);
    console.log(`⚡ Avg Response Time: ${report.summary.avgResponseTime.toFixed(2)}ms`);
    console.log(`💻 System Load: ${report.summary.systemLoad}%`);
    console.log(`🧹 Database Vacuum: ${report.metrics.database.vacuumStatus}`);
    console.log(`📋 Overall Status: ${report.status}`);
    console.log('='.repeat(80));
  }

  // Helper methods
  async testWebSocketConnection() {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.config.wsUrl);
      ws.on('open', () => {
        ws.close();
        resolve(true);
      });
      ws.on('error', () => resolve(false));
      setTimeout(() => {
        ws.close();
        resolve(false);
      }, 5000);
    });
  }

  async testDatabaseConnection() {
    try {
      await axios.get(`${this.config.apiUrl}/health/db`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async testRedisConnection() {
    try {
      await axios.get(`${this.config.apiUrl}/health/redis`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async getSystemMetrics() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    
    return {
      cpu: 0, // Will be updated by monitoring worker
      memory: ((totalMem - freeMem) / totalMem * 100).toFixed(2),
      disk: 0, // Will be updated by monitoring worker
      network: 0 // Will be updated by monitoring worker
    };
  }

  async getDatabaseMetrics() {
    try {
      const response = await axios.get(`${this.config.apiUrl}/metrics/database`, { timeout: 5000 });
      return response.data;
    } catch {
      return {
        connections: 0,
        queryTime: 0,
        vacuumStatus: 'unknown',
        cacheHitRate: 0
      };
    }
  }

  async checkDatabaseVacuuming() {
    try {
      const response = await axios.get(`${this.config.apiUrl}/admin/vacuum-status`, { timeout: 10000 });
      return response.data.status || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async checkLogRotation() {
    try {
      const response = await axios.get(`${this.config.apiUrl}/admin/log-rotation-status`, { timeout: 5000 });
      return response.data.status || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async checkCacheEviction() {
    try {
      const response = await axios.get(`${this.config.apiUrl}/admin/cache-eviction-status`, { timeout: 5000 });
      return response.data.status || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async validateDataIntegrity() {
    try {
      const response = await axios.get(`${this.config.apiUrl}/admin/data-integrity-check`, { timeout: 30000 });
      return response.data.valid === true;
    } catch {
      return false;
    }
  }

  async generateErrorReport(error) {
    const errorReport = {
      timestamp: new Date().toISOString(),
      error: {
        message: error.message,
        stack: error.stack
      },
      metrics: this.metrics,
      partialResults: this.results
    };

    const errorPath = path.join(this.config.outputDir, `load-test-error-${Date.now()}.json`);
    fs.writeFileSync(errorPath, JSON.stringify(errorReport, null, 2));
  }
}

// Worker thread implementation
if (!isMainThread) {
  const { type, config, eventsPerWorker, connectionsPerWorker, interval } = workerData;

  async function runBillingWorker() {
    const metrics = {
      total: 0,
      successful: 0,
      failed: 0,
      latencies: []
    };

    const startTime = performance.now();
    const promises = [];

    for (let i = 0; i < eventsPerWorker; i++) {
      promises.push(sendBillingEvent(i));
    }

    const results = await Promise.allSettled(promises);
    
    results.forEach((result) => {
      metrics.total++;
      if (result.status === 'fulfilled') {
        metrics.successful++;
        metrics.latencies.push(result.value);
      } else {
        metrics.failed++;
      }
    });

    const endTime = performance.now();
    const duration = (endTime - startTime) / 1000;

    // Calculate statistics
    metrics.latencies.sort((a, b) => a - b);
    metrics.avgLatency = metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length;
    metrics.p95Latency = metrics.latencies[Math.floor(metrics.latencies.length * 0.95)];
    metrics.p99Latency = metrics.latencies[Math.floor(metrics.latencies.length * 0.99)];
    metrics.throughput = metrics.successful / duration;

    parentPort.postMessage({ type: 'metrics', metrics });
    parentPort.postMessage({ type: 'complete', result: { type: 'billing', metrics } });
  }

  async function sendBillingEvent(index) {
    const startTime = performance.now();
    
    try {
      const payload = {
        userId: `user_${index % 10000}`,
        amount: Math.random() * 100,
        currency: 'USD',
        timestamp: new Date().toISOString(),
        metadata: {
          source: 'load-test',
          workerId: workerData.workerId,
          eventId: index
        }
      };

      await axios.post(`${config.apiUrl}/api/billing/events`, payload, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'X-Load-Test': 'true'
        }
      });

      return performance.now() - startTime;
    } catch (error) {
      throw error;
    }
  }

  async function runWebSocketWorker() {
    const metrics = {
      connected: 0,
      disconnected: 0,
      messages: 0,
      errors: 0,
      latencies: []
    };

    const connections = [];
    const connectPromises = [];

    for (let i = 0; i < connectionsPerWorker; i++) {
      connectPromises.push(createWebSocketConnection(i));
    }

    const results = await Promise.allSettled(connectPromises);
    
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        metrics.connected++;
        connections.push(result.value);
      } else {
        metrics.errors++;
      }
    });

    // Keep connections alive and send messages
    const messageInterval = setInterval(() => {
      connections.forEach((ws, index) => {
        if (ws.readyState === WebSocket.OPEN) {
          const startTime = performance.now();
          ws.send(JSON.stringify({
            type: 'ping',
            timestamp: Date.now(),
            connectionId: index
          }));
        }
      });
    }, 30000); // Send message every 30 seconds

    // Wait for test duration
    await new Promise(resolve => setTimeout(resolve, config.duration * 1000));

    clearInterval(messageInterval);

    // Close all connections
    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        metrics.disconnected++;
      }
    });

    parentPort.postMessage({ type: 'metrics', metrics });
    parentPort.postMessage({ type: 'complete', result: { type: 'websocket', metrics } });
  }

  async function createWebSocketConnection(index) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(config.wsUrl);
      
      ws.on('open', () => {
        ws.on('message', (data) => {
          // Handle incoming messages
        });
        
        ws.on('error', (error) => {
          // Handle errors
        });
        
        resolve(ws);
      });
      
      ws.on('error', reject);
      
      setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, 10000);
    });
  }

  async function runMonitoringWorker() {
    const metrics = {
      cpu: [],
      memory: [],
      disk: [],
      network: []
    };

    const intervalId = setInterval(async () => {
      try {
        const systemMetrics = await getSystemMetrics();
        metrics.cpu.push(systemMetrics.cpu);
        metrics.memory.push(systemMetrics.memory);
        metrics.disk.push(systemMetrics.disk);
        metrics.network.push(systemMetrics.network);

        parentPort.postMessage({ type: 'metrics', metrics: systemMetrics });
      } catch (error) {
        console.error('Monitoring error:', error);
      }
    }, interval);

    // Wait for test duration
    await new Promise(resolve => setTimeout(resolve, config.duration * 1000));

    clearInterval(intervalId);

    parentPort.postMessage({ type: 'complete', result: { type: 'monitoring', metrics } });
  }

  async function getSystemMetrics() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    
    // Simple CPU calculation (would need more sophisticated monitoring in production)
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    const cpuUsage = 100 - (totalIdle / totalTick * 100);
    
    return {
      cpu: cpuUsage.toFixed(2),
      memory: ((totalMem - freeMem) / totalMem * 100).toFixed(2),
      disk: 0, // Would need actual disk monitoring
      network: 0 // Would need actual network monitoring
    };
  }

  // Run the appropriate worker
  switch (type) {
    case 'billing':
      runBillingWorker();
      break;
    case 'websocket':
      runWebSocketWorker();
      break;
    case 'monitoring':
      runMonitoringWorker();
      break;
    default:
      throw new Error(`Unknown worker type: ${type}`);
  }
}

// Main execution
if (isMainThread) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const options = {};
  
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace('--', '');
    const value = args[i + 1];
    options[key] = isNaN(value) ? value : parseInt(value);
  }

  // Create and run load test
  const loadTest = new MainnetLoadTest(options);
  
  loadTest.run()
    .then(() => {
      console.log('\n🎉 Load test completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Load test failed:', error.message);
      process.exit(1);
    });
}

module.exports = MainnetLoadTest;
