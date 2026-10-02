import { createPiiDetectorClient } from '../../src/core/api';

// Test-only extension page entry. Bundled into the built extension at test time
// so the browser suite can exercise the real public client over the real
// background/offscreen/worker transport without shipping any demo UI.
Object.assign(window, { piiDetector: createPiiDetectorClient() });
