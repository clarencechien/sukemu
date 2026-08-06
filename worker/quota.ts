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

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const cur = await this.today();
    if (url.pathname === '/usage') return Response.json(cur);
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
