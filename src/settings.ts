import { normalizePath, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI, isPro, proLabel } from './pro';
import type VaultLossAlarmPlugin from './main';
import type { FolderRule } from './engine';
import { helloSettingItems } from './hello/settings';
export interface VaultLossAlarmSettings {
    fileThreshold: number;
    byteThreshold: number;
    deleteThreshold: number;
    folderRules: string;
}
export const DEFAULT_SETTINGS: VaultLossAlarmSettings = { fileThreshold: 5, byteThreshold: 1000000, deleteThreshold: 20, folderRules: '' };
function positive(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.round(v)) : fallback;
}
export function normalizeSettings(saved: Partial<VaultLossAlarmSettings> | null | undefined): VaultLossAlarmSettings {
    return { fileThreshold: positive(saved?.fileThreshold, 5), byteThreshold: positive(saved?.byteThreshold, 1000000), deleteThreshold: positive(saved?.deleteThreshold, 20), folderRules: typeof saved?.folderRules === 'string' ? saved.folderRules : '' };
}
export function parseFolderRules(text: string): FolderRule[] {
    const rules: FolderRule[] = [];
    for (const row of text.split('\n').filter((r) => r.trim())) {
        const [raw, count, bytes, extra] = row.split('|');
        const folder = normalizePath(raw?.trim() ?? '');
        if (!folder || folder.split('/').includes('..') || extra !== undefined || !Number.isInteger(Number(count)) || Number(count) < 1 || !Number.isInteger(Number(bytes)) || Number(bytes) < 1)
            throw new Error('Use folder | file count | bytes, with positive whole numbers.');
        rules.push({ folder, files: Number(count), bytes: Number(bytes) });
    }
    return rules;
}
export class VaultLossAlarmSettingTab extends PluginSettingTab {
    plugin: VaultLossAlarmPlugin;
    constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], plugin: VaultLossAlarmPlugin) { super(app, plugin); this.plugin = plugin; }
    getSettingDefinitions(): SettingDefinitionItem[] {
        // The product rows, then the "More from NoteMods" card (packages/hello).
        return [...this.productSettingDefinitions(), ...helloSettingItems()];
    }

    productSettingDefinitions(): SettingDefinitionItem[] {
        return [
            ...(['fileThreshold', 'byteThreshold', 'deleteThreshold'] as const).map((key, i) => ({
                name: ['Missing file threshold', 'Missing byte threshold', 'Delete event threshold'][i]!,
                desc: ['Alarm when the missing count reaches this value.', 'Alarm when the last sizes total this many bytes. 1 MB is 1000000 bytes.', 'Alarm when this many delete events occur in 10 minutes. In-app deletions count.'][i]!,
                render: (setting: import('obsidian').Setting) => { setting.addText((text) => text.setValue(String(this.plugin.settings[key])).onChange(async (v) => { const n = Number(v); if (Number.isInteger(n) && n > 0) {
                    this.plugin.settings[key] = n;
                    await this.plugin.saveSettings();
                } })); },
            })),
            { name: proLabel('Folder thresholds'), desc: 'One rule per line: folder | file count | bytes. These rules add alarms below the vault threshold.', render: (setting) => { setting.setDisabled(!isPro()).addTextArea((text) => text.setValue(this.plugin.settings.folderRules).onChange(async (v) => { if (!isPro())
                    return; try {
                    parseFolderRules(v);
                    this.plugin.settings.folderRules = v;
                    await this.plugin.saveSettings();
                    text.inputEl.setCustomValidity('');
                }
                catch {
                    text.inputEl.setCustomValidity('Use folder | file count | bytes.');
                    text.inputEl.reportValidity();
                } })); } },
            ...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
        ];
    }
}
