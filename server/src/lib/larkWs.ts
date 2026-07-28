import * as Lark from '@larksuiteoapi/node-sdk';
import { Server } from 'socket.io';
import { getConfig } from '../config';
import { handleInboundLarkMessage } from './larkInbound';

// Bagian 4 — INBOUND transport: Lark "persistent connection" (long connection)
// mode via the official SDK's WSClient. The connection is OUTBOUND from this
// server to Lark, so there's no public webhook URL, no nginx change, and no
// Encrypt Key / Verification Token — the SDK authenticates once at connect with
// app credentials and delivers already-decrypted events over the socket.
//
// Requires "long connection" to be selected as the subscription mode in the
// Lark Console (Events & Callbacks) and im.message.receive_v1 subscribed.
// Reconnection is handled by the SDK. No-op when Lark app credentials are unset
// (the feature simply stays off), so the server still boots fine without Lark.

let started = false;

export function startLarkEventStream(io: Server): void {
  if (started) return; // guard against a double-start (e.g. reused across restarts)
  const cfg = getConfig();
  if (!cfg.LARK_APP_ID || !cfg.LARK_APP_SECRET) {
    console.log('[larkWs] Lark app credentials unset — event stream disabled');
    return;
  }
  started = true;

  const wsClient = new Lark.WSClient({
    appId: cfg.LARK_APP_ID,
    appSecret: cfg.LARK_APP_SECRET,
    // Domain.Lark = larksuite.com (international); Domain.Feishu = feishu.cn.
    // This deployment is on larksuite.com (see larkToken.LARK_OPENAPI_BASE).
    domain: Lark.Domain.Lark,
    loggerLevel: Lark.LoggerLevel.info,
    onReady: () => console.log('[larkWs] persistent connection ready'),
    onError: (err) => console.error('[larkWs] connection error:', err),
    onReconnecting: () => console.log('[larkWs] reconnecting…'),
    onReconnected: () => console.log('[larkWs] reconnected'),
  });

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    // The SDK hands the handler the already-decrypted event body. Errors are
    // swallowed per-message so one bad event never tears down the stream.
    'im.message.receive_v1': async (data: any) => {
      try {
        await handleInboundLarkMessage(io, data);
      } catch (e) {
        console.error('[larkWs] inbound handler error:', e);
      }
    },
  });

  wsClient.start({ eventDispatcher });
}
