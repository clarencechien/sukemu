import type { Block, Filter, Mode, Result } from '../types';
import { LOW_CONFIDENCE } from '../types';
import { SAMPLES, type Sample } from '../data/samples';
import type { P2Edit } from '../api';

export type Viewer = {
  /** 新增一份文件(上傳結果)並切過去顯示 */
  addDoc(doc: Sample): void;
  /** 套用 P2 修訂;若該文件正在顯示則就地更新畫面 */
  applyEdits(result: Result, edits: P2Edit[]): void;
};

/* App 畫面:自原型移植的疊層譯讀器。
   互動規格(照抄原型,不要改):
   - 圖片尺寸由 JS 算好寫入 style.width,--u = 顯示寬度/100
   - C 註解選取項用 order:-1 + sticky,不用 scrollIntoView
   - 按住看原圖:按鈕、長按圖片、按住 O 三種入口 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initViewer(onEdit?: (result: Result) => void): Viewer {
  const stage = $('stage');
  const plate = $<HTMLImageElement>('plate');
  const acetate = $('acetate');
  const insp = $('insp');
  const hold = $('hold');
  const notes = $('notes');
  const ncount = $('ncount');
  const langs = $('langs');

  const docs: Sample[] = [...SAMPLES];
  let docIdx = 0;
  let cur = -1;
  let noteEls: HTMLElement[] = [];
  let pins: HTMLElement[] = [];
  let zoom = 1;
  /** 長按看原圖的計時器;捏合縮放要能取消它,所以宣告在共用範圍 */
  let holdTimer: ReturnType<typeof setTimeout>;

  const mode = () => (document.body.dataset.mode ?? 'overlay') as Mode;
  const inApp = () => document.body.dataset.screen === 'app';
  const isLow = (b: Block) => b.c < LOW_CONFIDENCE;

  function render() {
    const { src, result } = docs[docIdx];
    plate.src = src;
    plate.alt = result.name;
    langs.innerHTML = `${result.lang} → <b>正體中文</b>`;
    acetate.innerHTML = '';
    notes.innerHTML = '';
    noteEls = [];
    pins = [];

    result.blocks.forEach((b, i) => {
      const el = document.createElement('div');
      el.className = b.v ? 'blk vert' : 'blk';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.dataset.low = String(isLow(b));
      el.setAttribute('aria-label', `標註 ${i + 1}:${b.zh}`);
      el.style.cssText = `left:${b.x}%;top:${b.y}%;width:${b.w}%;height:${b.h}%`;
      el.innerHTML =
        `<div class="veil"></div><div class="txt" style="font-size:calc(var(--u)*${b.fs})"></div>` +
        ['tl', 'tr', 'bl', 'br'].map(c => `<span class="corner c-${c}"><i></i><i></i></span>`).join('');
      (el.querySelector('.txt') as HTMLElement).textContent = b.zh;
      el.onclick = () => select(i, 'img');
      el.onfocus = () => select(i, 'img');
      acetate.appendChild(el);

      const pin = document.createElement('div');
      pin.className = 'pin';
      pin.style.left = `${b.x + b.w / 2}%`;
      pin.style.top = `${b.y + b.h / 2}%`;
      pin.innerHTML = `<b>${i + 1}</b>`;
      acetate.appendChild(pin);
      pins.push(pin);

      const n = document.createElement('div');
      n.className = 'note';
      n.tabIndex = 0;
      n.setAttribute('role', 'button');
      n.dataset.nt = String(!!b.nt);
      n.dataset.low = String(isLow(b));
      n.innerHTML = `<div class="n">${String(i + 1).padStart(2, '0')}</div><div>
        <div class="z"></div><div class="e"></div>
        ${b.nt ? '<div class="nt"></div>' : ''}
        ${isLow(b) ? `<div class="flag">▲ 版面信心 ${b.c.toFixed(2)} · 建議複核</div>` : ''}</div>`;
      (n.querySelector('.z') as HTMLElement).textContent = b.zh;
      (n.querySelector('.e') as HTMLElement).textContent = b.en;
      if (b.nt) (n.querySelector('.nt') as HTMLElement).textContent = b.nt;
      n.onclick = () => select(i, 'note');
      n.onfocus = () => select(i, 'note');
      notes.appendChild(n);
      noteEls.push(n);
    });

    cur = -1;
    paint();
    countNotes();
    fit();
  }

  function select(i: number, from: 'img' | 'note') {
    cur = i;
    paint();
    // 選取項靠 flex order 頂到最上,不捲動畫面;只把捲軸歸零確保看得到
    if (mode() === 'note' && from === 'img') notes.scrollTop = 0;
  }

  function setFilter(f: Filter) {
    document.querySelectorAll<HTMLButtonElement>('.filters button')
      .forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === f)));
    document.body.dataset.filter = f;
    countNotes();
  }

  function countNotes() {
    const { blocks } = docs[docIdx].result;
    const f = (document.body.dataset.filter ?? 'all') as Filter;
    const n = blocks.filter(b => (f === 'nt' ? b.nt : f === 'low' ? isLow(b) : true)).length;
    ncount.textContent = f === 'all' ? `${n} 則標註` : `${n} / ${blocks.length} 則`;
  }

  function paint() {
    const { blocks } = docs[docIdx].result;
    [...acetate.querySelectorAll('.blk')].forEach((el, i) => el.setAttribute('aria-current', String(i === cur)));
    pins.forEach((pin, i) => (pin.dataset.on = String(i === cur)));
    noteEls.forEach((n, i) => n.setAttribute('aria-current', String(i === cur)));
    if (cur < 0) {
      insp.innerHTML = '<div class="empty">點選圖上的標註或下方註解 — 譯文可直接編輯。按 X 在 A(疊字)與 C(註解)之間切換</div>';
      return;
    }
    const b = blocks[cur];
    const low = isLow(b);
    insp.innerHTML = `<div class="row"><span class="tag">原文</span><div class="src"></div></div>
      <div class="row"><span class="tag">譯文</span><div class="tgt" contenteditable="true" spellcheck="false" id="edit"></div></div>
      <div class="meta"><span class="conf ${low ? 'low' : ''}"><i></i>版面信心 <b>${b.c.toFixed(2)}</b>${low ? ' · 建議複核' : ''}</span>
      <span>座標 <b>${b.x.toFixed(1)}, ${b.y.toFixed(1)}</b> · 尺寸 <b>${b.w.toFixed(1)} × ${b.h.toFixed(1)}</b>%</span>
      <span>譯註 <b>${b.nt ? '有' : '—'}</b></span><span>標註 <b>${cur + 1} / ${blocks.length}</b></span></div>`;
    (insp.querySelector('.src') as HTMLElement).textContent = b.en;
    const ed = $('edit');
    ed.textContent = b.zh;
    ed.oninput = () => {
      b.zh = ed.textContent ?? '';
      (acetate.querySelectorAll('.blk')[cur].querySelector('.txt') as HTMLElement).textContent = b.zh;
      (noteEls[cur].querySelector('.z') as HTMLElement).textContent = b.zh;
      onEdit?.(docs[docIdx].result);
    };
  }

  // C 註解在寬螢幕(含橫向手機)改「圖左・註解右」並排,圖用滿高度
  const noteRow = matchMedia('(min-aspect-ratio: 13/9)');
  function fit() {
    if (!plate.naturalWidth) return;
    const cs = getComputedStyle(stage);
    const r = stage.getBoundingClientRect();
    let availW = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let availH = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (mode() === 'note') {
      if (noteRow.matches) availW *= 0.5;
      else availH *= 0.45;
    }
    const ar = plate.naturalWidth / plate.naturalHeight;
    const w = Math.max(140, Math.min(availW, availH * ar) * zoom);
    plate.style.width = w + 'px';
    document.documentElement.style.setProperty('--u', w / 100 + 'px');
  }
  plate.addEventListener('load', fit);
  new ResizeObserver(fit).observe(stage);
  noteRow.addEventListener('change', fit);

  function setMode(m: Mode) {
    document.querySelectorAll<HTMLButtonElement>('.seg button')
      .forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    document.body.dataset.mode = m;
    requestAnimationFrame(fit);
  }
  document.querySelectorAll<HTMLButtonElement>('.seg button')
    .forEach(btn => (btn.onclick = () => setMode(btn.dataset.mode as Mode)));
  document.querySelectorAll<HTMLButtonElement>('.filters button')
    .forEach(btn => (btn.onclick = () => setFilter(btn.dataset.filter as Filter)));
  setMode('overlay');
  setFilter('all');
  $('flip').onclick = () => setMode(mode() === 'note' ? 'overlay' : 'note');
  $('swap').onclick = () => {
    docIdx = (docIdx + 1) % docs.length;
    render();
  };

  const zoomEl = $<HTMLInputElement>('zoom');
  const zoomv = $('zoomv');
  const setZoom = (z: number) => {
    zoom = z;
    zoomEl.value = String(Math.round(z * 100));
    zoomv.textContent = Math.round(z * 100) + '%';
    fit();
  };
  zoomEl.oninput = () => setZoom(Number(zoomEl.value) / 100);

  /* 觸控縮放:雙指捏合 + 雙擊(桌面另有滑桿與同一組上下限)。
     .frame 的 touch-action 設 pan-x pan-y——單指維持瀏覽器原生捲動 stage(放大後平移用),
     雙指的預設縮放則交給這裡接管。放大後 stage 可捲動,見 body:not([data-mode=note]) .stage。 */
  const frame = $('frame');
  const zMin = Number(zoomEl.min) / 100;
  const zMax = Number(zoomEl.max) / 100;
  const clampZoom = (z: number) => Math.min(zMax, Math.max(zMin, z));
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; zoom: number } | null = null;
  let pinchEndedAt = 0;
  let lastTap = 0;
  let tapX = 0;
  let tapY = 0;
  const spread = () => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  frame.addEventListener('pointerdown', e => {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tapX = e.clientX;
    tapY = e.clientY;
    if (touches.size === 2) {
      pinch = { dist: spread(), zoom };
      clearTimeout(holdTimer); // 雙指是縮放,不是長按看原圖
    }
  });
  frame.addEventListener('pointermove', e => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2 && pinch.dist > 0) {
      setZoom(clampZoom(pinch.zoom * (spread() / pinch.dist)));
    }
  });
  (['pointerup', 'pointercancel'] as const).forEach(t =>
    frame.addEventListener(t, e => {
      touches.delete(e.pointerId);
      if (pinch && touches.size < 2) {
        pinch = null;
        pinchEndedAt = Date.now(); // 捏合收尾的抬指不該被當成點擊
      }
    }),
  );
  frame.addEventListener('pointerup', e => {
    if (touches.size || Date.now() - pinchEndedAt < 400) return;
    if (Math.hypot(e.clientX - tapX, e.clientY - tapY) > 10) return;
    const now = Date.now();
    if (now - lastTap < 300) {
      setZoom(zoom > 1 ? 1 : 2);
      lastTap = 0;
    } else {
      lastTap = now;
    }
  });
  const veil = $<HTMLInputElement>('veil');
  const veilv = $('veilv');
  veil.oninput = () => {
    const v = Number(veil.value) / 100;
    document.documentElement.style.setProperty('--veil', String(v));
    veilv.textContent = v.toFixed(2).slice(1);
  };

  const lift = (on: boolean) => document.body.classList.toggle('lifted', on);
  hold.addEventListener('pointerdown', e => {
    e.preventDefault();
    hold.setPointerCapture(e.pointerId);
    lift(true);
  });
  (['pointerup', 'pointercancel'] as const).forEach(t => hold.addEventListener(t, () => lift(false)));
  hold.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      lift(true);
    }
  });
  hold.addEventListener('keyup', e => {
    if (e.key === ' ' || e.key === 'Enter') lift(false);
  });
  addEventListener('keydown', e => {
    if (!inApp() || (e.target as HTMLElement).isContentEditable) return;
    if ((e.key === 'o' || e.key === 'O') && !e.repeat) lift(true);
    if (e.key === 'x' || e.key === 'X') setMode(mode() === 'note' ? 'overlay' : 'note');
    const m = ({ 1: 'overlay', 2: 'note', 3: 'dot', 4: 'off' } as Record<string, Mode>)[e.key];
    if (m) setMode(m);
  });
  addEventListener('keyup', e => {
    if (e.key === 'o' || e.key === 'O') lift(false);
  });
  let holdX = 0;
  let holdY = 0;
  acetate.addEventListener('pointerdown', e => {
    holdX = e.clientX;
    holdY = e.clientY;
    // 先清掉前一根手指的計時器再重設:否則第二指只是覆寫了變數,
    // 第一指的計時器成為孤兒繼續跑,捏合縮放到一半會誤觸「看原圖」
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => lift(true), 450);
  });
  // 手指移動(捲動)就取消長按,避免捲動時誤觸「看原圖」
  acetate.addEventListener('pointermove', e => {
    if (Math.hypot(e.clientX - holdX, e.clientY - holdY) > 8) clearTimeout(holdTimer);
  });
  (['pointerup', 'pointercancel'] as const).forEach(t =>
    addEventListener(t, () => {
      clearTimeout(holdTimer);
      lift(false);
    }),
  );

  render();

  return {
    addDoc(doc) {
      docs.push(doc);
      docIdx = docs.length - 1;
      render();
    },
    applyEdits(result, edits) {
      edits.forEach(e => {
        const b = result.blocks[e.i];
        if (!b) return;
        if (e.zh) b.zh = e.zh;
        if (e.nt) b.nt = e.nt;
      });
      if (docs[docIdx].result === result) {
        const keep = cur;
        render();
        cur = keep;
        paint();
      }
    },
  };
}
