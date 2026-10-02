/**
 * ChatGPT 파일 업로드 처리 모듈 공개 API.
 *
 * 책임 범위
 * - 파일 입력(change/drop/paste) 가로채기
 * - 파일 종류 분류 후 문서 모듈(DocumentProcessor)로 전달
 * - 돌려받은 파일을 ChatGPT 첨부로 대체 주입
 * - DOM 을 우회한 업로드 감시(네트워크 안전망, 보조)
 *
 * 책임 밖 (다른 팀/모듈)
 * - 코어 개인정보 검사·마스킹·문서 재생성: 문서 모듈(pdf/docx/hwpx) 내부
 * - 승인 UI: features/review
 * - 확장 메시징·오프스크린·설정: shared/, entrypoints/
 *
 * 문서 모듈은 아래 시그니처만 구현해 주입하면 된다.
 *
 *   const processors: DocumentProcessorRegistry = {
 *     pdf: async (file, signal) => { ... 코어와 통신해 수정된 File 반환 ... },
 *     docx: async (file, signal) => { ... },
 *   };
 *   createFileUploadInterceptor({ processors }).start();
 */

export { createFileUploadInterceptor } from './dom-interceptor';
export type { FileUploadInterceptor } from './dom-interceptor';
export { installNetworkGuard } from './network-guard';
export type { NetworkGuard, NetworkGuardOptions, NetworkGuardDetectInfo } from './network-guard';
export { classifyFile } from './classify';
export { injectFilesIntoDrop, injectFilesIntoInput, createFileList } from './file-injector';
export { isInternalEvent, markInternalEvent } from './event-guard';
export { CHATGPT_SITE_ID } from './types';
export type {
  ChatGptSiteId,
  DocumentKind,
  DocumentProcessor,
  DocumentProcessorRegistry,
  FileInterceptContext,
  FileSource,
  FileUploadInterceptorOptions,
} from './types';
