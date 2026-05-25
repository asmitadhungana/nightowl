/**
 * NightOwl Friend Lock bot — Cloudflare Worker entry.
 *
 * Routes:
 *   POST /tg/webhook/<TG_WEBHOOK_SECRET>   ← Telegram updates
 *   POST /desktop/enroll                   ← desktop registers pubkey, gets pair code
 *   POST /desktop/poll                     ← desktop pulls inbox messages
 *   POST /desktop/request-uninstall        ← desktop asks bot to DM friend for /approve|/deny
 *   GET  /healthz                          ← liveness probe
 */

import type { Env } from './env.js';
import { handleTelegramWebhook } from './routes/tg-webhook.js';
import { handleEnroll } from './routes/enroll.js';
import { handlePoll } from './routes/poll.js';
import { handleRequestUninstall } from './routes/request-uninstall.js';
import { handleRequestFocusRelease } from './routes/request-focus-release.js';
import {
  handleAttachDevice,
  handleCreateAccount,
  handleHeartbeat,
  handleMintJoinCode,
} from './routes/account.js';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // Healthz — anyone can hit it.
    if (method === 'GET' && path === '/healthz') {
      return new Response('ok', { status: 200 });
    }

    // Telegram webhook — secret in path, never logged in URL routing.
    if (method === 'POST' && path.startsWith('/tg/webhook/')) {
      const secret = path.slice('/tg/webhook/'.length);
      return handleTelegramWebhook(req, env, secret);
    }

    if (method === 'POST' && path === '/desktop/enroll') {
      return handleEnroll(req, env);
    }

    if (method === 'POST' && path === '/desktop/poll') {
      return handlePoll(req, env);
    }

    if (method === 'POST' && path === '/desktop/request-uninstall') {
      return handleRequestUninstall(req, env);
    }

    if (method === 'POST' && path === '/desktop/request-focus-release') {
      return handleRequestFocusRelease(req, env);
    }

    // Circles Phase 1 — multi-device Accounts. Additive; not yet exercised by
    // shipped clients. Safe to deploy (new paths only) but gated on review.
    if (method === 'POST' && path === '/desktop/account/create') {
      return handleCreateAccount(req, env);
    }
    if (method === 'POST' && path === '/desktop/account/join-code') {
      return handleMintJoinCode(req, env);
    }
    if (method === 'POST' && path === '/desktop/account/attach') {
      return handleAttachDevice(req, env);
    }
    if (method === 'POST' && path === '/desktop/account/heartbeat') {
      return handleHeartbeat(req, env);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
