// Race-settings sheet — the modal entry still used by the online lobby (the
// local setup screens carry the same controls as their own "Behaviour"/"Rules"
// tabs since the redesign). The controls themselves come from the shared
// rules-editor component; this module only owns the sheet chrome: its two tabs
// and the hosts they show.

import { Rules } from '../model/game';
import { mountRulesEditor, RulesEditor } from './rules-editor';
import { bindTap, openSheet } from './dom';

const sheet = document.getElementById('settingsSheet')!;
const settingsTabs = document.getElementById('settingsTabs')!;
const driveTab = document.getElementById('driveTab')!;
const rulesTab = document.getElementById('rulesTab')!;

type SettingsTab = 'drive' | 'rules';

/** Which sheet tab is open ("Handling"/"Rules") — local, not part of Rules. */
let activeTab: SettingsTab = 'drive';
let editor: RulesEditor | null = null;

/** Build the controls on first use (the sheet is rarely opened). */
function ensureEditor(): RulesEditor {
  editor ??= mountRulesEditor({ drive: driveTab, rules: rulesTab });
  return editor;
}

/** Show the active tab: toggle group visibility and the tab-button highlight. */
function applyTab(): void {
  driveTab.hidden = activeTab !== 'drive';
  rulesTab.hidden = activeTab !== 'rules';
  settingsTabs.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle('seg__btn--active', btn.dataset.tab === activeTab);
  });
}

/**
 * Open the settings sheet. current is the active rules (the editor copies it:
 * changes are sent out immediately via onChange, and the caller's object is
 * never mutated). isOnline marks a networked race — in that case the editor
 * shows the time-limit row.
 */
export function openSettings(
  current: Rules,
  isOnline: boolean,
  onChangeCb: (r: Rules) => void,
): void {
  const ed = ensureEditor();
  ed.open(current, isOnline, onChangeCb);
  activeTab = 'drive'; // the sheet always opens on the "Handling" tab
  applyTab();
  openSheet(sheet);
  // The first render ran while the sheet was hidden (zero-width canvas) —
  // redraw the preview once the sheet is visible and the actual width is known.
  requestAnimationFrame(() => ed.refreshPreview());
}

/** Wire up the sheet's tab strip (once, at panel init). */
export function bindSettings(): void {
  settingsTabs.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    bindTap(btn, () => {
      activeTab = btn.dataset.tab as SettingsTab;
      applyTab();
      // Returning to "Handling": the canvas may have been sitting hidden (zero
      // width) — redraw the preview now that it's visible again.
      if (activeTab === 'drive')
        requestAnimationFrame(() => ensureEditor().refreshPreview());
    });
  });
}
