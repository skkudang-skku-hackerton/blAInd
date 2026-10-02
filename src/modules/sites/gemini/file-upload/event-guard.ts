/**
 * 우리가 재발행한 이벤트를 후킹 로직이 다시 잡지 않도록 표시한다.
 *
 * change/drop/paste 를 capture 단계에서 가로챈 뒤, 마스킹 파일을 붙여 같은 이벤트를
 * 다시 dispatch 하면 후킹 리스너가 그 이벤트도 잡아 무한 루프에 빠진다.
 * 재발행 직전에 이벤트를 등록해 두고 후킹 시점에 걸러낸다.
 */

const internalEvents = new WeakSet<Event>();

/** 재발행(re-inject) 이벤트임을 표시한다. dispatch 직전에 호출. */
export function markInternalEvent(event: Event): void {
  internalEvents.add(event);
}

/** 우리가 만든 이벤트인지 확인한다. 후킹 리스너 최상단에서 호출. */
export function isInternalEvent(event: Event): boolean {
  return internalEvents.has(event);
}
