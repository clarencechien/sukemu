/** 資料契約(handoff §6)——欄位名不可改,前後端共用這個形狀。 */

export type Block = {
  /** 正規化 %,相對原圖 natural size */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 字級,單位 u(u = 圖片顯示寬度 / 100) */
  fs: number;
  /** 版面信心 0–1,< 0.9 前端標「待複核」 */
  c: number;
  /** 原文(欄位名沿用,實際是來源語言) */
  en: string;
  /** 譯文 */
  zh: string;
  /** 譯註,P2 產出,可無 */
  nt?: string;
  /** 直排文字(直書),前端以 writing-mode: vertical-rl 呈現。契約新增的選用欄位 */
  v?: boolean;
};

export type Result = {
  name: string;
  lang: string;
  blocks: Block[];
};

/** 版面信心門檻:低於此值標「待複核」 */
export const LOW_CONFIDENCE = 0.9;

export type Mode = 'overlay' | 'note' | 'dot' | 'off';
export type Filter = 'all' | 'nt' | 'low';
