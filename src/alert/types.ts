/** Local contract until the shared detector types are implemented in src/core. */
export type PiiType =
  | 'RRN' | 'FRN' | 'CARD_NUMBER' | 'ACCOUNT_NUMBER' | 'SECRET'
  | 'PASSPORT' | 'DRIVER_LICENSE' | 'CVC' | 'IPIN' | 'PHONE' | 'EMAIL'
  | 'USER_ID' | 'PERSON' | 'ADDRESS' | 'ZIPCODE' | 'DATE' | 'GENERIC_ID'
  | 'CARD_EXPIRY' | (string & {});

export interface Detection {
  type: PiiType;
  confidence: number;
  span: { start: number; end: number };
}

export type DetectionPolicy = 'AUTO_MASK' | 'CONFIRM';

export interface PrivacyAnalysis {
  originalText: string;
  autoMaskedText: string;
  autoMaskedDetections: Detection[];
  confirmDetections: Detection[];
  hasConfirmItems: boolean;
}
