// Экран лобби онлайн-игры: код игры, список игроков (ростер), кнопки «Начать»/
// «Поделиться»/«Выйти» и статус ожидания. Пишет свою инструкцию в общий статус.

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
  /** Досаженных ботов (host-local); блок управления виден только хосту. */
  botCount: number;
  /** Сколько ботов ещё влезает на свободные места (для лимита степпера). */
  maxBots: number;
  /** Сложность досаживаемых ботов. */
  botDifficulty: Difficulty;
}

/** Обработчики кнопок лобби (подмножество PanelHandlers, передаётся структурно). */
export interface LobbyHandlers {
  /** Хост стартует онлайн-гонку. */
  onLobbyStart: () => void;
  /** Поделиться ссылкой на игру. */
  onLobbyShare: () => void;
  /** Скопировать код игры. */
  onLobbyCopyCode: () => void;
  /** Открыть настройки правил (только хост). */
  onLobbySettings: () => void;
  /** Хост: досадить ещё одного бота. */
  onLobbyBotAdd: () => void;
  /** Хост: убрать одного бота. */
  onLobbyBotRemove: () => void;
  /** Хост: сложность досаживаемых ботов. */
  onLobbyBotDifficulty: (d: Difficulty) => void;
  /** Выйти из лобби. */
  onLobbyLeave: () => void;
}

/** Идёт ли запись стартового стейта (кнопка «Начать» заблокирована). Живёт вне
 *  renderLobby, чтобы переживать ре-рендеры лобби по presence во время await. */
let starting = false;

/** Пока хост стартует гонку: заблокировать «Начать игру» и показать «Запускаем…».
 *  Применяем сразу (без ре-рендера) и запоминаем для будущих renderLobby. */
export function setLobbyStarting(b: boolean): void {
  starting = b;
  lobbyStartBtn.disabled = b;
  if (b) lobbyStartBtn.textContent = strings.online.starting;
  else lobbyStartBtn.textContent = strings.online.start;
}

/** Отрисовать экран лобби: код, список игроков, кнопку «Начать» и статус. */
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
  // Блок досаживания ботов — только у хоста. Степпер зажат в [0, maxBots], подсветка
  // выбранной сложности — как на экранах состава.
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

/** Навесить кнопки лобби. */
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
