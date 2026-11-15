import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../../config';
import type {
  BitrixDeal,
  BitrixContact,
  BitrixCompany,
  BitrixApiResponse,
} from '../../types/bitrix';
import { logger } from '../audit/logger';

export class BitrixApiClient {
  private readonly client: AxiosInstance;

  constructor() {
    const base = `https://${config.bitrix.domain}/rest/${config.bitrix.userId}/${config.bitrix.webhookToken}`;

    this.client = axios.create({
      baseURL: base,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });

    this.client.interceptors.response.use(
      (res) => res,
      (err: AxiosError<BitrixApiResponse<unknown>>) => {
        const msg =
          err.response?.data?.error_description ??
          err.response?.data?.error ??
          err.message;
        throw new BitrixApiError(msg, err.response?.status);
      },
    );
  }

  // ─── Deals ──────────────────────────────────────────────────────────────────

  async getDeal(dealId: string): Promise<BitrixDeal> {
    const res = await this.client.get<BitrixApiResponse<BitrixDeal>>(
      '/crm.deal.get.json',
      { params: { ID: dealId } },
    );
    if (!res.data.result) {
      throw new BitrixApiError(`Deal ${dealId} not found`, 404);
    }
    return res.data.result;
  }

  async updateDeal(
    dealId: string,
    fields: Partial<Record<string, string>>,
  ): Promise<void> {
    await this.client.post('/crm.deal.update.json', {
      ID: dealId,
      FIELDS: fields,
    });
    logger.debug('Bitrix24 deal updated', { dealId, fields });
  }

  /**
   * Append a LEDGERS invoice ID to the deal's invoice ID list.
   * The field stores a JSON-serialised string array.
   */
  async appendLedgersInvoiceId(
    dealId: string,
    ledgersInvoiceId: string,
  ): Promise<void> {
    const deal = await this.getDeal(dealId);
    const fieldName = config.bitrix.fields.ledgersInvoiceIds;
    const existing: string[] = (() => {
      try {
        return JSON.parse((deal[fieldName] as string | undefined) ?? '[]') as string[];
      } catch {
        return [];
      }
    })();

    if (!existing.includes(ledgersInvoiceId)) {
      existing.push(ledgersInvoiceId);
      await this.updateDeal(dealId, {
        [fieldName]: JSON.stringify(existing),
      });
    }
  }

  // ─── Contacts ───────────────────────────────────────────────────────────────

  async getContact(contactId: string): Promise<BitrixContact> {
    const res = await this.client.get<BitrixApiResponse<BitrixContact>>(
      '/crm.contact.get.json',
      { params: { ID: contactId } },
    );
    if (!res.data.result) {
      throw new BitrixApiError(`Contact ${contactId} not found`, 404);
    }
    return res.data.result;
  }

  // ─── Companies ──────────────────────────────────────────────────────────────

  async getCompany(companyId: string): Promise<BitrixCompany> {
    const res = await this.client.get<BitrixApiResponse<BitrixCompany>>(
      '/crm.company.get.json',
      { params: { ID: companyId } },
    );
    if (!res.data.result) {
      throw new BitrixApiError(`Company ${companyId} not found`, 404);
    }
    return res.data.result;
  }
}

export class BitrixApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'BitrixApiError';
  }
}

/** Singleton – reuse the Axios instance across the application */
export const bitrixClient = new BitrixApiClient();
