const messages = {
  PDF_OCR_REQUIRED: '이 PDF는 이미지 또는 스캔 페이지가 포함되어 있어 현재 검사할 수 없습니다. 텍스트 PDF 또는 DOCX로 다시 시도해 주세요.',
  DOCUMENT_LIMIT: '문서 크기 또는 페이지 수가 처리 한도를 초과했습니다. 파일을 나눠서 다시 시도해 주세요.',
  DOCUMENT_FORMAT: '암호가 설정됐거나 지원하지 않는 문서 형식입니다. 암호 없는 PDF 또는 DOCX로 다시 시도해 주세요.',
  DOCUMENT_WORKER: '문서 처리 모듈을 실행하지 못했습니다. 확장 프로그램과 ChatGPT 탭을 새로고침해 주세요.',
  DOCUMENT_SESSION: '문서 처리 연결이 만료됐습니다. 파일을 다시 첨부해 주세요.',
  DOCUMENT_FAILED: '문서 처리에 실패했습니다. Console의 오류 코드와 처리 단계를 확인해 주세요.',
} as const;
export type DocumentErrorCode = keyof typeof messages;
export class DocumentProcessingError extends Error {
  constructor(readonly code: DocumentErrorCode) {
    super(messages[code]);
    this.name = 'DocumentProcessingError';
  }
}
export function documentErrorCode(error: unknown): DocumentErrorCode {
  if (error instanceof DocumentProcessingError) return error.code;
  const message = error instanceof Error ? error.message : '';
  if (/requires OCR|unsupported text layout/i.test(message)) return 'PDF_OCR_REQUIRED';
  if (/limit exceeded|unsupported PDF page count|unsupported PDF page dimensions|invalid PDF limits/i.test(message)) return 'DOCUMENT_LIMIT';
  if (/encrypted|password|invalid PDF input|^DOCX:/i.test(message)) return 'DOCUMENT_FORMAT';
  if (/session unavailable|session not ready|session closed/i.test(message)) return 'DOCUMENT_SESSION';
  if (/worker|content security policy|failed to fetch|document host unavailable|receiving end does not exist/i.test(message)) return 'DOCUMENT_WORKER';
  return 'DOCUMENT_FAILED';
}
export function documentErrorNotice(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code?.startsWith('MODEL_') || code === 'INFERENCE_FAILED' || code === 'OUT_OF_MEMORY') {
    return '개인정보 검사 모델을 준비하거나 실행하지 못했습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.';
  }
  return messages[documentErrorCode(error)];
}
export function isDocumentErrorCode(code: unknown): code is DocumentErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(messages, code);
}
