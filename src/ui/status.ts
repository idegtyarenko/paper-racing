// Строка статуса боковой панели: заметный бейдж «Шаг N из M» + инструкция.
// Общий для панели (шаги мастера/гонка) и лобби (код/ожидание игроков).

const statusEl = document.querySelector('.status')!;

export function div(className: string, text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  d.textContent = text;
  return d;
}

/** Заметный шаг мастера: бейдж «Шаг N из M» + инструкция. */
export function renderStepStatus(badge: string, body: string): void {
  statusEl.className = 'status status--step';
  statusEl.replaceChildren(div('status__badge', badge), div('status__body', body));
}

/** Прямой доступ к элементу статуса — для панели (текст хода, ошибки редактора). */
export function statusElement(): Element {
  return statusEl;
}
