import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../../config';
import type {
  LedgersContactCreate,
  LedgersContactResponse,
  LedgersInvoiceCreate,
  LedgersInvoiceResponse,
  LedgersInvoiceUpdate,
  LedgersPaginatedResponse,
} from '../../types/ledgers';
import { logger } from '../audit/logger';

export class LedgersApiClient {
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.ledgers.baseUrl,
      timeout: 20_000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ledgers.apiKey}`,
        'X-Environment': config.ledgers.environment,
      },
    });

    this.client.interceptors.request.use((req) => {
      logger.debug('LEDGERS API request', {
        method: req.method?.toUpperCase(),
        url: req.url,
      });
      return req;
    });

    this.client.interceptors.response.use(
      (res) => res,
      (err: AxiosError<{ message?: string; error?: string }>) => {
        const msg =
          err.response?.data?.message ??
          err.response?.data?.error ??
          err.message;
        const status = err.response?.status;
        throw new LedgersApiError(msg, status);
      },
    );
  }

  // ─── Contacts ───────────────────────────────────────────────────────────────

  /**
   * Look up a LEDGERS contact by email address.
   * Returns null if not found.
   */
  async findContactByEmail(
    email: string,
  ): Promise<LedgersContactResponse | null> {
    try {
      const res = await this.client.get<
        LedgersPaginatedResponse<LedgersContactResponse>
      >('/contacts', { params: { email, limit: 1 } });
      const contacts = res.data.data ?? [];
      return contacts[0] ?? null;
    } catch (err) {
      if (err instanceof LedgersApiError && err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * Find an existing contact by externalReference (Bitrix entity ID).
   */
  async findContactByExternalRef(
    externalReference: string,
  ): Promise<LedgersContactResponse | null> {
    try {
      const res = await this.client.get<
        LedgersPaginatedResponse<LedgersContactResponse>
      >('/contacts', { params: { externalReference, limit: 1 } });
      return res.data.data?.[0] ?? null;
    } catch {
      return null;
    }
  }

  async createContact(
    contact: LedgersContactCreate,
  ): Promise<LedgersContactResponse> {
    const res = await this.client.post<LedgersContactResponse>(
      '/contacts',
      contact,
    );
    logger.info('LEDGERS contact created', { id: res.data.id });
    return res.data;
  }

  async getContact(contactId: string): Promise<LedgersContactResponse> {
    const res = await this.client.get<LedgersContactResponse>(
      `/contacts/${contactId}`,
    );
    return res.data;
  }

  /**
   * Idempotent: find existing contact or create a new one.
   * Lookup order: externalReference → email.
   */
  async findOrCreateContact(
    contact: LedgersContactCreate,
  ): Promise<LedgersContactResponse> {
    if (contact.externalReference) {
      const byRef = await this.findContactByExternalRef(
        contact.externalReference,
      );
      if (byRef) return byRef;
    }

    const byEmail = await this.findContactByEmail(contact.email);
    if (byEmail) return byEmail;

    return this.createContact(contact);
  }

  // ─── Invoices ────────────────────────────────────────────────────────────────

  async createInvoice(
    invoice: LedgersInvoiceCreate,
  ): Promise<LedgersInvoiceResponse> {
    const res = await this.client.post<LedgersInvoiceResponse>(
      '/invoices',
      invoice,
    );
    logger.info('LEDGERS invoice created', {
      id: res.data.id,
      number: res.data.invoiceNumber,
    });
    return res.data;
  }

  async getInvoice(invoiceId: string): Promise<LedgersInvoiceResponse> {
    const res = await this.client.get<LedgersInvoiceResponse>(
      `/invoices/${invoiceId}`,
    );
    return res.data;
  }

  async updateInvoice(
    invoiceId: string,
    update: LedgersInvoiceUpdate,
  ): Promise<LedgersInvoiceResponse> {
    const res = await this.client.patch<LedgersInvoiceResponse>(
      `/invoices/${invoiceId}`,
      update,
    );
    return res.data;
  }

  async listInvoices(params: {
    contactId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<LedgersPaginatedResponse<LedgersInvoiceResponse>> {
    const res = await this.client.get<
      LedgersPaginatedResponse<LedgersInvoiceResponse>
    >('/invoices', { params });
    return res.data;
  }
}

export class LedgersApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LedgersApiError';
  }
}

/** Singleton instance */
export const ledgersClient = new LedgersApiClient();
