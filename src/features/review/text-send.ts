import type { TextSiteAdapter, TextSubmitContext, TextSubmitInterceptor } from '../../modules/text';

/** 승인된 원문 위치에만 교체하고, 갱신된 전송 버튼을 한 번 호출합니다. */
export function createTextSender(adapter: TextSiteAdapter, interceptor: TextSubmitInterceptor,
  getPageUrl: () => string) {
  let generation = 0;
  return {
    cancel() { generation++; },
    async send(context: TextSubmitContext, text: string): Promise<void> {
      const request = ++generation;
      const { editor } = context;
      const url = getPageUrl(), parent = editor.parentElement;
      const identities: Array<[Element, string, string | null]> = [];
      for (let node: Element | null = editor; node; node = node.parentElement) {
        for (const name of ['data-conversation-id', 'data-chat-id']) {
          identities.push([node, name, node.getAttribute(name)]);
        }
      }
      const valid = () => generation === request && editor.isConnected
        && editor.parentElement === parent && getPageUrl() === url
        && identities.every(([node, name, value]) => node.isConnected && node.getAttribute(name) === value);
      if (!valid() || adapter.readText(editor) !== context.text) throw new Error('Input changed before sending');
      if (text !== context.text) adapter.replaceText(editor, text);
      // 사이트의 입력 이벤트 처리와 버튼 갱신을 기다립니다.
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (!valid() || adapter.readText(editor) !== text) throw new Error('Input changed while sending');
        const button = adapter.findSendButtonForEditor(editor);
        if (!button) continue;
        interceptor.sendApproved(button, editor, text);
        return;
      }
      throw new Error('Send button is unavailable');
    },
  };
}
