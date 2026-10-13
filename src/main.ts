import { Notice, Plugin, TFile, normalizePath, type TAbstractFile } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { bindPro, isPro, resetPro, proLabel, SPONSORS } from './pro';
import { DEFAULT_SETTINGS, normalizeSettings, parseFolderRules, VaultLossAlarmSettingTab, type VaultLossAlarmSettings } from './settings';
import { checklist, compare, deleteReport, hasLoss, historyKeep, historyWithin, movePaths, parseManifest, rolling, shouldAlarm, snapshot, type FolderRule, type DeleteRecord, type Manifest, type Report } from './engine';
import { HistoryModal, LossModal } from './modal';
export const SETTLE_MS = 60000;
export const SAVE_MS = 30 * 60 * 1000;
export const DELETE_REFRESH_MS = 1000;
export default class VaultLossAlarmPlugin extends Plugin {
    settings: VaultLossAlarmSettings = { ...DEFAULT_SETTINGS };
    pro: SponsorsManager | null = null;
    baseline: Manifest | null = null;
    lastReport: Report = compare([], []);
    deletes: DeleteRecord[] = [];
    alarm: LossModal | null = null;
    private tab: VaultLossAlarmSettingTab | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private stopped = false;
    private corrupt = false;
    private historyModal: HistoryModal | null = null;
    private deleteTimer = 0;
    private deletePending = false;
    path(name: string): string { return normalizePath(`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/${name}`); }
    capture(now = Date.now()): Manifest { return snapshot(this.app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime })), now); }
    private serial<T>(job: () => Promise<T>): Promise<T> { const next = this.queue.then(job); this.queue = next.catch(() => undefined); return next; }
    private run(job: Promise<unknown>): void { void job.catch(() => new Notice('Vault loss alarm could not save or read its local files. Check the plugin folder.')); }
    async onload(): Promise<void> {
        this.settings = normalizeSettings(await this.loadData() as Partial<VaultLossAlarmSettings> | null);
        await this.readBaseline();
        const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
        pro.init();
        this.pro = pro;
        bindPro(pro);
        this.tab = new VaultLossAlarmSettingTab(this.app, this);
        this.addSettingTab(this.tab);
        this.register(pro.onChange(() => this.tab?.update()));
        this.addCommand({ id: 'check-vault-now', name: 'Check vault now', callback: () => this.run(this.check(true)) });
        this.addCommand({ id: 'accept-current-vault-as-baseline', name: 'Accept current vault as baseline', callback: () => this.run(this.acceptBaseline()) });
        this.addCommand({ id: 'show-loss-report', name: 'Show loss report', callback: () => this.run(this.check(false, true)) });
        this.addCommand({ id: 'compare-manifest-dates', name: proLabel('Compare manifest dates'), callback: () => this.run(this.openHistory()) });
        this.addCommand({ id: 'write-restore-checklist', name: proLabel('Write restore checklist'), callback: () => this.run(this.writeChecklist(this.lastReport)) });
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.run(this.renameBaseline(file.path, oldPath))));
        this.registerEvent(this.app.vault.on('delete', (file) => this.recordDelete(file)));
        this.app.workspace.onLayoutReady(() => {
            if (this.stopped)
                return;
            const timer = window.setTimeout(() => { if (!this.stopped)
                this.run(this.check()); }, SETTLE_MS);
            this.register(() => window.clearTimeout(timer));
            this.registerInterval(window.setInterval(() => this.run(this.saveCurrent()), SAVE_MS));
            this.run(pro.refresh());
            this.registerInterval(window.setInterval(() => this.run(pro.refresh()), 6 * 60 * 60 * 1000));
        });
    }
    async readBaseline(): Promise<void> {
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(this.path('baseline.json'))) {
            this.baseline = null;
            return;
        }
        this.baseline = parseManifest(await adapter.read(this.path('baseline.json')));
        this.corrupt = !this.baseline;
    }
    async saveSettings(): Promise<void> { await this.saveData(this.settings); }
    private async storeCurrent(): Promise<Report> {
        const current = this.capture();
        const report = compare(this.baseline?.files ?? current.files, current.files);
        await this.app.vault.adapter.write(this.path('current.json'), JSON.stringify(current));
        if (this.baseline && hasLoss(report) && !this.baseline.held) {
            const held = { ...this.baseline, held: true };
            await this.app.vault.adapter.write(this.path('baseline.json'), JSON.stringify(held));
            this.baseline = held;
        }
        if (this.baseline?.held && report.added.length) {
            const merged = { ...this.baseline, files: snapshot([...this.baseline.files, ...report.added], this.baseline.savedAt).files };
            await this.app.vault.adapter.write(this.path('baseline.json'), JSON.stringify(merged));
            this.baseline = merged;
        }
        if (!this.baseline || (!this.baseline.held && !hasLoss(report))) {
            await this.app.vault.adapter.write(this.path('baseline.json'), JSON.stringify(current));
            this.baseline = current;
            if (this.corrupt) {
                new Notice('Manifest unreadable, new baseline saved');
                this.corrupt = false;
            }
        }
        this.lastReport = report;
        if (isPro())
            await this.trySaveHistory(current);
        return report;
    }
    saveCurrent(): Promise<Report> { return this.serial(() => this.storeCurrent()); }
    check(manual = false, show = false): Promise<Report> {
        return this.serial(async () => {
            const report = await this.storeCurrent();
            if (manual)
                new Notice(`Lost ${report.missing.length} files${report.empty.length ? `; now empty ${report.empty.length} notes` : ''}`);
            let rules: FolderRule[] = [];
            try {
                rules = isPro() ? parseFolderRules(this.settings.folderRules) : [];
            }
            catch {
                new Notice('Folder thresholds have invalid data. The vault thresholds still apply.');
            }
            if (!this.stopped && (show || shouldAlarm(report, { files: this.settings.fileThreshold, bytes: this.settings.byteThreshold }, rules)))
                this.showReport(report);
            return report;
        });
    }
    acceptBaseline(): Promise<void> {
        return this.serial(async () => {
            const current = this.capture();
            await this.app.vault.adapter.write(this.path('baseline.json'), JSON.stringify(current));
            await this.app.vault.adapter.write(this.path('current.json'), JSON.stringify(current));
            this.baseline = current;
            this.deletes = [];
            this.deletePending = false;
            this.lastReport = compare(current.files, current.files);
            this.alarm?.close();
            new Notice('Current vault accepted as baseline');
            if (isPro())
                await this.trySaveHistory(current);
        });
    }
    renameBaseline(newPath: string, oldPath: string): Promise<void> {
        return this.serial(async () => {
            if (!this.baseline)
                return;
            const moved = { ...this.baseline, files: movePaths(this.baseline.files, oldPath, newPath) };
            await this.app.vault.adapter.write(this.path('baseline.json'), JSON.stringify(moved));
            this.baseline = moved;
        });
    }
    recordDelete(file: TAbstractFile, now = Date.now()): void {
        if (this.stopped)
            return;
        const previous = this.baseline?.files.find((f) => f.path === file.path);
        this.deletes = rolling([...this.deletes, { path: file.path, size: file instanceof TFile ? file.stat.size : previous?.size ?? 0, mtime: file instanceof TFile ? file.stat.mtime : previous?.mtime ?? 0, at: now, isFile: file instanceof TFile }], now);
        if (this.deletes.length < this.settings.deleteThreshold)
            return;
        if (this.deleteTimer)
            this.deletePending = true;
        else
            this.raiseDeletes();
    }
    private raiseDeletes(): void {
        if (this.stopped)
            return;
        this.deletePending = false;
        this.deleteTimer = window.setTimeout(() => {
            this.deleteTimer = 0;
            if (this.deletePending)
                this.raiseDeletes();
        }, DELETE_REFRESH_MS);
        this.lastReport = deleteReport(this.deletes);
        this.showReport(this.lastReport, `${this.deletes.length} delete events in 10 minutes`);
        const deleted = this.deletes.filter((r) => r.isFile);
        this.run(this.serial(async () => {
            const baseline = this.baseline ?? this.capture();
            const entries = new Map(baseline.files.map((f) => [f.path, f]));
            for (const f of deleted) if (!entries.has(f.path)) entries.set(f.path, { path: f.path, size: f.size, mtime: f.mtime });
            const held = { ...baseline, files: [...entries.values()], held: true };
            await this.app.vault.adapter.write(this.path('baseline.json'), JSON.stringify(held));
            this.baseline = held;
        }));
    }
    showReport(report: Report, reason = 'Compared with the saved baseline'): void {
        this.alarm?.close();
        this.alarm = new LossModal(this, report, reason);
        this.alarm.open();
    }
    private async trySaveHistory(current: Manifest): Promise<void> {
        try { await this.saveHistory(current); }
        catch { new Notice('Could not save history. The core loss check still runs.'); }
    }
    private async saveHistory(current: Manifest): Promise<void> {
        if (!isPro())
            return;
        const adapter = this.app.vault.adapter;
        const dir = this.path('history');
        if (!await adapter.exists(dir))
            await adapter.mkdir(dir);
        await adapter.write(normalizePath(`${dir}/${current.savedAt}.json`), JSON.stringify(current));
        const dates = await this.historyDates();
        const keep = new Set(historyKeep(dates, current.savedAt));
        for (const d of dates)
            if (!keep.has(d))
                await adapter.remove(normalizePath(`${dir}/${d}.json`));
    }
    async historyDates(): Promise<number[]> {
        if (!isPro())
            return [];
        const dir = this.path('history');
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(dir))
            return [];
        return (await adapter.list(dir)).files.map((p) => /\/(\d+)\.json$/.exec(p)?.[1]).filter((p): p is string => !!p).map(Number).sort((a, b) => a - b);
    }
    async diffDates(before: number, after: number): Promise<Report | null> {
        if (!this.requirePro())
            return null;
        const read = async (date: number) => parseManifest(await this.app.vault.adapter.read(this.path(`history/${date}.json`)));
        const a = await read(before);
        const b = await read(after);
        if (!a || !b)
            throw new Error('Unreadable history');
        return compare(a.files, b.files);
    }
    async openHistory(): Promise<void> {
        if (!this.requirePro())
            return;
        const dates = historyWithin(await this.historyDates(), Date.now());
        this.historyModal?.close();
        this.historyModal = new HistoryModal(this, dates);
        this.historyModal.open();
    }
    requirePro(): boolean {
        if (isPro())
            return true;
        new Notice('This is a pro feature. Sponsor on GitHub, then sign in from the plugin settings.');
        return false;
    }
    async writeChecklist(report: Report): Promise<TFile | null> {
        if (!this.requirePro())
            return null;
        const base = `Vault restore checklist ${new Date().toISOString().replace(/[:.]/g, '-')}`;
        let path = normalizePath(`${base}.md`);
        for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++)
            path = normalizePath(`${base} ${i}.md`);
        const file = await this.app.vault.create(path, checklist(report));
        new Notice(`Restore checklist saved to ${file.path}`);
        return file;
    }
    onunload(): void {
        this.stopped = true;
        window.clearTimeout(this.deleteTimer);
        if (this.baseline)
            this.run(this.saveCurrent());
        this.alarm?.close();
        this.historyModal?.close();
        resetPro();
    }
}
