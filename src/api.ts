import type { Block, Result } from './types';

/** P2 修訂:i 為 blocks 索引 */
export type P2Edit = { i: number; zh?: string; nt?: string };
export type ApiUsage = { inTok: number; outTok: number; twd: number };
export type Me = {
  email: string;
  tier: string;
  isAdmin: boolean;
  usedImages: number;
  limitImages: number;
  todayTwd: number;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public waitlist = false,
  ) {
    super(message);
  }
}

async function req(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, !!data.waitlist);
  }
  return data;
}

const post = (path: string, body: unknown) =>
  req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const api = {
  config: (): Promise<{ mode: 'oidc' | 'dev'; turnstileSiteKey: string | null }> => req('/api/config'),
  me: (): Promise<Me> => req('/api/me'),
  login: (email: string): Promise<{ email: string }> => post('/api/login', { email }),
  logout: (): Promise<void> => post('/api/logout', {}),
  p1: (image: string, mime: string, name: string): Promise<{ result: Result; usage?: ApiUsage }> =>
    post('/api/p1', { image, mime, name }),
  p2: (lang: string, blocks: Block[]): Promise<{ edits: P2Edit[]; usage?: ApiUsage }> =>
    post('/api/p2', { lang, blocks: blocks.map(({ en, zh }) => ({ en, zh })) }),
};
