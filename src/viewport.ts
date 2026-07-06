// Вьюпорт: мутабельное состояние камеры и политика кадрирования поверх чистого
// camera.ts. Знает, КАК вписать/ограничить/подвинуть камеру по заданным границам
// содержимого; ЧТО сейчас на экране (границы) сообщает вызывающий через
// boundsProvider. DOM здесь только canvas/обёртка (размер + rect), рендера нет.
// Ровно один вьюпорт на приложение (модуль-синглтон).

import { Vec } from './geometry';
import { WORLD_W, WORLD_H } from './track';
import { SCALE_DEFAULT, FIT_MARGIN } from './config';
import {
  Camera,
  Bounds,
  screenToWorld,
  fitBounds,
  zoomAt as camZoomAt,
  clampToBounds,
} from './camera';

let canvas: HTMLCanvasElement;
let wrap: Element;
/** Границы текущего содержимого в мировых координатах (или null — пустое поле). */
let boundsProvider: () => Bounds | null = () => null;

/** Камера: единый переход мир↔экран. Инициализируется в resize() до первого кадра. */
let cam: Camera = { scale: SCALE_DEFAULT, ox: 0, oy: 0 };
/** Пользователь вручную зумил/панорамировал: при ресайзе сохраняем его вид,
 *  а не пере-вписываем трассу. Сбрасывается при каждом авто-вписывании. */
let userAdjustedView = false;

export function initViewport(
  canvasEl: HTMLCanvasElement,
  wrapEl: Element,
  bounds: () => Bounds | null,
): void {
  canvas = canvasEl;
  wrap = wrapEl;
  boundsProvider = bounds;
}

/** Текущая камера (для redraw()/render и worldToScreen). */
export function camera(): Camera {
  return cam;
}

/** Размер клетки на экране, css-px (для touchTol()/loupeActive()). */
export function scale(): number {
  return cam.scale;
}

export function viewSize(): { w: number; h: number } {
  const r = wrap.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

/** Стартовый вид пустого поля: центр мира в центре вьюпорта. */
function defaultCamera(w: number, h: number): Camera {
  const c = WORLD_W / 2;
  return {
    scale: SCALE_DEFAULT,
    ox: w / 2 - c * SCALE_DEFAULT,
    oy: h / 2 - c * SCALE_DEFAULT,
  };
}

/** Вписать содержимое по центру (или дефолтный вид, если содержимого нет). */
export function fitToContent(): void {
  const { w, h } = viewSize();
  const bb = boundsProvider();
  cam = bb ? fitBounds(bb, w, h, FIT_MARGIN) : defaultCamera(w, h);
  userAdjustedView = false;
}

/** Ограничить пан, чтобы трасса не уезжала полностью из вида. */
export function clamp(): void {
  const bb = boundsProvider();
  if (!bb) return;
  const { w, h } = viewSize();
  cam = clampToBounds(cam, bb, w, h);
}

export function toScreen(e: PointerEvent): Vec {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function toWorld(e: PointerEvent, liftPx = 0): Vec {
  const p = toScreen(e);
  const w = screenToWorld(cam, { x: p.x, y: p.y - liftPx });
  // Клампим в границы (квадратного) мира — он key-безопасен и достаточно велик,
  // чтобы при масштабе по умолчанию ощущаться бесконечным при рисовании.
  return {
    x: Math.max(0, Math.min(WORLD_W, w.x)),
    y: Math.max(0, Math.min(WORLD_H, w.y)),
  };
}

/** Пересчитать размер canvas и кадр под текущий размер вьюпорта (без redraw). */
export function resize(): void {
  const r = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  // Кадр берём из содержимого: пустое поле — дефолтный вид; трасса — вписываем
  // по центру. Если пользователь сам зумил/панорамировал — сохраняем его масштаб,
  // лишь переклампив смещение под новый размер.
  const bb = boundsProvider();
  if (!bb) cam = defaultCamera(r.width, r.height);
  else if (userAdjustedView) cam = clampToBounds(cam, bb, r.width, r.height);
  else cam = fitBounds(bb, r.width, r.height, FIT_MARGIN);
}

/** Зум относительно экранной точки: пометить вид как пользовательский + клампить. */
export function zoomAt(factor: number, sx: number, sy: number): void {
  cam = camZoomAt(cam, factor, sx, sy);
  userAdjustedView = true;
  clamp();
}

/** Применить пользовательскую камеру (пинч/пан): set + adjusted + clamp. */
export function applyUserCamera(next: Camera): void {
  cam = next;
  userAdjustedView = true;
  clamp();
}
