/**
 * Bitrix24 CRM entity types and webhook payload shapes.
 *
 * Custom CRM fields follow the UF_CRM_* naming convention.
 * Actual field machine names are driven by environment config.
 */

export interface BitrixDeal {
  ID: string;
  TITLE: string;
  COMPANY_ID: string;
  CONTACT_ID: string;
  OPPORTUNITY: string;
  CURRENCY_ID: string;
  STAGE_ID: string;
  ASSIGNED_BY_ID: string;
  DATE_CREATE: string;
  DATE_MODIFY: string;
  CLOSEDATE: string;
  // Custom fields – names resolved from config.bitrix.fields
  [key: string]: string | undefined;
}

export interface BitrixEmailEntry {
  VALUE: string;
  VALUE_TYPE: 'WORK' | 'HOME' | 'OTHER';
}

export interface BitrixPhoneEntry {
  VALUE: string;
  VALUE_TYPE: 'WORK' | 'HOME' | 'MOBILE' | 'FAX' | 'OTHER';
}

export interface BitrixContact {
  ID: string;
  NAME: string;
  LAST_NAME: string;
  SECOND_NAME?: string;
  EMAIL: BitrixEmailEntry[];
  PHONE: BitrixPhoneEntry[];
  COMPANY_ID: string;
  ADDRESS?: string;
  ADDRESS_CITY?: string;
  ADDRESS_STATE?: string;
  ADDRESS_COUNTRY?: string;
  ADDRESS_POSTAL_CODE?: string;
}

export interface BitrixCompany {
  ID: string;
  TITLE: string;
  EMAIL: BitrixEmailEntry[];
  PHONE: BitrixPhoneEntry[];
  ADDRESS?: string;
  ADDRESS_CITY?: string;
  ADDRESS_STATE?: string;
  ADDRESS_COUNTRY?: string;
  ADDRESS_POSTAL_CODE?: string;
  /** Company Registration Number / Tax ID */
  UF_CRN?: string;
}

export interface BitrixWebhookPayload {
  event: string;
  data: {
    FIELDS: {
      ID: string;
      [key: string]: string;
    };
  };
  ts: string;
  auth: {
    domain: string;
    client_endpoint: string;
    server_endpoint: string;
    member_id: string;
    application_token: string;
  };
}

export interface BitrixApiResponse<T> {
  result: T;
  time: {
    start: number;
    finish: number;
    duration: number;
    processing: number;
    date_start: string;
    date_finish: string;
  };
  error?: string;
  error_description?: string;
}

export interface BitrixListResponse<T> {
  result: T[];
  total: number;
  time: BitrixApiResponse<T>['time'];
}

/** Events we handle from Bitrix24 webhooks */
export type BitrixWebhookEvent =
  | 'ONCRMDEALADD'
  | 'ONCRMDEALUPDATE'
  | 'ONCRMDEALADD'
  | 'ONCRMDEALDELETE';
