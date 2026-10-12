import { Modal, Notice, Setting } from 'obsidian';
import type VaultLossAlarmPlugin from './main';
import type { Entry, Report } from './engine';
import { isPro, proLabel } from './pro';
export class LossModal extends Modal {
    constructor(private plugin: VaultLossAlarmPlugin, private report: Report, private reason: string) { super(plugin.app); }
    onOpen(): void {
        this.modalEl.addClass('vault-loss-alarm');
        this.setTitle('Vault loss alarm');
        const el = this.contentEl;
        el.empty();
        el.createEl('p', { text: this.reason });
        el.createEl('p', { text: `Lost ${this.report.missing.length} files · ${this.report.bytes} bytes · Now empty ${this.report.empty.length} notes`, cls: 'vla-summary' });
        el.createEl('p', { text: 'Check your backup and sync state. Closing this report keeps the baseline.' });
        this.section('Missing paths', this.report.missing);
        this.section('Now empty', this.report.empty);
        if (this.reason.startsWith('History')) {
            this.section('Added paths', this.report.added);
            this.section('Changed size or time', this.report.changed);
        }
        new Setting(el).addButton((b) => b.setButtonText('Close').onClick(() => this.close()));
        new Setting(el).setName(proLabel('Restore checklist')).setDesc('Create a new note with the missing and empty paths. It does not restore file contents.').addButton((b) => b.setButtonText('Write checklist').setDisabled(!isPro()).onClick(async () => { try {
            await this.plugin.writeChecklist(this.report);
        }
        catch {
            new Notice('Could not write the restore checklist.');
        } }));
    }
    private section(title: string, files: Entry[]): void {
        new Setting(this.contentEl).setName(title).setHeading();
        if (!files.length) {
            this.contentEl.createEl('p', { text: 'None' });
            return;
        }
        const table = this.contentEl.createEl('table', { cls: 'vla-paths' });
        const head = table.createEl('thead').createEl('tr');
        head.createEl('th', { text: 'Path' });
        head.createEl('th', { text: 'Last known size' });
        const body = table.createEl('tbody');
        for (const f of files) {
            const row = body.createEl('tr');
            row.createEl('td', { text: f.path });
            row.createEl('td', { text: `${f.size} bytes` });
        }
    }
    onClose(): void { this.contentEl.empty(); if (this.plugin.alarm === this)
        this.plugin.alarm = null; }
}
export class HistoryModal extends Modal {
    constructor(private plugin: VaultLossAlarmPlugin, private dates: number[]) { super(plugin.app); }
    onOpen(): void {
        this.setTitle(proLabel('Compare manifest dates'));
        if (this.dates.length < 2) {
            this.contentEl.createEl('p', { text: 'Save at least two manifests with pro on. Check vault now saves one.' });
            return;
        }
        let before = this.dates[0]!;
        let after = this.dates[this.dates.length - 1]!;
        const select = (name: string, value: number, change: (v: number) => void) => new Setting(this.contentEl).setName(name).addDropdown((d) => { for (const date of this.dates)
            d.addOption(String(date), new Date(date).toISOString().replace('T', ' ').replace('Z', ' UTC')); d.setValue(String(value)).onChange((v) => change(Number(v))); });
        select('From', before, (v) => { before = v; });
        select('To', after, (v) => { after = v; });
        new Setting(this.contentEl).addButton((b) => b.setButtonText('Compare').setCta().onClick(async () => {
            try {
                const report = await this.plugin.diffDates(before, after);
                if (report) {
                    this.close();
                    this.plugin.showReport(report, `History: ${new Date(before).toISOString().replace('T', ' ').replace('Z', ' UTC')} → ${new Date(after).toISOString().replace('T', ' ').replace('Z', ' UTC')}`);
                }
            }
            catch {
                new Notice('A history manifest is unreadable.');
            }
        }));
    }
    onClose(): void { this.contentEl.empty(); }
}
