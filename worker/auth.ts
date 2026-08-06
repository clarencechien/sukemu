/* 白名單認證(M1 寫死版)。
   M4 換成 Google OIDC + Turnstile;白名單機制保留,只換掉「email 怎麼來」。
   白名單放 R2:config/allowlist.json(JSON 字串陣列)。
   物件不存在時自動用預設名單建立,開發者之後直接改 R2 物件即可。 */

import type { Env } from './index';

const DEFAULT_ALLOWLIST = ['clarence.chien@gmail.com'];
const ALLOWLIST_KEY = 'config/allowlist.json';
const WAITLIST_KEY = 'config/waitlist.json';
const COOKIE = 'sukemu_auth';

let cache: { list: string[]; at: number } | null = null;

export async function allowlist(env: Env): Promise<string[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.list;
  let list = DEFAULT_ALLOWLIST;
  try {
    const obj = await env.R2.get(ALLOWLIST_KEY);
    if (obj) {
      list = (await obj.json<string[]>()).map(e => e.trim().toLowerCase());
    } else {
      await env.R2.put(ALLOWLIST_KEY, JSON.stringify(DEFAULT_ALLOWLIST, null, 2), {
        httpMetadata: { contentType: 'application/json' },
      });
    }
  } catch {
    // R2 讀不到時退回預設名單,不擋開發者
  }
  cache = { list, at: Date.now() };
  return list;
}

/** 不在名單的登入自動記到等候名單(與 manemu 同機制)。 */
export async function addToWaitlist(env: Env, email: string) {
  try {
    const obj = await env.R2.get(WAITLIST_KEY);
    const list: { email: string; at: string }[] = obj ? await obj.json() : [];
    if (!list.some(e => e.email === email)) {
      list.push({ email, at: new Date().toISOString() });
      await env.R2.put(WAITLIST_KEY, JSON.stringify(list, null, 2), {
        httpMetadata: { contentType: 'application/json' },
      });
    }
  } catch {
    // 等候名單寫失敗不影響回應
  }
}

export function cookieEmail(req: Request): string | null {
  const raw = req.headers.get('Cookie') ?? '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]).trim().toLowerCase() : null;
}

export function authCookie(email: string, clear = false): string {
  const value = clear ? '' : encodeURIComponent(email);
  const maxAge = clear ? 0 : 60 * 60 * 24 * 30;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** 通過回傳 email,否則回傳 401 Response。 */
export async function requireUser(req: Request, env: Env): Promise<string | Response> {
  const email = cookieEmail(req);
  if (email && (await allowlist(env)).includes(email)) return email;
  return Response.json({ ok: false, error: '請先登入' }, { status: 401 });
}
