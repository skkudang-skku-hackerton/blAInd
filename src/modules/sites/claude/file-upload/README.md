# Claude 파일 업로드

`claude.ai`의 업로드 인터셉터입니다. 공통 동작·API·안전 규칙은 [사이트 모듈](../../README.md)을 참고하세요.
이 문서는 Claude의 업로드 방식과 그에 따른 설계 근거만 다룹니다.

## 대상 사이트

- URL: `https://claude.ai/`
- 프레임워크: React(Next.js) 계열 — DOM 이벤트 위임 구조
- 업로드 흐름: `.../conversations/{conv}/wiggle/upload-file` 로의 **단일 multipart POST**.
  아래 HAR 분석 참고.

## 업로드 흐름 (HAR 확인)

`claude.ai.har`에서 확인한 흐름이다.

```http
POST /api/organizations/{org}/conversations/{conversation}/wiggle/upload-file
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary...
(필드명: file / filename / Content-Type: application/pdf)

→ 200 application/json
{
  "success": true,
  "path": "/mnt/user-data/uploads/NLP_W5_lecture.pdf",
  "sanitized_name": "NLP_W5_lecture.pdf",
  "file_kind": "document",
  "file_uuid": "488fcf0c-ab21-4acb-8665-743013b08d42",
  "file_name": "NLP_W5_lecture.pdf",
  "size_bytes": 1122819,
  "thumbnail_asset": { "url": "/api/{org}/files/{uuid}/thumbnail", ... }
}
```

- 업로드는 **단일 multipart POST** 한 번. 서버가 텍스트 추출·썸네일까지 처리한다.
- 인증은 쿠키 기반이며 `Authorization` 헤더가 없다.
- 핵심 식별자는 `wiggle/upload-file` 경로다.
- 이후 `GET /api/{org}/files/{uuid}/thumbnail` 은 업로드가 아니다.

**설계 결론:** 요청이 multipart 라 파일 파트를 식별할 수는 있지만, 서버가 처리하기 전에
**DOM 단계에서 원본을 바꿔치기**해야 한다.

## 남은 확인

- 실제 로그인한 Claude 화면에서 capture 차단과 재첨부 E2E 확인
- composer 구조 변경 시 안전한 재첨부 범위 재확인
