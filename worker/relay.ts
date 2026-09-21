import type { Env } from './index';

/* Gemini 的「出口地區」代打。
   Cloudflare Worker 的 subrequest 是從**使用者連到的那個 colo** 出去的,而台灣的
   流量常被導去香港 —— Gemini 不支援香港,會回 400「User location is not supported」。
   關鍵:同一次呼叫裡重試沒有用,因為還是同一個 colo 出去。之所以「重試常常就好了」,
   是因為使用者下一次請求可能落到別的 colo,那是運氣不是修復。
   所以把這一發交給釘在支援地區的 Durable Object 送出去 —— DO 不存任何狀態,
   純粹是一個位置確定的出口。地區由 idFromName 的名字綁定(locationHint 只在
   物件第一次建立時生效,所以名字裡一定要帶地區,不同地區才會是不同物件)。 */
export class GeminiRelay {
  private env: Env;
  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const { model, payload } = (await req.json().catch(() => ({}))) as {
      model?: string;
      payload?: string;
    };
    // model 來自我們自己的 var,不是使用者輸入;還是擋一下,免得哪天變成路徑注入
    if (!model || !/^[\w.-]+$/.test(model) || !payload) {
      return new Response('bad relay request', { status: 400 });
    }
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.env.GEMINI_API_KEY },
      body: payload,
    });
  }
}
