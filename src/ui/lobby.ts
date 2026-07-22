// Online-race lobby screen: race code, player list (roster), the "Start"/
// "Share"/"Leave" buttons, and the waiting status. Writes its own instruction
// into the shared status area.

import { bindTap } from './dom';
import { renderStepStatus } from './status';
import { strings } from '../i18n';
import { Difficulty } from '../model/ai';

const lobbyCodeBtn = document.getElementById('lobbyCode') as HTMLButtonElement;
const lobbyShareBtn = document.getElementById('lobbyShare') as HTMLButtonElement;
const lobbyRoster = document.getElementById('lobbyRoster')!;
const lobbyBots = document.getElementById('lobbyBots')!;
const lobbyBotRemoveBtn = document.getElementById('lobbyBotRemove') as HTMLButtonElement;
const lobbyBotAddBtn = document.getElementById('lobbyBotAdd') as HTMLButtonElement;
const lobbyBotCountEl = document.getElementById('lobbyBotCount')!;
const lobbyBotDifficulty = document.getElementById('lobbyBotDifficulty')!;
const lobbySettingsBtn = document.getElementById('lobbySettings') as HTMLButtonElement;
const lobbyStartBtn = document.getElementById('lobbyStart') as HTMLButtonElement;
const lobbyLeaveBtn = document.getElementById('lobbyLeave') as HTMLButtonElement;

export interface LobbyView {
  code: string;
  players: { name: string; color: string; you: boolean; offline?: boolean }[];
  canStart: boolean;
  isHost: boolean;
  /** Bots added by the host (host-local); the controls are visible only to the host. */
  botCount: number;
  /** How many more bots still fit in the open seats (for the stepper's limit). */
  maxBots: number;
  /** Difficulty of the bots being added. */
  botDifficulty: Difficulty;
}

/** Lobby button handlers (a subset of PanelHandlers, passed structurally). */
export interface LobbyHandlers {
  /** Host starts the online race. */
  onLobbyStart: () => void;
  /** Share the race link. */
  onLobbyShare: () => void;
  /** Copy the race code. */
  onLobbyCopyCode: () => void;
  /** Open rules settings (host only). */
  onLobbySettings: () => void;
  /** Host: add one more bot. */
  onLobbyBotAdd: () => void;
  /** Host: remove one bot. */
  onLobbyBotRemove: () => void;
  /** Host: difficulty of the bots being added. */
  onLobbyBotDifficulty: (d: Difficulty) => void;
  /** Leave the lobby. */
  onLobbyLeave: () => void;
}

/** Whether the starting game state is currently being written (the "Start"
 *  button is disabled). Lives outside renderLobby so it survives lobby
 *  re-renders triggered by presence updates during the await. */
let starting = false;

/** While the host is starting the race: disable "Start game" and show
 *  "Starting…". Applied immediately (no re-render needed) and remembered for
 *  future renderLobby calls. */
export function setLobbyStarting(b: boolean): void {
  starting = b;
  lobbyStartBtn.disabled = b;
  if (b) lobbyStartBtn.textContent = strings.online.starting;
  else lobbyStartBtn.textContent = strings.online.start;
}

/** Render the lobby screen: code, player list, "Start" button, and status. */
export function renderLobby(v: LobbyView): void {
  lobbyCodeBtn.textContent = v.code;
  lobbyRoster.replaceChildren(
    ...v.players.map((p) => {
      const li = document.createElement('li');
      li.className = 'lobby__player';
      const dot = document.createElement('span');
      dot.className = 'lobby__dot';
      dot.style.background = p.color;
      const name = document.createElement('span');
      name.className = 'lobby__name';
      name.textContent = p.name;
      li.append(dot, name);
      if (p.offline) {
        li.classList.add('lobby__player--offline');
        li.title = strings.online.offline;
      }
      if (p.you) {
        const you = document.createElement('span');
        you.className = 'lobby__you';
        you.textContent = strings.online.you;
        li.append(you);
      }
      return li;
    }),
  );
  // The bot-adding controls are host-only. The stepper is clamped to
  // [0, maxBots]; the selected-difficulty highlight matches the setup screens.
  lobbyBots.hidden = !v.isHost;
  if (v.isHost) {
    lobbyBotCountEl.textContent = String(v.botCount);
    lobbyBotRemoveBtn.disabled = v.botCount <= 0;
    lobbyBotAddBtn.disabled = v.botCount >= v.maxBots;
    lobbyBotDifficulty
      .querySelectorAll<HTMLButtonElement>('.count-btn')
      .forEach((btn) => {
        btn.classList.toggle(
          'count-btn--selected',
          btn.dataset.difficulty === v.botDifficulty,
        );
      });
  }
  lobbySettingsBtn.hidden = !v.isHost;
  lobbyStartBtn.hidden = !v.isHost;
  lobbyStartBtn.disabled = starting || !v.canStart;
  lobbyStartBtn.textContent = starting ? strings.online.starting : strings.online.start;
  const body = v.isHost
    ? v.canStart
      ? strings.online.lobbyHost
      : strings.online.waiting
    : strings.online.lobbyGuest;
  renderStepStatus(strings.online.lobbyBadge, body);
}

/** Wire up the lobby buttons. */
export function bindLobby(h: LobbyHandlers): void {
  bindTap(lobbyStartBtn, h.onLobbyStart);
  bindTap(lobbyShareBtn, h.onLobbyShare);
  bindTap(lobbyCodeBtn, h.onLobbyCopyCode);
  bindTap(lobbySettingsBtn, h.onLobbySettings);
  bindTap(lobbyBotAddBtn, h.onLobbyBotAdd);
  bindTap(lobbyBotRemoveBtn, h.onLobbyBotRemove);
  lobbyBotDifficulty
    .querySelectorAll<HTMLButtonElement>('[data-difficulty]')
    .forEach((btn) => {
      bindTap(btn, () => h.onLobbyBotDifficulty(btn.dataset.difficulty as Difficulty));
    });
  bindTap(lobbyLeaveBtn, h.onLobbyLeave);
}
