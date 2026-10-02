/**
 * gemini.google.com 파일 업로드 처리의 경계 타입.
 *
 * 책임 경계
 * - 이 사이트 모듈: 파일 가로채기 → 종류 분류 → 문서 모듈에 전달 → 돌려받은 파일 첨부
 * - 문서 모듈(pdf/docx/hwpx 등): 코어와 통신해 검사·수정. 이 모듈은 코어를 모른다.
 *
 * 따라서 이 파일에는 "검사/승인/탐지" 같은 코어 개념이 없다. 문서 모듈과의 접점인
 * DocumentProcessor 하나만 정의한다.
 */

import type { ProcessingIndicator } from './processing-indicator';

export const GEMINI_SITE_ID = 'gemini' as const;
export type GeminiSiteId = typeof GEMINI_SITE_ID;

/** 파일이 어느 입력 경로로 들어왔는지. */
export type FileSource = 'input' | 'drop' | 'paste';

/** 파일 종류. 문서 모듈 라우팅 키. */
export type DocumentKind = 'pdf' | 'docx' | 'hwpx' | 'text' | 'image' | 'unknown';

/**
 * 문서 처리기. pdf/docx/hwpx 등 문서 모듈이 구현한다.
 *
 * 코어와의 통신(개인정보 검사·사용자 승인·문서 수정)은 전적으로 이 함수 안에서
 * 일어난다. 이 사이트 모듈은 결과 File 을 Gemini 첨부로 넣기만 한다.
 *
 * @param file   가로챈 원본 파일
 * @param signal 새 파일 선택 등으로 무효화되면 abort 된다
 * @returns 첨부할 파일(수정본 또는 원본). 취소/처리 불가/오류면 null → 첨부하지 않음.
 */
export type DocumentProcessor = (file: File, signal: AbortSignal) => Promise<File | null>;

/** 분류된 종류별 처리기 묶음. entrypoint 에서 조립해 주입한다. */
export type DocumentProcessorRegistry = Partial<Record<DocumentKind, DocumentProcessor>>;

/** 후킹·처리 과정의 문맥. */
export interface FileInterceptContext {
  requestId: string;
  source: FileSource;
  kind: DocumentKind;
  file: File;
}

export interface FileUploadInterceptorOptions {
  /** 종류별 문서 처리기. 이 모듈이 다른 팀과 접점하는 유일한 지점. */
  processors: DocumentProcessorRegistry;
  /** 후킹을 걸 루트. 기본값은 현재 document. ShadowRoot 전달도 가능. */
  root?: Document | ShadowRoot;
  /**
   * 처리기가 없는 종류(unknown/image/text 등)의 정책.
   * - 'passthrough' (기본): 원본 그대로 첨부
   * - 'hold': 첨부하지 않고 보류
   */
  unhandled?: 'passthrough' | 'hold';
  /**
   * 처리 중 오버레이. 기본값은 자동 생성되는 기본 인디케이터.
   * - false: 표시하지 않음
   * - ProcessingIndicator: 직접 만든 인디케이터 주입
   */
  indicator?: ProcessingIndicator | false;
  /** 파일 하나가 처리 완료됐을 때. */
  onProcessed?: (info: { requestId: string; context: FileInterceptContext }) => void;
  /** 처리되지 않고 건너뛴 파일. */
  onSkipped?: (info: { requestId: string; context: FileInterceptContext; reason: 'unhandled' | 'cancelled' }) => void;
  /** 처리기 오류. 오류가 나면 원본은 절대 대신 첨부하지 않는다. */
  onError?: (error: unknown, context: FileInterceptContext) => void;
  /** 콘솔 디버그 로그. */
  debug?: boolean;
}
