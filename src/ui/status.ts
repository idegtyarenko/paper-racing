// Side-panel status line: a prominent "Step N of M" badge plus an instruction.
// Shared by the panel (wizard steps/race) and the lobby (code/waiting for players).

const statusEl = document.querySelector('.status')!;

export function div(className: string, text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  d.textContent = text;
  return d;
}

/** A prominent wizard step: "Step N of M" badge plus an instruction. */
export function renderStepStatus(badge: string, body: string): void {
  statusEl.className = 'status status--step';
  statusEl.replaceChildren(div('status__badge', badge), div('status__body', body));
}

/** Direct access to the status element — used by the panel (turn text, editor errors). */
export function statusElement(): Element {
  return statusEl;
}
