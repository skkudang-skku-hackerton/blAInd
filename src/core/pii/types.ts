export const PII_TYPES = [
  'PERSON', 'RRN', 'FRN', 'CARD_NUMBER', 'ACCOUNT_NUMBER', 'SECRET',
  'USER_ID', 'EMAIL', 'PHONE', 'PASSPORT', 'DRIVER_LICENSE', 'GENERIC_ID',
  'ADDRESS', 'ZIPCODE', 'DATE', 'CARD_EXPIRY', 'CVC', 'IPIN',
] as const;

export type PiiType = (typeof PII_TYPES)[number];
