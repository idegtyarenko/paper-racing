// Общий низкий уровень UI: тип указателя, надёжная активация кнопок и оверлей
// со шторками. Не знает про состояние игры — используется панелью, диалогами и лобби.

/** Основной указатель устройства — палец (телефон/планшет). */
export const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

const overlay = document.getElementById('overlay')!;

/** Показать одну шторку оверлея, спрятав остальные. */
export function openSheet(sheet: HTMLElement): void {
  overlay.querySelectorAll<HTMLElement>('.sheet').forEach((s) => (s.hidden = true));
  sheet.hidden = false;
  overlay.hidden = false;
}

/** Спрятать оверлей со всеми шторками. */
export function closeOverlay(): void {
  overlay.hidden = true;
}

/** Навесить закрытие оверлея по фону, `[data-close]`-кнопкам и Escape. */
export function bindOverlayClose(): void {
  overlay.querySelector('.overlay__backdrop')!.addEventListener('click', closeOverlay);
  overlay
    .querySelectorAll<HTMLElement>('[data-close]')
    .forEach((b) => bindTap(b, closeOverlay));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOverlay();
  });
}

/**
 * Надёжная активация кнопки на сенсорном экране. На iOS первый синтетический
 * `click` по кнопке, показанной сразу после жеста на canvas (например «Вперёд» в
 * редакторе или «Газу!» после прицела), теряется — кнопка срабатывает лишь со
 * второго тапа. Media-фикс `:hover` убрал только «залипающий» стиль, но не саму
 * потерю клика. Поэтому на coarse-указателе активируем прямо по завершению
 * касания (`pointerup` доходит с первого раза), а дублирующий `click`, если он
 * всё же придёт следом, гасим по времени. Мышь, стилус и клавиатура (Enter/Space
 * шлют `click` без касания) идут обычным путём. Прокрутка панели, начатая с
 * кнопки, отменяет касание через `pointercancel` — тогда `pointerup` не придёт.
 */
export function bindTap(el: HTMLElement, handler: () => void): void {
  const disabled = () => el.matches(':disabled');
  if (!coarsePointer) {
    el.addEventListener('click', () => {
      if (!disabled()) handler();
    });
    return;
  }
  let tappedAt = -Infinity;
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' || disabled()) return;
    tappedAt = e.timeStamp;
    handler();
  });
  el.addEventListener('click', (e) => {
    if (e.timeStamp - tappedAt < 700 || disabled()) return;
    handler();
  });
}
