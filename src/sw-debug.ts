// Диагностика жизненного цикла service worker — для отладки авто-обновления PWA
// на iOS (standalone), где обновление не подхватывается. Включается флагом
// `?swdebug` в URL и сохраняется в localStorage, чтобы пережить (1) запуск с
// домашнего экрана, где query-строки нет (start_url = '.'), и (2) авто-
// перезагрузку по `controllerchange` в режиме autoUpdate, которая стирает
// JS-состояние — а нам важно увидеть, ЧТО было ДО перезагрузки.
//
// Это ТОЛЬКО наблюдение: поведение обновления не меняется (фиксы — фазы 2/3).
// По умолчанию выключено — оверлея в проде нет, накладных расходов нет.
//
// Remote-инспекция подвешенного standalone-PWA с макбука ненадёжна, поэтому лог
// показываем прямо на экране, с кнопкой «copy» — чтобы можно было прислать текст.

const FLAG_KEY = 'pr-swdebug';
const LOG_KEY = 'pr-swdebug-log';
const LOG_CAP = 200;

interface LogEntry {
  t: number; // epoch-мс
  msg: string;
}

/** Публичный контракт для `pwa.ts`. Когда `enabled === false` — всё no-op. */
export interface SwDebug {
  readonly enabled: boolean;
  /** Записать строку в лог (с меткой времени). No-op, если отладка выключена. */
  log(msg: string): void;
  /** Навесить логирование `updatefound`/`statechange` и обновить строку состояния. */
  attachRegistration(reg: ServiceWorkerRegistration): void;
}

const NOOP: SwDebug = {
  enabled: false,
  log() {},
  attachRegistration() {},
};

/** Активна ли отладка. Побочно синхронизирует сохранённый флаг по URL:
 *  `?swdebug`/`?swdebug=1` — включить (запомнить), `?swdebug=0` — выключить. */
function resolveEnabled(): boolean {
  let flag = false;
  try {
    flag = localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    // localStorage недоступен (приватный режим) — ориентируемся только на URL
  }
  const params = new URLSearchParams(location.search);
  if (params.has('swdebug')) {
    const v = params.get('swdebug');
    flag = v !== '0' && v !== 'false';
    try {
      if (flag) localStorage.setItem(FLAG_KEY, '1');
      else localStorage.removeItem(FLAG_KEY);
    } catch {
      // пропускаем — не критично
    }
  }
  return flag;
}

/** Переключить сохранённый флаг отладки и вернуть новое состояние. Нужно для
 *  активации ИЗНУТРИ приложения: у standalone-PWA на iOS отдельная банка
 *  localStorage (флаг `?swdebug`, выставленный в Safari, туда не попадает), а
 *  адресной строки нет — задать query-параметр негде. Вызывающий перезагружает
 *  страницу, чтобы `initSwDebug()` увидел флаг и построил оверлей. */
export function toggleSwDebug(): boolean {
  let on = false;
  try {
    on = localStorage.getItem(FLAG_KEY) !== '1';
    if (on) localStorage.setItem(FLAG_KEY, '1');
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    // localStorage недоступен — переключить нельзя
  }
  return on;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** Настенное время `ЧЧ:ММ:СС.ммм` — чтобы «только что» совпадало с часами телефона. */
function fmtTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function fmtDateTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readLog(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as LogEntry[]) : [];
  } catch {
    return [];
  }
}

function writeLog(entries: LogEntry[]): void {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(entries));
  } catch {
    // переполнение квоты / приватный режим — молча пропускаем
  }
}

const CSS = `
.swdbg {
  position: fixed;
  z-index: 2147483000;
  left: 0;
  bottom: 0;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #d8f0e2;
  -webkit-user-select: text;
  user-select: text;
}
.swdbg__badge {
  position: fixed;
  left: calc(6px + env(safe-area-inset-left));
  bottom: calc(6px + env(safe-area-inset-bottom));
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: rgba(10, 20, 16, 0.82);
  color: #46d39a;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
.swdbg__panel {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 42vh;
  display: flex;
  flex-direction: column;
  background: rgba(10, 20, 16, 0.92);
  border-top: 1px solid rgba(70, 211, 154, 0.4);
  padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
}
.swdbg__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 4px;
}
.swdbg__title {
  font-weight: 700;
  color: #46d39a;
}
.swdbg__state {
  color: #9fe8c8;
}
.swdbg__spacer {
  flex: 1 1 auto;
}
.swdbg__btn {
  padding: 3px 8px;
  border: 1px solid rgba(70, 211, 154, 0.4);
  border-radius: 5px;
  background: transparent;
  color: #d8f0e2;
  font: inherit;
  cursor: pointer;
}
.swdbg__btn:active {
  background: rgba(70, 211, 154, 0.18);
}
.swdbg__log {
  flex: 1 1 auto;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
.swdbg__row {
  padding: 1px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}
.swdbg__t {
  color: #6f9c88;
}
/* Атрибут hidden сам по себе даёт лишь display:none из UA-стилей, который
   перебивается авторским .swdbg__panel{display:flex} — поэтому гасим явно. */
.swdbg[hidden],
.swdbg__panel[hidden],
.swdbg__badge[hidden] {
  display: none;
}
`;

class SwDebugImpl implements SwDebug {
  readonly enabled = true;
  private entries: LogEntry[] = readLog();
  private root!: HTMLElement;
  private badge!: HTMLButtonElement;
  private panel!: HTMLElement;
  private logEl!: HTMLElement;
  private stateEl!: HTMLElement;
  private reg: ServiceWorkerRegistration | null = null;
  private visCount = 0;
  private pageshowCount = 0;
  private focusCount = 0;

  constructor() {
    this.buildOverlay();
    this.render();
    this.logBootSnapshot();
    this.wireResumeSignals();
    this.wireControllerChange();
  }

  log(msg: string): void {
    this.entries.push({ t: Date.now(), msg });
    if (this.entries.length > LOG_CAP)
      this.entries.splice(0, this.entries.length - LOG_CAP);
    writeLog(this.entries);
    this.render();
  }

  attachRegistration(reg: ServiceWorkerRegistration): void {
    this.reg = reg;
    this.refreshState();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      this.log(`updatefound (installing=${nw ? nw.state : 'null'})`);
      this.refreshState();
      if (nw) this.watchWorker(nw, 'new');
    });
  }

  /** Логировать все переходы состояния конкретного воркера. */
  private watchWorker(w: ServiceWorker, tag: string): void {
    w.addEventListener('statechange', () => {
      this.log(`${tag} sw statechange → ${w.state}`);
      this.refreshState();
    });
  }

  private logBootSnapshot(): void {
    if (!('serviceWorker' in navigator)) {
      this.log('boot: no serviceWorker in navigator');
      return;
    }
    const c = navigator.serviceWorker.controller;
    this.log(`boot: controller=${c ? c.state : 'none'} standalone=${isStandalone()}`);
    // Регистрация может быть ещё не готова — дочитаем состояния асинхронно.
    void navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) {
        this.log('boot: getRegistration() → none');
        return;
      }
      this.log(
        `boot: reg active=${reg.active ? reg.active.state : 'none'} ` +
          `waiting=${reg.waiting ? 'yes' : 'no'} installing=${reg.installing ? 'yes' : 'no'}`,
      );
      this.refreshState();
    });
  }

  /** Сигналы возврата на передний план — только логируем (фикс — фаза 2). */
  private wireResumeSignals(): void {
    document.addEventListener('visibilitychange', () => {
      this.visCount += 1;
      this.log(`visibilitychange #${this.visCount} → ${document.visibilityState}`);
    });
    window.addEventListener('pageshow', (e) => {
      this.pageshowCount += 1;
      this.log(
        `pageshow #${this.pageshowCount} persisted=${(e as PageTransitionEvent).persisted}`,
      );
    });
    window.addEventListener('focus', () => {
      this.focusCount += 1;
      this.log(`focus #${this.focusCount}`);
    });
  }

  private wireControllerChange(): void {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const c = navigator.serviceWorker.controller;
      this.log(`controllerchange → controller=${c ? c.state : 'none'}`);
      this.refreshState();
    });
  }

  private refreshState(): void {
    const c = 'serviceWorker' in navigator ? navigator.serviceWorker.controller : null;
    const wait = this.reg?.waiting ? 'y' : 'n';
    const inst = this.reg?.installing ? 'y' : 'n';
    this.stateEl.textContent = `ctrl:${c ? c.state : 'none'} wait:${wait} inst:${inst}`;
  }

  private buildOverlay(): void {
    const style = document.createElement('style');
    style.id = 'swdbg-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'swdbg';

    this.badge = document.createElement('button');
    this.badge.type = 'button';
    this.badge.className = 'swdbg__badge';
    this.badge.textContent = 'SW ▲';
    this.badge.addEventListener('click', () => this.setCollapsed(false));

    this.panel = document.createElement('div');
    this.panel.className = 'swdbg__panel';
    this.panel.hidden = true;

    const head = document.createElement('div');
    head.className = 'swdbg__head';

    const title = document.createElement('span');
    title.className = 'swdbg__title';
    title.textContent = `SW ${__COMMIT__} · ${fmtDateTime(__BUILD_TIME__)}`;

    this.stateEl = document.createElement('span');
    this.stateEl.className = 'swdbg__state';

    const spacer = document.createElement('span');
    spacer.className = 'swdbg__spacer';

    const shareBtn = mkBtn('share', () => this.shareLog());
    // Web Share есть не везде (десктоп Chrome) — без него кнопку не показываем,
    // унести лог помогает copy. На iOS-standalone share — главный способ (AirDrop/
    // Сообщения/Почта из системного листа), т.к. буфер обмена туда не дотянешь.
    shareBtn.hidden = typeof navigator.share !== 'function';
    const copyBtn = mkBtn('copy', () => this.copyLog());
    const clearBtn = mkBtn('clear', () => this.clearLog());
    const collapseBtn = mkBtn('▾', () => this.setCollapsed(true)); // свернуть в бейдж
    const offBtn = mkBtn('✕', () => this.disable()); // совсем выключить отладку

    head.append(
      title,
      this.stateEl,
      spacer,
      shareBtn,
      copyBtn,
      clearBtn,
      collapseBtn,
      offBtn,
    );

    this.logEl = document.createElement('div');
    this.logEl.className = 'swdbg__log';

    this.panel.append(head, this.logEl);
    this.root.append(this.badge, this.panel);
    document.body.appendChild(this.root);

    this.refreshState();
  }

  /** Совсем выключить отладку: снять сохранённый флаг и убрать оверлей из DOM
   *  (без перезагрузки — при следующем запуске флага уже нет, оверлея не будет).
   *  Слушатели цикла SW остаются висеть до перезагрузки, но молча (лог не рисуется). */
  private disable(): void {
    try {
      localStorage.removeItem(FLAG_KEY);
    } catch {
      // localStorage недоступен — не критично
    }
    this.root.remove();
    document.getElementById('swdbg-style')?.remove();
  }

  private setCollapsed(collapsed: boolean): void {
    this.panel.hidden = collapsed;
    this.badge.hidden = !collapsed;
    if (!collapsed) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private render(): void {
    if (!this.logEl) return;
    const atBottom =
      this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 24;
    this.logEl.textContent = '';
    for (const e of this.entries) {
      const row = document.createElement('div');
      row.className = 'swdbg__row';
      const t = document.createElement('span');
      t.className = 'swdbg__t';
      t.textContent = `${fmtTime(e.t)} `;
      row.append(t, document.createTextNode(e.msg));
      this.logEl.appendChild(row);
    }
    if (atBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private clearLog(): void {
    this.entries = [];
    writeLog(this.entries);
    this.render();
  }

  /** Полный текст для выгрузки: шапка (build id + снимок состояния) + весь лог. */
  private fullLogText(): string {
    const header = `SW log · build ${__COMMIT__} · ${fmtDateTime(__BUILD_TIME__)}\nstate: ${this.stateEl.textContent}`;
    const body = this.entries.map((e) => `${fmtTime(e.t)} ${e.msg}`).join('\n');
    return `${header}\n${body}`;
  }

  private copyLog(): void {
    const text = this.fullLogText();
    const done = () => this.flash('copied');
    const fail = () => this.fallbackCopy(text);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      fail();
    }
  }

  /** Унести лог с телефона через системный лист (AirDrop/Сообщения/Почта). */
  private shareLog(): void {
    if (typeof navigator.share !== 'function') {
      this.copyLog(); // страховка, если кнопка всё же нажата без Web Share
      return;
    }
    navigator.share({ title: 'PR SW log', text: this.fullLogText() }).then(
      () => this.flash('shared'),
      (e: unknown) => {
        // Пользователь закрыл лист (AbortError) — это не ошибка, молчим.
        if (e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError')
          return;
        this.flash('share failed');
      },
    );
  }

  private fallbackCopy(text: string): void {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.flash('copied');
    } catch {
      this.flash('copy failed');
    }
  }

  private flash(msg: string): void {
    const prev = this.stateEl.textContent;
    this.stateEl.textContent = msg;
    window.setTimeout(() => this.refreshState(), 900);
    void prev;
  }
}

function mkBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swdbg__btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** Запущены ли из ярлыка на домашнем экране (iOS standalone / display-mode). */
function isStandalone(): boolean {
  const iosStandalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

/** Инициализировать отладку SW. Если флаг не выставлен — вернуть no-op контракт
 *  (оверлей не строится, слушатели не вешаются). */
export function initSwDebug(): SwDebug {
  if (!resolveEnabled()) return NOOP;
  return new SwDebugImpl();
}
