import { describe, expect, it } from 'vitest';
import { DocumentProcessingError, documentErrorCode, documentErrorNotice, isDocumentErrorCode } from '../../src/modules/documents/shared/errors';
import { PiiError } from '../../src/core/api/errors';

describe('document error reporting', () => {
  it.each([
    ['PDF requires OCR or unsupported text layout', 'PDF_OCR_REQUIRED'],
    ['PDF input size limit exceeded', 'DOCUMENT_LIMIT'],
    ['Unsupported PDF page count', 'DOCUMENT_LIMIT'],
    ['Encrypted or unsupported document', 'DOCUMENT_FORMAT'],
    ['DOCX: invalid ZIP end record', 'DOCUMENT_FORMAT'],
    ['Failed to construct Worker', 'DOCUMENT_WORKER'],
    ['Document session unavailable', 'DOCUMENT_SESSION'],
    ['unexpected PRIVATE_VALUE', 'DOCUMENT_FAILED'],
  ])('classifies %s without echoing document content', (message, code) => {
    const error = new Error(message);
    expect(documentErrorCode(error)).toBe(code);
    expect(documentErrorNotice(error)).not.toContain('PRIVATE_VALUE');
  });
  it('retains safe codes across the offscreen message boundary', () => {
    const error = new DocumentProcessingError('PDF_OCR_REQUIRED');
    expect(documentErrorCode(error)).toBe('PDF_OCR_REQUIRED');
    expect(documentErrorNotice(error)).toContain('이미지');
    expect(isDocumentErrorCode('PDF_OCR_REQUIRED')).toBe(true);
    expect(isDocumentErrorCode('__proto__')).toBe(false);
    expect(isDocumentErrorCode('unknown')).toBe(false);
  });
  it('distinguishes model errors from document extraction errors', () => {
    expect(documentErrorNotice(new PiiError('MODEL_LOAD_FAILED', 'failed'))).toContain('모델');
  });
});
