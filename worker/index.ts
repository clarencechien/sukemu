/* sukemu Worker:靜態資產(Workers Assets)+ Google OIDC + 白名單/配額 + Gemini 兩趟制。
   架構仿 manemu(app/src/index.mjs):全 server-side OAuth、HMAC session cookie、
   R2 名單熱更新、DO 每人每日配額、/admin 管理頁(僅 ADMIN_EMAILS)。
   一次性部署步驟見 docs/oidc-setup.md。 */

import {
  addToWaitlist,
  cookieGet,
  cookieSet,
  randomHex,
  resolveUser,
  sessionFrom,
  sign,
  verify,
  verifyGoogleIdToken,
  type UserInfo,
} from './auth';
import { estCostTwd, runP1, runP2 } from './gemini';
import { handleAdmin } from './admin';
import type { Usage } from './quota';
export { QuotaCounter } from './quota';

export interface Env {
  ASSETS: Fetcher;
  R2: R2Bucket;
  QUOTA: DurableObjectNamespace;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  GEMINI_MODEL_P2?: string;
  // OIDC(未設 GOOGLE_CLIENT_ID → 開發用 Email 直登)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  // 名單與配額
  ADMIN_EMAILS?: string;
  QUOTA_TIERS?: string;
  DEFAULT_TIER?: string;
  DAILY_IMAGES_LIMIT?: string;
  // 安全與計價
  CANONICAL_HOST?: string;
  PRICE_IN_USD_PER_M?: string;
  PRICE_OUT_USD_PER_M?: string;
  USD_TWD?: string;
}

/** base64 上限 ~14MB(前端已縮到長邊 2048,實際遠小於此) */
const MAX_IMAGE_B64 = 14_000_000;

const json = (data: unknown, init?: ResponseInit) => Response.json(data, init);
const bad = (msg: string, status = 400) => json({ ok: false, error: msg }, { status });

const SEC_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};
const withSec = (res: Response) => {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SEC_HEADERS)) r.headers.set(k, v);
  return r;
};
const sameOrigin = (req: Request) => {
  const o = req.headers.get('origin');
  return !o || o === new URL(req.url).origin;
};

const quotaStub = (env: Env, email: string) => env.QUOTA.get(env.QUOTA.idFromName(email));
const readUsage = async (env: Env, email: string): Promise<Usage> =>
  (await quotaStub(env, email).fetch('https://do/usage')).json<Usage>();

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // 縱深防禦:設了 CANONICAL_HOST 之後,workers.dev 等非正式 host 一律導回正式網域
    if (env.CANONICAL_HOST && url.hostname !== env.CANONICAL_HOST && url.hostname !== 'localhost') {
      if (req.method === 'GET' && !p.startsWith('/api')) {
        return Response.redirect(`https://${env.CANONICAL_HOST}${p}${url.search}`, 301);
      }
      return new Response('use canonical host', { status: 403 });
    }

    if (p === '/api/config') {
      return json({
        mode: env.GOOGLE_CLIENT_ID ? 'oidc' : 'dev',
        turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
      });
    }

    /* ---------- OAuth(仿 manemu §5.6) ---------- */
    if (p === '/auth/login') {
      if (!env.GOOGLE_CLIENT_ID) return bad('尚未設定 Google OIDC,開發模式請用 Email 登入', 404);
      // Turnstile:設了 secret 就強制驗(POST + token);沒設則 GET/POST 直通
      if (env.TURNSTILE_SECRET) {
        if (req.method !== 'POST') return new Response(null, { status: 302, headers: { location: '/' } });
        if (!sameOrigin(req)) return new Response('forbidden', { status: 403 });
        const form = await req.formData();
        const token = form.get('cf-turnstile-response');
        if (!token) return new Response('challenge required', { status: 403 });
        const vr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            secret: env.TURNSTILE_SECRET,
            response: String(token),
            remoteip: req.headers.get('cf-connecting-ip') || '',
          }),
        });
        if (!((await vr.json()) as { success: boolean }).success) return new Response('challenge failed', { status: 403 });
      }
      const state = randomHex();
      const nonce = randomHex();
      const stCookie = cookieSet('sk_oauth', await sign({ state, nonce, exp: Date.now() / 1000 + 600 }, env), 600);
      const q = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: `${url.origin}/auth/callback`,
        response_type: 'code',
        scope: 'openid email',
        state,
        nonce,
        prompt: 'select_account',
      });
      return new Response(null, {
        status: 302,
        headers: { location: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, 'set-cookie': stCookie },
      });
    }
    if (p === '/auth/callback') {
      const st = await verify(cookieGet(req, 'sk_oauth'), env);
      if (!st || st.state !== url.searchParams.get('state')) return new Response('state mismatch', { status: 403 });
      const tr = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: url.searchParams.get('code') ?? '',
          client_id: env.GOOGLE_CLIENT_ID ?? '',
          client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
          redirect_uri: `${url.origin}/auth/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const tok = (await tr.json()) as { id_token?: string };
      const claims = tok.id_token && (await verifyGoogleIdToken(tok.id_token, env.GOOGLE_CLIENT_ID!, st.nonce));
      if (!claims) return new Response('token verification failed', { status: 403 });
      if (!(await resolveUser(claims.email, env)).allowed) {
        await addToWaitlist(env, claims.email).catch(() => {}); // admin 可在 /admin 一鍵核准
        return new Response(null, {
          status: 302,
          headers: { location: `/?waitlist=1`, 'set-cookie': cookieSet('sk_oauth', '', 0) },
        });
      }
      const session = await sign({ email: claims.email, exp: Date.now() / 1000 + 7 * 86400 }, env);
      return new Response(null, {
        status: 302,
        headers: { location: '/', 'set-cookie': cookieSet('sk_session', session, 7 * 86400) },
      });
    }
    if (p === '/auth/logout') {
      return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': cookieSet('sk_session', '', 0) } });
    }

    // 開發用 Email 直登:只在未設定 OIDC 時開放
    if (p === '/api/login' && req.method === 'POST') {
      if (env.GOOGLE_CLIENT_ID) return bad('已啟用 Google 登入,請走 /auth/login', 403);
      const { email: raw } = (await req.json().catch(() => ({}))) as { email?: string };
      const email = (raw ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('Email 格式不正確');
      if (!(await resolveUser(email, env)).allowed) {
        await addToWaitlist(env, email);
        return json({ ok: false, waitlist: true }, { status: 403 });
      }
      const session = await sign({ email, exp: Date.now() / 1000 + 30 * 86400 }, env);
      return json({ ok: true, email }, { headers: { 'Set-Cookie': cookieSet('sk_session', session, 30 * 86400) } });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      return json({ ok: true }, { headers: { 'Set-Cookie': cookieSet('sk_session', '', 0) } });
    }

    /* ---------- 需要登入的部分 ---------- */
    if (p.startsWith('/api/')) {
      if (!sameOrigin(req)) return new Response('forbidden', { status: 403 });
      const session = await sessionFrom(req, env);
      if (!session) return bad('請先登入', 401);
      // 每次請求重算分級 → R2 白名單改了立刻生效(不用重登入、不用重部署)
      const user = await resolveUser(session.email, env);
      if (!user.allowed) return bad('不在受邀名單內', 403);
      try {
        return await api(req, env, ctx, p, session.email, user);
      } catch (err) {
        return bad(err instanceof Error ? err.message : '伺服器錯誤', 500);
      }
    }

    return withSec(await env.ASSETS.fetch(req));
  },
} satisfies ExportedHandler<Env>;

async function api(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
  email: string,
  user: UserInfo,
): Promise<Response> {
  if (path.startsWith('/api/admin/')) {
    if (!user.isAdmin) return bad('admin_only', 403);
    return handleAdmin(req, env, path);
  }

  if (path === '/api/me' && req.method === 'GET') {
    const u = await readUsage(env, email).catch(() => null);
    return json({
      ok: true,
      email,
      tier: user.tier,
      isAdmin: user.isAdmin,
      usedImages: u?.count ?? 0,
      limitImages: user.limitImages,
      todayTwd: u?.costTwd ?? 0,
    });
  }

  if (path === '/api/p1' && req.method === 'POST') {
    const { image, mime, name } = (await req.json().catch(() => ({}))) as {
      image?: string;
      mime?: string;
      name?: string;
    };
    if (!image || !mime?.startsWith('image/')) return bad('缺少影像資料');
    if (image.length > MAX_IMAGE_B64) return bad('影像過大,請縮小後再試', 413);

    // 配額保險絲:上限由分級決定(0 = 無上限),DO 只計數
    const u = await readUsage(env, email).catch(() => null);
    if (u && user.limitImages > 0 && u.count >= user.limitImages) {
      return bad(`今日額度已用完(${u.count}/${user.limitImages} 張),台灣時間早上 8 點重置`, 429);
    }

    const { lang, blocks, usage } = await runP1(env, image, mime);
    const twd = estCostTwd(env, usage);
    // 成功才計費(失敗不扣額度)
    ctx.waitUntil(
      quotaStub(env, email).fetch('https://do/add', {
        method: 'POST',
        body: JSON.stringify({ images: 1, ...usage, costTwd: twd }),
      }),
    );
    return json({ ok: true, result: { name: name || 'photo', lang, blocks }, usage: { ...usage, twd } });
  }

  if (path === '/api/p2' && req.method === 'POST') {
    const { lang, blocks } = (await req.json().catch(() => ({}))) as {
      lang?: string;
      blocks?: { en: string; zh: string }[];
    };
    if (!Array.isArray(blocks) || !blocks.length) return bad('缺少文字塊');
    const { edits, usage } = await runP2(env, lang || '??', blocks);
    const twd = estCostTwd(env, usage);
    ctx.waitUntil(
      quotaStub(env, email).fetch('https://do/add', {
        method: 'POST',
        body: JSON.stringify({ images: 0, ...usage, costTwd: twd }),
      }),
    );
    return json({ ok: true, edits, usage: { ...usage, twd } });
  }

  return bad('不存在的 API', 404);
}
