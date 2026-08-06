/* sukemu Worker:靜態資產(Workers Assets)+ API。
   部署:wrangler r2 bucket create sukemu(一次)→ wrangler secret put GEMINI_API_KEY → npm run deploy。 */

import { addToWaitlist, allowlist, authCookie, cookieEmail, requireUser } from './auth';
import { runP1, runP2 } from './gemini';

export interface Env {
  ASSETS: Fetcher;
  R2: R2Bucket;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  GEMINI_MODEL_P2?: string;
}

/** base64 上限 ~14MB(前端已縮到長邊 2048,實際遠小於此) */
const MAX_IMAGE_B64 = 14_000_000;

const json = (data: unknown, init?: ResponseInit) => Response.json(data, init);
const bad = (msg: string, status = 400) => json({ ok: false, error: msg }, { status });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(req, env, url.pathname);
      } catch (err) {
        return bad(err instanceof Error ? err.message : '伺服器錯誤', 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

async function api(req: Request, env: Env, path: string): Promise<Response> {
  if (path === '/api/me' && req.method === 'GET') {
    const email = cookieEmail(req);
    if (email && (await allowlist(env)).includes(email)) return json({ ok: true, email });
    return bad('未登入', 401);
  }

  if (path === '/api/login' && req.method === 'POST') {
    const { email: raw } = (await req.json().catch(() => ({}))) as { email?: string };
    const email = (raw ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('Email 格式不正確');
    if ((await allowlist(env)).includes(email)) {
      return json({ ok: true, email }, { headers: { 'Set-Cookie': authCookie(email) } });
    }
    await addToWaitlist(env, email);
    return json({ ok: false, waitlist: true }, { status: 403 });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    return json({ ok: true }, { headers: { 'Set-Cookie': authCookie('', true) } });
  }

  if (path === '/api/p1' && req.method === 'POST') {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const { image, mime, name } = (await req.json().catch(() => ({}))) as {
      image?: string;
      mime?: string;
      name?: string;
    };
    if (!image || !mime?.startsWith('image/')) return bad('缺少影像資料');
    if (image.length > MAX_IMAGE_B64) return bad('影像過大,請縮小後再試', 413);
    const { lang, blocks } = await runP1(env, image, mime);
    return json({ ok: true, result: { name: name || 'photo', lang, blocks } });
  }

  if (path === '/api/p2' && req.method === 'POST') {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const { lang, blocks } = (await req.json().catch(() => ({}))) as {
      lang?: string;
      blocks?: { en: string; zh: string }[];
    };
    if (!Array.isArray(blocks) || !blocks.length) return bad('缺少文字塊');
    const edits = await runP2(env, lang || '??', blocks);
    return json({ ok: true, edits });
  }

  return bad('不存在的 API', 404);
}
