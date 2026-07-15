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
  // Закрываем по фону, только если и нажатие началось на фоне. Иначе на iOS
  // синтетический `click` после тапа, свернувшего подсказку в bottom-sheet
  // (шторка анкерится снизу и уезжает вниз, а координаты клика оказываются над
  // её верхним краем — на фоне), перенаправлялся на фон и ложно закрывал оверлей.
  const backdrop = overlay.querySelector<HTMLElement>('.overlay__backdrop')!;
  let pressedBackdrop = false;
  overlay.addEventListener('pointerdown', (e) => {
    pressedBackdrop = e.target === backdrop;
  });
  backdrop.addEventListener('click', () => {
    if (pressedBackdrop) closeOverlay();
  });
  overlay
    .querySelectorAll<HTMLElement>('[data-close]')
    .forEach((b) => bindTap(b, closeOverlay));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOverlay();
  });
}

/** Сдвиг пальца между down и up больше этого — это скролл/перетаскивание, не тап. */
const TAP_SLOP_PX = 10;
/** Окно после тач-активации, в которое давим призрачный синтетический `click`. */
const GHOST_CLICK_MS = 400;
/** Дедуп: повторное срабатывание того же элемента в этом окне игнорируем. */
const RETAP_MS = 350;
/** Призрачный click прилетает в точку тапа; дальше этого радиуса — уже другой тап. */
const GHOST_SLOP_PX = 24;

// Глобальный «гаситель» призрачного click. На coarse-указателе кнопку активируем по
// `pointerup`, а следом браузер шлёт синтетический `click` в ту же точку. Пер-элементного
// окна мало: за время удержания панель могла перерисоваться и под палец подставить другую
// кнопку — её `click` не «свой», а passthrough, и пер-элементная защита его пропускала.
// Поэтому один слушатель на документе в фазе capture съедает `click` сразу после
// тач-активации в той же точке — до того как он дойдёт до целевого элемента (в т.ч. нового
// под пальцем). Привязка к координатам, а не только ко времени, не даёт погасить
// осознанный тап по другой кнопке (например зуму) в это же окно.
let swallowClickUntil = -Infinity;
let swallowX = 0;
let swallowY = 0;
let clickSwallowInstalled = false;
function installClickSwallow(): void {
  if (clickSwallowInstalled) return;
  clickSwallowInstalled = true;
  document.addEventListener(
    'click',
    (e) => {
      const atTapPoint =
        Math.hypot(e.clientX - swallowX, e.clientY - swallowY) <= GHOST_SLOP_PX;
      if (e.timeStamp <= swallowClickUntil && atTapPoint) {
        e.stopPropagation(); // не даём click дойти до любой кнопки (и «своей», и чужой)
        e.preventDefault();
      }
    },
    true, // capture — перехватываем до целевого элемента
  );
}

/**
 * Надёжная активация кнопки на сенсорном экране. На iOS первый синтетический
 * `click` по кнопке, показанной сразу после жеста на canvas (например «Вперёд» в
 * редакторе или «Газу!» после прицела), теряется — кнопка срабатывает лишь со
 * второго тапа. Поэтому на coarse-указателе активируем прямо по завершению касания
 * (`pointerup` доходит с первого раза), а призрачный `click` следом гасим глобально
 * (см. `installClickSwallow`). Тапом считаем только пару `pointerdown`+`pointerup` на
 * одном элементе (тот же `pointerId`, без ухода за `TAP_SLOP_PX`) — это отсекает
 * passthrough и «обратный» drag (нажал в другом месте, отпустил на кнопке). Прокрутка,
 * начатая с кнопки, шлёт `pointercancel` — тап отменяется. Мышь, стилус и клавиатура
 * (Enter/Space шлют `click` без касания) идут обычным `click`-путём.
 *
 * Контракт с `view/input.ts`: коммит хода кнопкой «Едем!» завязан на приход `pointerup`
 * на неё. Если под кнопкой оказался кандидат, input.ts на `pointerdown` забирает
 * указатель на canvas через `setPointerCapture` — тогда `pointerup` сюда не придёт и
 * тап не сработает (намеренно: уходим в прицеливание, а не коммитим чужой ход).
 */
export function bindTap(el: HTMLElement, handler: () => void): void {
  const disabled = () => el.matches(':disabled');
  let firedAt = -Infinity;
  const fire = (ts: number) => {
    if (disabled() || ts - firedAt < RETAP_MS) return; // дедуп двойного тапа
    firedAt = ts;
    handler();
  };
  // Мышь/стилус/клавиатура. На coarse этот путь остаётся для клавиатуры и не-тач
  // указателей; «свой» синтетический click тач-тапа сюда не дойдёт — его съест
  // глобальный гаситель в фазе capture.
  el.addEventListener('click', (e) => fire(e.timeStamp));
  if (!coarsePointer) return;
  installClickSwallow();
  let downId = -1;
  let downX = 0;
  let downY = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    downId = e.pointerId;
    downX = e.clientX;
    downY = e.clientY;
  });
  el.addEventListener('pointercancel', (e) => {
    if (e.pointerId === downId) downId = -1;
  });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' || e.pointerId !== downId) return;
    downId = -1;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_SLOP_PX) return; // скролл
    // Гасим призрачный click, прилетающий в эту точку следом (глобально, см. выше).
    swallowClickUntil = e.timeStamp + GHOST_CLICK_MS;
    swallowX = e.clientX;
    swallowY = e.clientY;
    fire(e.timeStamp);
  });
}
