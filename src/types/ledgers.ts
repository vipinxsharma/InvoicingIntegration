/**
 * LEDGERS accounting platform API types.
 *
 * These shapes match the LEDGERS REST API v1.
 * If LEDGERS publishes an OpenAPI spec, generate these from it instead.
 */

export interface LedgersAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  country: string;
  postalCode: string;
}

// ─── Contacts ───────────────────────────────────────────────────────────────

export interface LedgersContactCreate {
  name: string;
  email: string;
  phone?: string;
  address?: LedgersAddress;
  taxId?: string;
  currency: string;
  /** Opaque reference to link back to Bitrix24 entity */
  externalReference?: string;
}

export interface LedgersContactResponse {
  id: string;
  name: string;
  email: string;
  phone?: string;
  address?: LedgersAddress;
  taxId?: string;
  currency: string;
  externalReference?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Invoices ────────────────────────────────────────────────────────────────

export interface LedgersLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  /** Percentage, e.g. 10 for 10% */
  taxRate?: number;
  taxAmount?: number;
  total?: number;
  catalogItemId?: string;
}

export interface LedgersInvoiceCreate {
  contactId: string;
  lineItems: LedgersLineItem[];
  /** ISO 8601 date string YYYY-MM-DD */
  issueDate: string;
  /** ISO 8601 date string YYYY-MM-DD */
  dueDate: string;
  currency: string;
  notes?: string;
  terms?: string;
  /** Maps back to Bitrix24 deal – stored as BTRX-{dealId} */
  referenceNumber?: string;
  customFields?: Record<string, string>;
}

export type LedgersInvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';

export interface LedgersInvoiceResponse {
  id: string;
  invoiceNumber: string;
  status: LedgersInvoiceStatus;
  contactId: string;
  lineItems: LedgersLineItem[];
  subtotal: number;
  taxTotal: number;
  total: number;
  currency: string;
  issueDate: string;
  dueDate: string;
  notes?: string;
  referenceNumber?: string;
  customFields?: Record<string, string>;
  /** Public PDF / view URL */
  url?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgersInvoiceUpdate {
  status?: LedgersInvoiceStatus;
  notes?: string;
  dueDate?: string;
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export interface LedgersPaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
  };
}
