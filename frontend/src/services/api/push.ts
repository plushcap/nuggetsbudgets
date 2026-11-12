/**
 * API Push Module — Web Push for the signed-in person's own devices. Each answer is parsed
 * with its `@nuggets/shared` schema.
 */
import {
  pushDeviceCountResponseSchema,
  pushPublicKeyResponseSchema,
  pushSendResultSchema,
  pushSubscribedResponseSchema,
  pushUnsubscribedResponseSchema,
  type PushSendResult,
} from '@nuggets/shared';
import { apiGet, apiPost } from './base';
import { parseAnswer } from './parseAnswer';

export type { PushSendResult };

export const getPushPublicKey = async (): Promise<{ publicKey: string }> =>
  parseAnswer(pushPublicKeyResponseSchema, await apiGet<unknown>('/push/public-key'), 'push public key');

export const getPushDeviceCount = async (): Promise<{ count: number }> =>
  parseAnswer(pushDeviceCountResponseSchema, await apiGet<unknown>('/push/subscriptions/count'), 'push device count');

/** Body is `PushSubscription.toJSON()`. */
export const savePushSubscription = async (subscription: PushSubscriptionJSON): Promise<{ uuid: string }> =>
  parseAnswer(pushSubscribedResponseSchema, await apiPost<unknown>('/push/subscriptions', subscription), 'push subscription');

export const removePushSubscription = async (endpoint: string): Promise<{ removed: boolean }> =>
  parseAnswer(pushUnsubscribedResponseSchema, await apiPost<unknown>('/push/subscriptions/remove', { endpoint }), 'push subscription removed');

export const sendTestPush = async (): Promise<PushSendResult> =>
  parseAnswer(pushSendResultSchema, await apiPost<unknown>('/push/test'), 'test push');
