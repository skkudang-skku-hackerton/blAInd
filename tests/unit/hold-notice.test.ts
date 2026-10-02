import { expect, test } from 'vitest';
import { parseHTML } from 'linkedom';
import { createHoldNotice } from '../../src/features/review/hold-notice';

test('보류 안내는 중복 생성하지 않고 dispose 시 제거한다', () => {
  const { document } = parseHTML('<html><body></body></html>');
  const notice = createHoldNotice(document as unknown as Document);
  try {
    notice.show('Enter 전송 보류');
    notice.show('다시 보류');
    expect(document.querySelectorAll('[data-blaind-notice="hold"]')).toHaveLength(1);
  } finally {
    notice.dispose();
  }
  expect(document.querySelectorAll('[data-blaind-notice="hold"]')).toHaveLength(0);
});
