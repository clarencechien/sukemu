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
import { estCostTwd, modeToggleEnabled, resolveMode, runP1, runP2 } from './gemini';
import { handleAdmin } from './admin';
import type { Usage } from './quota';
export { QuotaCounter } from './quota';

export interface Env {
  ASSETS: Fetcher;
  R2: R2Bucket;
  QUOTA: DurableObjectNamespace;
  GEMINI_API_KEY: string;
  // 模型檔位(ADR 0001):fast 省錢、accurate 品質
  DEFAULT_MODE?: string;
  /** "off" = 鎖定預設檔位:UI 隱藏切換鈕、API 無視 modelMode */
  MODE_TOGGLE?: string;
  FAST_MODEL?: string;
  ACCURATE_MODEL?: string;
  /** P2 單獨覆寫(可不設,預設同該模式的主模型) */
  FAST_MODEL_P2?: string;
  ACCURATE_MODEL_P2?: string;
  // OIDC(未設 GOOGLE_CLIENT_ID → 開發用 Email 直登)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  // P2 thinking 檔位:minimal(預設,A/B 實測 -81% token)| low | medium | high | off(回模型預設)
  P2_THINKING_LEVEL?: string;
  // 名單與配額
  ADMIN_EMAILS?: string;
  QUOTA_TIERS?: string;
  DEFAULT_TIER?: string;
  DAILY_IMAGES_LIMIT?: string;
  /** 每人每日估算成本上限(TWD,0 = 關):張數之外的第二道門檻,病態圖與簡單圖差 7 倍花費 */
  DAILY_TWD_LIMIT?: string;
  /** 全站每日估算成本上限(TWD,0 = 關):組織層級的錢包保險絲,admin 也受限 */
  GLOBAL_DAILY_TWD?: string;
  // 安全與計價
  CANONICAL_HOST?: string;
  /** 覆寫/補充模型單價表:{"model-id":[輸入USD/M, 輸出USD/M]} */
  MODEL_PRICES?: string;
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

/* Turnstile 必須「site key + secret」兩者齊備才啟用。
   只設 secret 會讓前端渲染不出元件、後端卻要求 token —— 每次登入必定 403
   「challenge required」,而且沒有任何自救路徑(實測踩過)。
   少了 site key 時挑戰本來就無法運作,關掉不是安全降級,是避免 100% 斷線。 */
const turnstileOn = (env: Env) => !!(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY);

const quotaStub = (env: Env, email: string) => env.QUOTA.get(env.QUOTA.idFromName(email));
const readUsage = async (env: Env, email: string): Promise<Usage> =>
  (await quotaStub(env, email).fetch('https://do/usage')).json<Usage>();

/** 全站計數共用同一顆 DO;'__global__' 不含 @,不會與任何 email 撞名 */
const GLOBAL = '__global__';

/* 錢包保險絲:張數(分級)+ 每人每日 TWD + 全站每日 TWD 三道門檻。
   P1、P2 都要過(P2 曾是唯一沒有上限的付費入口)。
   已知 race:read-then-act + waitUntil 事後入帳,併發下可微幅超額——
   量級是「多一兩張圖」不是「多一個量級」,接受;要嚴格就把檢查搬進 DO。 */
async function checkBudgets(env: Env, email: string, user: UserInfo, countImage: boolean): Promise<Response | null> {
  const [mine, site] = await Promise.all([
    readUsage(env, email).catch(() => null),
    readUsage(env, GLOBAL).catch(() => null),
  ]);
  if (countImage && mine && user.limitImages > 0 && mine.count >= user.limitImages) {
    return bad(`今日額度已用完(${mine.count}/${user.limitImages} 張),台灣時間早上 8 點重置`, 429);
  }
  const twdLimit = Number(env.DAILY_TWD_LIMIT || 0);
  if (mine && twdLimit > 0 && mine.costTwd >= twdLimit) {
    return bad(`今日成本額度已用完(約 NT$${mine.costTwd.toFixed(1)}),台灣時間早上 8 點重置`, 429);
  }
  const siteLimit = Number(env.GLOBAL_DAILY_TWD || 0);
  if (site && siteLimit > 0 && site.costTwd >= siteLimit) {
    return bad('今日全站預算已用完,明天再來(台灣時間早上 8 點重置)', 429);
  }
  return null;
}

/** 用量入帳:個人與全站各記一筆(waitUntil,不擋回應) */
function recordUsage(
  ctx: ExecutionContext,
  env: Env,
  email: string,
  add: { images: number; inTok: number; outTok: number; costTwd: number },
) {
  const body = JSON.stringify(add);
  for (const key of [email, GLOBAL]) {
    ctx.waitUntil(quotaStub(env, key).fetch('https://do/add', { method: 'POST', body }));
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (err) {
      // 登入流程的例外要導回登入頁(手機上停在裸 500 等於死路),其餘回 JSON
      console.error('[fetch]', err);
      if (new URL(req.url).pathname.startsWith('/auth/')) {
        return new Response(null, { status: 302, headers: { location: '/?err=auth' } });
      }
      return bad('伺服器錯誤', 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    if (env.TURNSTILE_SECRET && !env.TURNSTILE_SITE_KEY) {
      console.warn('[turnstile] 設了 TURNSTILE_SECRET 但沒設 TURNSTILE_SITE_KEY,已停用挑戰');
    }
    return json({
      mode: env.GOOGLE_CLIENT_ID ? 'oidc' : 'dev',
      turnstileSiteKey: turnstileOn(env) ? env.TURNSTILE_SITE_KEY : null,
      defaultModelMode: resolveMode(env),
      allowModeToggle: modeToggleEnabled(env),
    });
  }

  /* ---------- OAuth(仿 manemu §5.6) ---------- */
  if (p === '/auth/login') {
    if (!env.GOOGLE_CLIENT_ID) return bad('尚未設定 Google OIDC,開發模式請用 Email 登入', 404);
    // Turnstile:site key + secret 都設好才強制驗(POST + token);否則直通。
    // 驗證失敗一律導回登入頁帶 err,讓使用者看得到訊息也能重試——
    // 不要回裸 403 文字頁,手機上等於死路(實測回報)。
    if (turnstileOn(env)) {
      if (req.method !== 'POST') return new Response(null, { status: 302, headers: { location: '/' } });
      if (!sameOrigin(req)) return new Response('forbidden', { status: 403 });
      // 表單解析失敗(空 body / 非表單 content-type)不該變成裸 500
      const form = await req.formData().catch(() => null);
      const token = form?.get('cf-turnstile-response');
      if (!token) return new Response(null, { status: 302, headers: { location: '/?err=challenge' } });
      const vr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET!,
          response: String(token),
          remoteip: req.headers.get('cf-connecting-ip') || '',
        }),
      });
      if (!((await vr.json()) as { success: boolean }).success) {
        return new Response(null, { status: 302, headers: { location: '/?err=challenge' } });
      }
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
}

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
    const { image, mime, name, modelMode, iw, ih } = (await req.json().catch(() => ({}))) as {
      image?: string;
      mime?: string;
      name?: string;
      modelMode?: string;
      /** 上傳影像的像素尺寸:座標規格防呆(像素→百分比)要用 */
      iw?: number;
      ih?: number;
    };
    if (!image || !mime?.startsWith('image/')) return bad('缺少影像資料');
    if (image.length > MAX_IMAGE_B64) return bad('影像過大,請縮小後再試', 413);

    const denied = await checkBudgets(env, email, user, true);
    if (denied) return denied;

    const { lang, blocks, usage, model, mode } = await runP1(
      env, image, mime, resolveMode(env, modelMode),
      Number(iw) || undefined, Number(ih) || undefined,
    );
    const twd = estCostTwd(env, model, usage);
    // 成功才計費(失敗不扣額度)
    recordUsage(ctx, env, email, { images: 1, ...usage, costTwd: twd });
    return json({ ok: true, result: { name: name || 'photo', lang, blocks }, usage: { ...usage, twd, model, mode } });
  }

  if (path === '/api/p2' && req.method === 'POST') {
    const { lang, blocks, modelMode } = (await req.json().catch(() => ({}))) as {
      lang?: string;
      blocks?: { en: string; zh: string }[];
      modelMode?: string;
    };
    if (!Array.isArray(blocks) || !blocks.length) return bad('缺少文字塊');
    if (blocks.length > 200) return bad('文字塊過多', 413);
    // P2 也是付費入口,同一組保險絲(不含張數——張數在 P1 已扣)
    const denied = await checkBudgets(env, email, user, false);
    if (denied) return denied;
    const { edits, usage, model, mode } = await runP2(env, lang || '??', blocks, resolveMode(env, modelMode));
    const twd = estCostTwd(env, model, usage);
    recordUsage(ctx, env, email, { images: 0, ...usage, costTwd: twd });
    return json({ ok: true, edits, usage: { ...usage, twd, model, mode } });
  }

  return bad('不存在的 API', 404);
}
