/* 每人一個 Durable Object 計今日用量(handoff §4 錢包保險絲,仿 manemu RelaySession.usage)。
   記三件事:張數(配額依據)、token 數、估算成本 TWD(admin 頁與 /api/me 顯示)。
   重置:UTC 00:00 = 台灣早上 08:00。額度上限由 Worker 依分級傳入,DO 只計數。 */

export type Usage = { day: string; count: number; inTok: number; outTok: number; costTwd: number };

export class QuotaCounter {
  constructor(private state: DurableObjectState) {}

  private async today(): Promise<Usage> {
    const day = new Date().toISOString().slice(0, 10);
    const rec = await this.state.storage.get<Usage>('usage');
    return rec?.day === day ? rec : { day, count: 0, inTok: 0, outTok: 0, costTwd: 0 };
  }

  /* 進行中但還沒結算的預扣。只存在記憶體:DO 被回收代表沒有請求在跑,一起消失是對的。
     ⚠️ 這是 2026-09-04 的修正重點。原本 Worker 是 read → 呼叫 Gemini(精準模式單張約
     13 秒)→ 事後 waitUntil 入帳,DO 只負責計數。競態窗口是**整段 Gemini 延遲**,
     所以並行 N 個請求全都讀到同一個舊值 —— 額度是 N 倍,不是原本註解說的「多一兩張」。
     現在改成在 DO 裡「檢查 + 預扣」一次做完(DO 單執行緒,天然序列化)。 */
  private pending = new Map<string, { images: number; twd: number; at: number }>();

  /** 卡住的預扣不能永遠佔著額度:超過這個時間就當它死了(Gemini 上限遠低於此) */
  private static PENDING_TTL_MS = 120_000;

  private prune() {
    const dead = Date.now() - QuotaCounter.PENDING_TTL_MS;
    for (const [id, p] of this.pending) if (p.at < dead) this.pending.delete(id);
  }

  /** 已入帳 + 進行中預扣 */
  private projected(cur: Usage) {
    let images = 0, twd = 0;
    for (const p of this.pending.values()) { images += p.images; twd += p.twd; }
    return { count: cur.count + images, costTwd: cur.costTwd + twd, inflight: this.pending.size };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const cur = await this.today();
    if (url.pathname === '/usage') return Response.json(cur);

    if (url.pathname === '/reserve' && req.method === 'POST') {
      const { images = 0, estTwd = 0, limitImages = 0, twdLimit = 0, maxInflight = 0 } =
        (await req.json()) as Record<string, number>;
      this.prune();
      const proj = this.projected(cur);
      if (maxInflight > 0 && proj.inflight >= maxInflight) {
        return Response.json({ ok: false, reason: 'inflight', inflight: proj.inflight });
      }
      if (limitImages > 0 && proj.count + images > limitImages) {
        return Response.json({ ok: false, reason: 'images', used: proj.count, limit: limitImages });
      }
      if (twdLimit > 0 && proj.costTwd + estTwd > twdLimit) {
        return Response.json({ ok: false, reason: 'twd', used: proj.costTwd, limit: twdLimit });
      }
      const id = crypto.randomUUID();
      this.pending.set(id, { images, twd: estTwd, at: Date.now() });
      return Response.json({ ok: true, id });
    }

    // 結算:把預扣換成實際用量。id 找不到(例如 DO 中途重啟)也照樣入帳 —— 寧可多記
    if (url.pathname === '/settle' && req.method === 'POST') {
      const { id, images = 0, inTok = 0, outTok = 0, costTwd = 0 } =
        (await req.json()) as Partial<Usage> & { id?: string; images?: number };
      if (id) this.pending.delete(id);
      const next: Usage = {
        day: cur.day,
        count: cur.count + images,
        inTok: cur.inTok + inTok,
        outTok: cur.outTok + outTok,
        costTwd: +(cur.costTwd + costTwd).toFixed(4),
      };
      await this.state.storage.put('usage', next);
      return Response.json(next);
    }

    // 失敗:放掉預扣,不入帳(維持「失敗不扣額度」的既有行為)
    if (url.pathname === '/release' && req.method === 'POST') {
      const { id } = (await req.json()) as { id?: string };
      if (id) this.pending.delete(id);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/add' && req.method === 'POST') {
      const { images = 0, inTok = 0, outTok = 0, costTwd = 0 } = (await req.json()) as Partial<Usage> & {
        images?: number;
      };
      const next: Usage = {
        day: cur.day,
        count: cur.count + images,
        inTok: cur.inTok + inTok,
        outTok: cur.outTok + outTok,
        costTwd: +(cur.costTwd + costTwd).toFixed(4),
      };
      await this.state.storage.put('usage', next);
      return Response.json(next);
    }
    return new Response('not found', { status: 404 });
  }
}
