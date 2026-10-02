/**
 * 파일 종류 분류. 어떤 문서 모듈로 보낼지 결정하는 라우팅 입력.
 *
 * MIME 을 우선 보고, 비어 있거나 불확실하면 확장자로 보완한다. 브라우저가
 * HWPX 처럼 MIME 을 표준화하지 않은 형식이 있어 확장자 fallback 이 필요하다.
 */

import type { DocumentKind } from './types';

const EXTENSION_MAP: Readonly<Record<string, DocumentKind>> = {
  pdf: 'pdf',
  docx: 'docx',
  doc: 'docx',
  hwpx: 'hwpx',
  hwp: 'hwpx',
  txt: 'text',
  md: 'text',
  csv: 'text',
  tsv: 'text',
  json: 'text',
  log: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
  svg: 'image',
};

export function classifyFile(file: File): DocumentKind {
  const mime = (file.type || '').toLowerCase();

  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/msword') return 'docx';
  if (mime.includes('officedocument.wordprocessingml')) return 'docx';
  if (mime.includes('hwp') || mime.includes('haansoft')) return 'hwpx';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/')) return 'text';

  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MAP[extension] ?? 'unknown';
}
