// Service worker lifecycle diagnostics — for debugging PWA auto-update on iOS
// (standalone), where the update isn't picked up. Enabled via the `?swdebug`
// URL flag and persisted to localStorage, so it survives (1) launching from
// the home screen, where there's no query string (start_url = '.'), and (2)
// the auto-reload on `controllerchange` in autoUpdate mode, which wipes JS
// state — and seeing WHAT happened BEFORE the reload is exactly the point.
//
// This is observation ONLY: update behavior itself isn't changed (fixes are
// phases 2/3). Disabled by default — no overlay in prod, no overhead.
//
// Remote-inspecting a stuck standalone PWA from a laptop is unreliable, so we
// show the log right on screen, with a "copy" button so the text can be sent
// over.

const FLAG_KEY = 'pr-swdebug';
const LOG_KEY = 'pr-swdebug-log';
const LOG_CAP = 200;

interface LogEntry {
  t: number; // epoch-ms
  msg: string;
}

/** Public contract for `pwa.ts`. When `enabled === false`, everything is a no-op. */
export interface SwDebug {
  readonly enabled: boolean;
  /** Write a line to the log (timestamped). No-op if debugging is off. */
  log(msg: string): void;
  /** Attach `updatefound`/`statechange` logging and refresh the status line. */
  attachRegistration(reg: ServiceWorkerRegistration): void;
}

const NOOP: SwDebug = {
  enabled: false,
  log() {},
  attachRegistration() {},
};

/** Whether debugging is active. As a side effect, syncs the saved flag from
 *  the URL: `?swdebug`/`?swdebug=1` turns it on (and remembers it),
 *  `?swdebug=0` turns it off. */
function resolveEnabled(): boolean {
  let flag = false;
  try {
    flag = localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    // localStorage unavailable (private browsing) — go by the URL alone
  }
  const params = new URLSearchParams(location.search);
  if (params.has('swdebug')) {
    const v = params.get('swdebug');
    flag = v !== '0' && v !== 'false';
    try {
      if (flag) localStorage.setItem(FLAG_KEY, '1');
      else localStorage.removeItem(FLAG_KEY);
    } catch {
      // ignore — not critical
    }
  }
  return flag;
}

/** Toggle the saved debug flag and return the new state. Needed to turn
 *  debugging on FROM INSIDE the app: a standalone PWA on iOS has its own
 *  separate localStorage jar (a `?swdebug` flag set in Safari doesn't carry
 *  over to it), and there's no address bar to add a query param to. The
 *  caller reloads the page afterward so `initSwDebug()` sees the flag and
 *  builds the overlay. */
export function toggleSwDebug(): boolean {
  let on = false;
  try {
    on = localStorage.getItem(FLAG_KEY) !== '1';
    if (on) localStorage.setItem(FLAG_KEY, '1');
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    // localStorage unavailable — can't toggle
  }
  return on;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** Wall-clock time `HH:MM:SS.mmm` — so "just now" lines up with the phone's clock. */
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
    // quota exceeded / private browsing — fail silently
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
/* The hidden attribute by itself only gives display:none from UA styles,
   which gets overridden by our own .swdbg__panel{display:flex} — so we
   suppress it explicitly. */
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

  /** Log every state transition of a given worker. */
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
    // The registration might not be ready yet — read the rest of the state async.
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

  /** Signals of returning to the foreground — logged only (the fix is phase 2). */
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
    // Web Share isn't available everywhere (desktop Chrome) — hide the button
    // when it's missing, copy still gets the log out. On iOS standalone,
    // share is the main way out (AirDrop/Messages/Mail from the system
    // sheet), since the clipboard doesn't reach off-device.
    shareBtn.hidden = typeof navigator.share !== 'function';
    const copyBtn = mkBtn('copy', () => this.copyLog());
    const clearBtn = mkBtn('clear', () => this.clearLog());
    const collapseBtn = mkBtn('▾', () => this.setCollapsed(true)); // collapse to badge
    const offBtn = mkBtn('✕', () => this.disable()); // turn debugging off entirely

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

  /** Turn debugging off entirely: clear the saved flag and remove the overlay
   *  from the DOM (no reload needed — on the next launch the flag is gone
   *  and there'll be no overlay). SW lifecycle listeners stay attached until
   *  the next reload, but silently (nothing gets logged to the UI). */
  private disable(): void {
    try {
      localStorage.removeItem(FLAG_KEY);
    } catch {
      // localStorage unavailable — not critical
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

  /** Full text for export: a header (build id + state snapshot) plus the whole log. */
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

  /** Get the log off the phone via the system share sheet (AirDrop/Messages/Mail). */
  private shareLog(): void {
    if (typeof navigator.share !== 'function') {
      this.copyLog(); // fallback in case the button gets clicked without Web Share
      return;
    }
    navigator.share({ title: 'PR SW log', text: this.fullLogText() }).then(
      () => this.flash('shared'),
      (e: unknown) => {
        // The user dismissed the sheet (AbortError) — not an error, stay quiet.
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

/** Whether launched from a home-screen shortcut (iOS standalone / display-mode). */
function isStandalone(): boolean {
  const iosStandalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

/** Initialize SW debugging. If the flag isn't set, return the no-op contract
 *  (no overlay built, no listeners attached). */
export function initSwDebug(): SwDebug {
  if (!resolveEnabled()) return NOOP;
  return new SwDebugImpl();
}
