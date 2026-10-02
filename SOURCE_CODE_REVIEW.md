# Firefox source code review

blAInd is built with WXT, React, TypeScript, and npm. Use Node.js 22.12 or
newer in the Node.js 22 release line. The lockfile pins build dependencies.

From the extracted source archive, run:

```sh
npm ci
npm run build:firefox
```

The install step generates WXT's TypeScript configuration in `.wxt/`.
The production extension is written to `.output/firefox-mv2/`.
To produce the upload ZIP as well, run `npm run zip:firefox`.
No credentials, environment files, or private dependencies are needed.

WXT bundles the source files and copies ONNX Runtime's ESM/WASM assets from
`node_modules/onnxruntime-web/dist` into the extension's `ort-wasm/` directory.
Model weights and tokenizer data are downloaded at runtime from the public
Hugging Face repository pinned in `src/core/detector/ko-pii/model-config.ts`;
the build does not download model data. Firefox uses a Manifest V2 persistent
background page and the WASM inference backend.
