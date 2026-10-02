# CI/CD 및 브라우저 확장 배포

## 자동 검증

`.github/workflows/ci.yml`은 브랜치 push와 pull request에서 Node.js 22로
`npm ci`, 타입 검사, 단위 테스트, Chrome/Firefox 프로덕션 ZIP 생성을 실행합니다.
Actions 실행의 `extension-packages` artifact에서 두 브라우저 ZIP과 Firefox
소스 ZIP을 내려받을 수 있습니다. Artifact 보관 기간은 14일입니다.
실제 AI 사이트와 모델 추론의 브라우저 수동 검증은 기존 README 절차를 따릅니다.

## GitHub 릴리스

1. 배포할 변경을 기본 브랜치에 병합합니다.
2. 버전을 올리고 `package.json`과 `package-lock.json`을 함께 커밋합니다.
   버전은 `major.minor.patch` 형식을 사용합니다.
3. 커밋에 동일한 버전의 `v` 태그를 붙이고 push합니다.

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: bump extension version"
git tag v0.1.1
git push origin HEAD
git push origin v0.1.1
```

예시의 `v0.1.1`은 실제 `package.json` 버전에 맞춰 변경합니다.
`release.yml`은 태그와 두 패키지 파일의 버전을 확인하고 CI 전체를 실행한 다음,
자동 릴리스 노트와 다음 파일을 포함한 GitHub Release를 생성합니다.

- `blaind-<version>-chrome.zip`: Chrome Web Store 업로드 패키지
- `blaind-<version>-firefox.zip`: Firefox Add-ons 업로드 패키지
- `blaind-<version>-sources.zip`: Mozilla 리뷰용 빌드 소스와 재현 절차

릴리스 실패 시 Actions에서 실패한 작업을 재실행할 수 있습니다. GitHub 릴리스
작업은 기존 릴리스가 있으면 첨부 파일을 갱신합니다. 이미 스토어에 제출된 버전은
중복 제출하지 말고 해당 스토어 작업의 결과와 개발자 대시보드를 먼저 확인합니다.

## 스토어 자동 배포 설정

최초 등록은 각 스토어의 개발자 대시보드에서 진행합니다. 소개, 아이콘, 스크린샷,
개인정보 안내 등 스토어에서 요구하는 정보를 작성하고 최초 버전을 등록합니다.
이후 자동 업데이트는 GitHub **Settings → Secrets and variables → Actions**에서
설정합니다. 각 스토어 작업은 동일한 GitHub 릴리스 artifact를 제출합니다.

### Chrome Web Store

Chrome Web Store API v2를 사용합니다. Google Cloud에서 API를 활성화하고
스토어 게시자 계정에 접근할 수 있는 서비스 계정을 구성합니다.
다음 값을 Actions **Secrets**에 등록합니다.

| Secret | 값 |
| --- | --- |
| `CHROME_EXTENSION_ID` | 등록된 확장 ID |
| `CHROME_PUBLISHER_ID` | Web Store 게시자 ID |
| `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` | 서비스 계정 이메일 |
| `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` | 서비스 계정의 전체 PEM private key |

Actions **Variables**에 `PUBLISH_CHROME=true`를 설정하면 이후 `v*` 태그
릴리스에서 Chrome 업데이트를 업로드하고 리뷰에 제출합니다.

### Firefox Add-ons (AMO)

[AMO API 키](https://addons.mozilla.org/developers/addon/api/key/)를 발급하고
다음 Actions **Secrets**를 등록합니다.

| Secret | 값 |
| --- | --- |
| `FIREFOX_JWT_ISSUER` | AMO API issuer |
| `FIREFOX_JWT_SECRET` | AMO API secret |

확장 ID는 manifest와 동일한 `blaind@skkudang-skku-hackerton.github.io`입니다.
Actions **Variables**에 `PUBLISH_FIREFOX=true`를 설정하면 Firefox ZIP과 소스 ZIP을
`listed` 채널로 제출합니다. 소스 ZIP의 `SOURCE_CODE_REVIEW.md`에 재현 빌드 절차가 있습니다.

자동 배포 변수는 각 브라우저별로 설정하며 미설정 시 GitHub 릴리스까지만 진행합니다.
스토어 제출 성공 이후 실제 공개 시점은 각 스토어의 리뷰 및 승인 과정에 따릅니다.
인증 정보는 GitHub Secrets 또는 로컬 `.env.submit`에 보관합니다.

## 로컬 패키징 및 인증 확인

```sh
npm ci
npm run typecheck
npm test
npm run zip
npx wxt submit init
```

`submit init`에서 실제로 사용할 스토어와 Chrome API v2 설정을 선택합니다.
생성된 `.env.submit`은 Git에서 제외됩니다. 설정 후 인증만 확인하려면:

```sh
npx wxt submit --dry-run --chrome-api-version v2 --chrome-zip .output/*-chrome.zip
npx wxt submit --dry-run --firefox-zip .output/*-firefox.zip --firefox-sources-zip .output/*-sources.zip
```

관련 문서: [WXT Publishing](https://wxt.dev/guide/essentials/publishing.html),
[Chrome Web Store API](https://developer.chrome.com/docs/webstore/api/),
[Firefox source submission](https://extensionworkshop.com/documentation/publish/source-code-submission/).
