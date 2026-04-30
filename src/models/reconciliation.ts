export interface ReconciliationReport {
  id: string;
  merchantId: string;
  reportDate: Date;
  
  // Aggregated SubscriptionBilled events for the day
  totalSubscriptionEvents: number;
  totalSubscriptionAmount: string;
  
  // Vault balance information
  vaultBalanceUsd: string;
  vaultBalanceNative: string;
  vaultAssetCode: string;
  
  // Reconciliation status
  reconciliationStatus: 'pending' | 'matched' | 'discrepancy_found' | 'healing' | 'failed';
  
  // Discrepancy information
  discrepancyAmount: string;
  discrepancyPercentage: number;
  
  // Healing information
  healingAttempts: number;
  healingStatus: 'none' | 'in_progress' | 'completed' | 'failed';
  
  // Report files
  reportJsonPath?: string;
  reportCsvPath?: string;
  
  // Metadata
  processingTimeMs?: number;
  ledgerRangeStart?: number;
  ledgerRangeEnd?: number;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface ReconciliationDiscrepancy {
  id: string;
  reportId: string;
  
  // Discrepancy details
  discrepancyType: 'missing_event' | 'extra_balance' | 'amount_mismatch' | 'timing_gap';
  
  // Transaction information
  transactionHash?: string;
  ledgerSequence?: number;
  eventIndex?: number;
  
  // Expected vs actual values
  expectedAmount?: string;
  actualAmount?: string;
  differenceAmount?: string;
  
  // Resolution information
  resolutionStatus: 'unresolved' | 'auto_healed' | 'manual_review' | 'false_positive';
  
  // Healing attempt reference
  healingAttemptId?: string;
  
  // Notes and metadata
  notes?: string;
  rawEventData?: any;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
}

export interface ReconciliationHealingAttempt {
  id: string;
  reportId: string;
  
  // Healing attempt details
  healingStrategy: 're_poll_rpc' | 'reprocess_ledger' | 'sync_missing_events';
  
  // Target information
  targetTransactionHash?: string;
  targetLedgerSequence?: number;
  targetEventIndex?: number;
  
  // Attempt status
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  
  // Results
  eventsFound: number;
  eventsSynced: number;
  balanceAdjusted: string;
  
  // Error information
  errorMessage?: string;
  retryCount: number;
  maxRetries: number;
  
  // Timing
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  
  // Raw response data for debugging
  rpcResponse?: any;
  healingDetails?: any;
}

export interface DailyAggregatedEvents {
  merchantId: string;
  date: Date;
  totalEvents: number;
  totalAmount: string;
  eventBreakdown: EventBreakdown[];
  ledgerRange: {
    start: number;
    end: number;
  };
}

export interface EventBreakdown {
  eventType: string;
  count: number;
  totalAmount: string;
  averageAmount: string;
}

export interface VaultBalanceSnapshot {
  merchantId: string;
  timestamp: Date;
  balances: AssetBalance[];
  totalValueUsd: string;
  totalValueNative: string;
}

export interface AssetBalance {
  assetCode: string;
  assetIssuer?: string;
  balance: string;
  valueUsd: string;
  priceUsd: string;
}

export interface DiscrepancyGap {
  type: 'missing_event' | 'extra_balance' | 'amount_mismatch' | 'timing_gap';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  
  // Transaction details for missing events
  transactionHash?: string;
  ledgerSequence?: number;
  eventIndex?: number;
  
  // Amount details
  expectedAmount?: string;
  actualAmount?: string;
  differenceAmount?: string;
  differencePercentage?: number;
  
  // Additional context
  context?: any;
  suggestedAction?: string;
}

export interface AutoHealingConfig {
  enabled: boolean;
  maxRetries: number;
  retryDelayMs: number;
  strategies: {
    rePollRpc: boolean;
    reprocessLedger: boolean;
    syncMissingEvents: boolean;
  };
  thresholds: {
    maxDiscrepancyPercentage: number;
    maxMissingEvents: number;
    maxHealingTimeMs: number;
  };
}

export interface ReconciliationConfig {
  // Scheduling
  scheduleTime: string; // UTC time in HH:MM format
  timezone: string;
  
  // Processing
  batchSize: number;
  maxProcessingTimeMs: number;
  
  // Thresholds
  discrepancyThresholdPercentage: number;
  criticalDiscrepancyThresholdPercentage: number;
  
  // Auto-healing
  autoHealing: AutoHealingConfig;
  
  // Reporting
  generateJsonReport: boolean;
  generateCsvReport: boolean;
  reportRetentionDays: number;
  emailReports: boolean;
  emailRecipients: string[];
  
  // Notifications
  alertOnDiscrepancy: boolean;
  alertOnHealingFailure: boolean;
  slackWebhookUrl?: string;
}

export interface ReconciliationMetrics {
  // Daily metrics
  dailyReports: {
    date: Date;
    totalReports: number;
    matchedReports: number;
    discrepancyReports: number;
    healedReports: number;
    avgDiscrepancyPercentage: number;
    totalDiscrepancyAmount: string;
    avgProcessingTimeMs: number;
  }[];
  
  // Aggregated metrics
  weeklyMetrics: {
    weekStart: Date;
    totalReports: number;
    matchRate: number;
    healingSuccessRate: number;
    avgDiscrepancyAmount: string;
  }[];
  
  // Real-time metrics
  currentStatus: {
    lastReportDate: Date;
    lastReportStatus: string;
    pendingReports: number;
    activeHealingAttempts: number;
  };
}

export interface ReconciliationSummary {
  merchantId: string;
  reportDate: Date;
  status: 'matched' | 'discrepancy_found' | 'healing' | 'failed';
  
  // Financial summary
  expectedRevenue: string;
  actualBalance: string;
  discrepancyAmount: string;
  discrepancyPercentage: number;
  
  // Event summary
  totalEvents: number;
  processedEvents: number;
  failedEvents: number;
  
  // Healing summary
  healingAttempts: number;
  healedDiscrepancies: number;
  pendingDiscrepancies: number;
  
  // Performance metrics
  processingTime: number;
  ledgerRange: {
    start: number;
    end: number;
  };
  
  // Report files
  reportFiles: {
    json?: string;
    csv?: string;
  };
  
  // Recommendations
  recommendations: string[];
  
  // Timestamps
  generatedAt: Date;
  completedAt?: Date;
}

export interface ReconciliationReportData {
  summary: ReconciliationSummary;
  discrepancies: ReconciliationDiscrepancy[];
  healingAttempts: ReconciliationHealingAttempt[];
  eventBreakdown: EventBreakdown[];
  balanceBreakdown: AssetBalance[];
  metrics: ReconciliationMetrics;
  metadata: {
    generatedBy: string;
    version: string;
    processingTime: number;
    ledgerRange: {
      start: number;
      end: number;
    };
  };
}
