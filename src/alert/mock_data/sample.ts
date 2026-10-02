const text = '안녕하세요, 김민수입니다. 연락처는 010-1234-5678, 이메일은 minsu@example.com이고 사번은 AB-2048입니다.';

function spanOf(value: string) {
  const start = text.indexOf(value);
  if (start < 0) throw new Error(`Mock detection not found: ${value}`);
  return { start, end: start + value.length };
}

export const sampleText = text;

export const sampleDetections = [
  { type: 'PERSON', confidence: 0.98, span: spanOf('김민수') },
  { type: 'PHONE', confidence: 0.99, span: spanOf('010-1234-5678') },
  { type: 'EMAIL', confidence: 0.99, span: spanOf('minsu@example.com') },
  { type: 'GENERIC_ID', confidence: 0.91, span: spanOf('AB-2048') },
];
