/**
 * Core domain types for the billing service.
 *
 * All IDs are UUIDs. All monetary amounts are DECIMAL(15,2) stored as
 * JavaScript numbers (precision is managed at the DB level).
 */

// ─── Enumerations ─────────────────────────────────────────────────────────────

export type BillingType =
  | 'monthly'
  | 'quarterly'
  | 'annual'
  | 'one_time'
  | 'milestone'
  | 'hybrid';

/** Billing type values used within individual schedule rows (never 'hybrid') */
export type ScheduleBillingType = Exclude<BillingType, 'hybrid'>;

export type InvoiceStatus = 'pending' | 'created' | 'failed' | 'cancelled';
export type ContractStatus = 'active' | 'expired' | 'cancelled';
export type ErrorQueueStatus = 'pending' | 'retrying' | 'resolved' | 'dead_letter';
export type EntityType = 'deal' | 'contact' | 'company';
export type LedgersEntityType = 'contact' | 'catalog_item' | 'invoice';

// ─── Contract Parser Output ───────────────────────────────────────────────────

export interface MilestoneDefinition {
  name: string;
  amount: number;
  /** YYYY-MM-DD */
  dueDate: string;
  description?: string;
}

export interface HybridScheduleDefinition {
  billingType: ScheduleBillingType;
  amount: number;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD */
  endDate?: string;
}

export interface ContractTerms {
  billingType: BillingType;
  amount: number;
  currency: string;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD */
  endDate?: string;
  paymentTermsDays: number;
  milestones?: MilestoneDefinition[];
  hybridSchedules?: HybridScheduleDefinition[];
  notes?: string;
}

// ─── Database Row Shapes ───────────────────────────────────────────────────────

export interface Contract {
  id: string;
  bitrixDealId: string;
  rawText: string;
  parsedTerms: ContractTerms;
  status: ContractStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface BillingSchedule {
  id: string;
  contractId: string;
  bitrixDealId: string;
  billingType: ScheduleBillingType;
  amount: number;
  currency: string;
  startDate: Date;
  endDate?: Date;
  /** Day of month (1-28) on which recurring invoices are generated */
  dayOfMonth?: number;
  isActive: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface BillingMilestone {
  id: string;
  scheduleId: string;
  name: string;
  amount: number;
  dueDate: Date;
  description?: string;
  isBilled: boolean;
  billedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface EntityMapping {
  id: string;
  bitrixEntityType: EntityType;
  bitrixEntityId: string;
  ledgersEntityType: LedgersEntityType;
  ledgersEntityId: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvoiceRecord {
  id: string;
  scheduleId: string;
  milestoneId?: string;
  bitrixDealId: string;
  ledgersInvoiceId?: string;
  ledgersInvoiceNumber?: string;
  idempotencyKey: string;
  periodStart: Date;
  periodEnd: Date;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ErrorQueueEntry {
  id: string;
  invoiceRecordId?: string;
  scheduleId: string;
  errorType: string;
  errorMessage: string;
  errorStack?: string;
  context?: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: Date;
  resolvedAt?: Date;
  status: ErrorQueueStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLog {
  id: string;
  eventType: string;
  entityType?: string;
  entityId?: string;
  bitrixDealId?: string;
  ledgersInvoiceId?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
  ipAddress?: string;
  createdAt: Date;
}

// ─── Runtime Helpers ──────────────────────────────────────────────────────────

export interface BillingPeriod {
  periodStart: Date;
  periodEnd: Date;
  idempotencyKey: string;
  amount: number;
  currency: string;
}

export interface InvoiceGenerationResult {
  invoiceRecord: InvoiceRecord;
  isNew: boolean;
  /** True if invoice was skipped because it already existed */
  isDuplicate: boolean;
}
