import { browser } from 'wxt/browser';
import {
  isBackgroundStatusResponse,
  type BackgroundStatusRequest,
  type BackgroundStatusResponse,
} from './protocol';

export async function requestBackgroundStatus(): Promise<BackgroundStatusResponse> {
  const request: BackgroundStatusRequest = {
    target: 'background',
    type: 'GET_BACKGROUND_STATUS',
  };

  const response: unknown = await browser.runtime.sendMessage(request);
  if (!isBackgroundStatusResponse(response)) {
    throw new Error('Background returned an invalid status response');
  }

  return response;
}
