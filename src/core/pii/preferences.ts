import { PII_TYPES, type PiiType } from './types';

export type MaskingPolicy = 'AUTO_MASK' | 'CONFIRM';
export type MaskingPreferences = Record<PiiType, MaskingPolicy>;

export const PII_LABELS: Record<PiiType, string> = {
  RRN: '주민등록번호', FRN: '외국인등록번호', CARD_NUMBER: '카드번호', ACCOUNT_NUMBER: '계좌번호',
  SECRET: '비밀번호 · 키', PASSPORT: '여권번호', DRIVER_LICENSE: '운전면허번호', CVC: '카드 CVC',
  IPIN: '아이핀', PHONE: '전화번호', EMAIL: '이메일', USER_ID: '사용자 ID', PERSON: '이름',
  ADDRESS: '주소', ZIPCODE: '우편번호', DATE: '날짜 · 시간', GENERIC_ID: '기타 식별번호', CARD_EXPIRY: '카드 유효기간',
};

const auto = new Set<PiiType>([
  'RRN', 'FRN', 'CARD_NUMBER', 'ACCOUNT_NUMBER', 'SECRET', 'PASSPORT',
  'DRIVER_LICENSE', 'CVC', 'IPIN', 'PHONE', 'EMAIL',
]);
export const DEFAULT_MASKING_PREFERENCES: Readonly<MaskingPreferences> = Object.freeze(
  Object.fromEntries(PII_TYPES.map(type => [type, auto.has(type) ? 'AUTO_MASK' : 'CONFIRM'])) as MaskingPreferences,
);

/** Only supported labels and policies can enter the processing pipeline. */
export function normalizeMaskingPreferences(value: unknown): MaskingPreferences {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(PII_TYPES.map(type => [type,
    source[type] === 'AUTO_MASK' || source[type] === 'CONFIRM' ? source[type] : DEFAULT_MASKING_PREFERENCES[type],
  ])) as MaskingPreferences;
}

let current = normalizeMaskingPreferences(null);
export const getMaskingPreferences = (): MaskingPreferences => ({ ...current });
export function setMaskingPreferences(value: unknown): void {
  current = normalizeMaskingPreferences(value);
}
