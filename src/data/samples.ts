import type { Result } from '../types';

/** M1 假資料:座標與譯文沿用原型手工標註,圖片放 public/samples/。 */

export type Sample = {
  src: string;
  result: Result;
};

export const SAMPLES: Sample[] = [
  {
    src: '/samples/defining-the-harness.webp',
    result: {
      name: 'defining-the-harness.webp',
      lang: 'EN',
      blocks: [
        { x: 31.8, y: 5.2, w: 37.6, h: 7.6, fs: 3.4, c: 0.99, en: 'Defining the Harness', zh: '什麼是掛載系統(Harness)?', nt: 'Harness 業界多直接沿用英文;亦見「執行框架」「掛載層」。首次出現保留原文。' },
        { x: 9.6, y: 21.0, w: 18.0, h: 29.0, fs: 1.68, c: 0.98, en: 'The Harness: The engineered runtime that wraps a large language model and converts its raw text output into reliable system behavior.', zh: '掛載系統(Harness):包裹大型語言模型的工程化執行環境,負責把模型原始的文字輸出,轉換成可靠的系統行為。' },
        { x: 9.6, y: 54.4, w: 18.0, h: 35.0, fs: 1.68, c: 0.98, en: 'Harness engineering is the discipline of treating the runtime as a first-class engineering artifact, much like SRE treats production infrastructure as code.', zh: '掛載系統工程:把執行環境視為一級工程產物的學科,就像 SRE 把生產環境的基礎設施視為程式碼一樣。', nt: 'SRE = Site Reliability Engineering,以軟體工程方法處理維運問題的學科。' },
        { x: 38.4, y: 25.8, w: 12.2, h: 5.2, fs: 2.9, c: 0.99, en: 'The Model', zh: '模型', nt: '專指 LLM 權重本身。圖中以獅頭砲管隱喻:威力大但無從瞄準。' },
        { x: 69.3, y: 19.8, w: 8.8, h: 5.8, fs: 1.5, c: 0.86, en: 'Protective Peaked Roof', zh: '保護性尖屋頂', nt: '對應安全過濾與內容防護層。' },
        { x: 78.8, y: 24.3, w: 13.8, h: 5.2, fs: 2.9, c: 0.99, en: 'The Harness', zh: '掛載系統' },
        { x: 84.9, y: 37.2, w: 6.6, h: 8.4, fs: 1.5, c: 0.84, en: 'Swinging Tension Ropes', zh: '擺動張力繩', nt: '對應執行期控制:重試、逾時、退避、熔斷。' },
        { x: 86.4, y: 57.2, w: 7.6, h: 8.6, fs: 1.5, c: 0.81, en: 'Brass Calibration Handles', zh: '黃銅校準把手', nt: '對應行為微調:prompt 調整、參數、few-shot 範例。' },
        { x: 33.3, y: 81.8, w: 7.2, h: 8.4, fs: 1.5, c: 0.83, en: 'Reinforced Wooden Wheels', zh: '加強型木輪', nt: '對應系統部署與可移動性。' },
        { x: 55.3, y: 88.2, w: 11.8, h: 4.8, fs: 2.5, c: 0.99, en: 'The Harness', zh: '掛載系統' },
      ],
    },
  },
  {
    src: '/samples/the-model-is-not-the-hard-part.webp',
    result: {
      name: 'the-model-is-not-the-hard-part.webp',
      lang: 'EN',
      blocks: [
        { x: 15.4, y: 2.8, w: 65.6, h: 4.6, fs: 3.0, c: 0.99, en: "The model is not the hard part. It hasn't been for a while.", zh: '模型本身早就不是最難的部分了。' },
        { x: 14.0, y: 68.2, w: 20.2, h: 7.8, fs: 2.1, c: 0.97, en: 'The Dev Environment: The demo works.', zh: '開發環境:展示一切正常。', nt: '圖中以「對著木樁練劍」隱喻:對手不會還手,招式當然順。' },
        { x: 53.3, y: 68.2, w: 38.4, h: 7.8, fs: 2.1, c: 0.95, en: 'The Production Environment: Six weeks later, unable to reproduce the failure.', zh: '生產環境:六週後,故障重現不出來。', nt: 'unable to reproduce the failure 指的是無法重現故障,而非修不好。' },
        { x: 19.4, y: 82.3, w: 59.8, h: 10.2, fs: 1.95, c: 0.96, en: 'We had long-running workflows before the literature named them. The frustrating part is that stakeholders could not see why the scaffolding mattered. It works in dev. But in production, we hit walls.', zh: '在文獻替它命名之前,我們早就在跑長時間運行的工作流了。令人洩氣的是,利害關係人看不出周圍那些鷹架為什麼重要——在開發環境會動,到了生產環境就處處碰壁。', nt: 'scaffolding 譯「鷹架」為台灣慣用語,大陸多作「腳手架」。hit walls 一語雙關,呼應圖中城牆。' },
      ],
    },
  },
];
