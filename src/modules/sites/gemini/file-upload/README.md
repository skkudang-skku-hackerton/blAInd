# Gemini 파일 업로드

`gemini.google.com`의 업로드 인터셉터입니다. 공통 동작·API·안전 규칙은 [사이트 모듈](../../README.md)을 참고하세요.
이 문서는 Gemini의 업로드 방식과 그에 따른 설계 근거만 다룹니다.

## 대상 사이트

- URL: `https://gemini.google.com/app`
- 프레임워크: Angular — DOM 이벤트 위임 구조 (React 전제 아님)
- 업로드 흐름: `push.clients6.google.com/upload/` 로의 **Google resumable upload**
  (raw 바이트 POST). 아래 HAR 분석 참고.

## 업로드 흐름 (HAR 확인)

`gemini.google.com.har`에서 확인한 Google resumable upload 흐름이다.

```http
1) POST https://push.clients6.google.com/upload/
   push-id: feeds/<id>
   x-client-pctx: <token>
   x-tenant-id: bard-storage
   x-goog-upload-command: start
   x-goog-upload-header-content-length: 1122819
   content-type: application/x-www-form-urlencoded
   body: "File name: NLP_W5_lecture-1.pdf"

2) POST https://push.clients6.google.com/upload/?upload_id=<id>
   x-goog-upload-command: upload, finalize
   x-goog-upload-offset: 0
   push-id / x-client-pctx / x-tenant-id: bard-storage
   content-type: application/x-www-form-urlencoded
   body: 원본 파일 바이트 (1,122,819)
   → 200 text/html  "/contrib_service/ttl_1d/<token>"

3) POST /_/BardChatUi/data/batchexecute?rpcids=VxUbXb / ESY5D
   로 업로드 결과를 대화에 연결
```

- 파일 전송은 **raw 바이트 POST** 라 네트워크 단계에서 내용을 읽거나 마스킹할 수 없다.

**설계 결론:** 반드시 **DOM 단계에서 원본 `File` 을 바꿔치기**해야 한다.

## 남은 확인

- 실제 로그인한 Gemini 화면에서 capture 차단과 재첨부 E2E 확인
- composer 구조 변경 시 안전한 재첨부 범위 재확인
