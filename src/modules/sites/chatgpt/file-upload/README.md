# ChatGPT 파일 업로드

`chatgpt.com`의 업로드 인터셉터입니다. 공통 동작·API·안전 규칙은 [사이트 모듈](../../README.md)을 참고하세요.
이 문서는 ChatGPT의 업로드 방식과 그에 따른 설계 근거만 다룹니다.

## 대상 사이트

- URL: `https://chatgpt.com/`
- 업로드 흐름: 업로드 예약 → `*.oaiusercontent.com`으로 raw PUT → 처리 완료 요청. 아래 분석 참고.

## 업로드 흐름 (번들 분석)

`chatgpt.com` 번들(`legacy-image-upload-*.js`, `a-Cn0LrOds.js`)을 분석해 확인한 흐름이다.
인증/비인증에 따라 경로 접두사만 `backend-api` / `backend-anon` 으로 갈린다.

```
1) POST /backend-(api|anon)/files
     body(JSON): { file_name, file_size, mime_type, client_resolved_mime_type,
                   use_case: "multimodal", selection_method, entry_surface,
                   reset_rate_limits, timezone_offset_min, ... }
     resp(JSON): { file_id, status, upload_url, upload_headers?, ... }

2) 파일 전송 (upload_url 기준으로 분기)
     ├─ upload_url 경로가 /estuary/upload_content_bytes
     │    → POST  (FormData: file, upload_url)  (credentials: include)
     └─ 그 외
          → PUT   upload_url + upload_headers (예: *.oaiusercontent.com)

3) POST /backend-(api|anon)/files/process_upload_stream
     body(JSON): { file_id, file_name, use_case: "multimodal",
                   entry_surface: "chat_composer", index_for_retrieval }
```

- 번들 내 경로 검증기가 허용 경로를 정확히 열거한다:
  `/backend-api/files[/process_upload_stream]`, `/backend-anon/...`,
  `/(api|backend-api|backend-anon)/estuary/upload_content_bytes`
- 허용 오리진: `https://chatgpt.com`, `https://chatgpt-staging.com`

### 문서 업로드: 업로드 예약 방식 (HAR 확인)

`chatgpt.com_2.har`에서 PDF 1건의 전체 흐름이 확인됐다. 신형 "업로드 예약(reservation)" 방식이다.

```jsonc
// 1) POST /backend-api/files/upload_reservations    (application/json)
//    body
{
  "intended_use_case": "my_files",
  "entry_surface": "chat_composer",
  "requires_gizmo_id": false,
  "store_in_library": true,
  "library_persistence_mode": "opportunistic"
}
//    resp
{ "eligible": true,
  "reservation_id": "file_0000000024048206b09f19d14823200b",
  "upload_url": "https://<region>.oaiusercontent.com/files/<id>/raw?<SAS 토큰>",
  "upload_url_expires_at": "...", "reservation_expires_at": "..." }

// 2) PUT {upload_url}   (원본 바이트, cross-site, Azure Blob)
//    upload_url = https://<region>.oaiusercontent.com/files/<id>/raw?se=..&sp=w&sv=..&sr=b&sig=..
//    headers: content-type: application/pdf
//             x-ms-blob-type: BlockBlob
//             x-ms-blob-content-type: application/pdf
//             x-ms-version: 2020-04-08
//    → 201. SAS 쿼리로 인증하며 Authorization 헤더는 없다.

// 3) POST /backend-api/files/upload_reservations/{reservation_id}/claim_and_finish
{
  "file_name": "NLP_W5_lecture-1.pdf",
  "file_size": 1122819,
  "use_case": "my_files",
  "index_for_retrieval": true,
  "store_in_library": true,
  "library_persistence_mode": "opportunistic",
  "mime_type": "application/pdf",
  "entry_surface": "chat_composer",
  "metadata": { "store_in_library": true, "is_project_thread": false }
}
//    resp: text/event-stream (NDJSON)
//      file.processing.started → file.processing.file_ready
//      → file.indexing.completed → file.processing.completed
```

이후 `POST /backend-api/file_upload_action_suggestions`(UI 제안)가 이어진다(업로드와 무관).

- 다른 HAR에서는 대체 경로 `POST /backend-api/files/process_upload_stream`(본문에 `file_id` 포함)도
  관찰됐다. 계정·기능 플래그·진입점에 따라 둘 중 하나가 쓰이는 것으로 보인다.
- **이미지**: `use_case: "multimodal"`, **문서**: `use_case: "my_files"` + `index_for_retrieval: true`
- 인증은 (HTTP-only) 쿠키 + `chatgpt-account-id`/`oai-did` 헤더. `Authorization` 헤더는 없다.

**설계 결론:** 2단계 파일 전송은 `oaiusercontent.com` 으로의 **불투명한 raw PUT**(BlockBlob)이라,
이 층에서는 파일 내용을 읽거나 마스킹할 수 없다. 따라서 개인정보 차단은 반드시 **DOM 입력 단계**에서
원본 `File` 을 바꿔치기해야 한다.

> 두 HAR 모두 Codex 브라우저 세션에서 캡처해 `x-openai-*` 헤더는 일반 웹 세션과 다를 수 있다.

## 남은 확인

- 실제 로그인한 ChatGPT 화면에서 capture 차단과 재첨부 E2E 확인
- composer 구조 변경 시 안전한 재첨부 범위 재확인
