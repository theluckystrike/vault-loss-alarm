import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import type { SponsorsManager } from '../src/license/index';
import VaultLossAlarmPlugin, { DELETE_REFRESH_MS, SAVE_MS, SETTLE_MS } from '../src/main';
import { DEFAULT_SETTINGS, normalizeSettings, parseFolderRules } from '../src/settings';
import { bindPro, isPro, onProChange, resetPro, SPONSORS } from '../src/pro';
import { historyKeep, snapshot } from '../src/engine';
import manifest from '../manifest.json';
afterEach(() => { resetPro(); vi.useRealTimers(); });
function fixture(files: Record<string, string> = { 'Notes/a.md': 'A useful note' }) {
    const app = App.createConfigured__({ files });
    const plugin = new VaultLossAlarmPlugin(app as never, { ...manifest, dir: '.obsidian/plugins/vault-loss-alarm' } as never);
    const store = new Map<string, string>();
    app.vault.adapter.write = vi.fn(async (path: string, text: string) => { store.set(path, text); });
    app.vault.adapter.read = vi.fn(async (path: string) => { if (!store.has(path))
        throw new Error('Missing'); return store.get(path)!; });
    app.vault.adapter.exists = vi.fn(async (path: string) => store.has(path));
    app.vault.adapter.mkdir = vi.fn(async (path: string) => { store.set(path, ''); });
    app.vault.adapter.list = vi.fn(async (dir: string) => ({ files: [...store.keys()].filter((p) => p.startsWith(dir + '/')), folders: [] }));
    app.vault.adapter.remove = vi.fn(async (path: string) => { store.delete(path); });
    return { app, plugin, store };
}
function enablePro() { const manager = { isPro: () => true, onChange: () => () => undefined }; bindPro(manager as SponsorsManager); }
describe('stored baseline', () => {
    it('first run saves a manifest without an alarm', async () => {
        const { plugin, store } = fixture();
        const show = vi.spyOn(plugin, 'showReport');
        await plugin.check();
        expect(plugin.baseline?.files).toHaveLength(1);
        expect(show).not.toHaveBeenCalled();
        expect(store.has(plugin.path('baseline.json'))).toBe(true);
    });
    it('six missing paths trigger and survive save and restart', async () => {
        const { plugin, store } = fixture();
        plugin.baseline = snapshot([...plugin.capture().files, ...Array.from({ length: 6 }, (_, i) => ({ path: `Gone/${i}.md`, size: 1200, mtime: 1 }))], 1);
        store.set(plugin.path('baseline.json'), JSON.stringify(plugin.baseline));
        const show = vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        const report = await plugin.check();
        expect(report.missing).toHaveLength(6);
        expect(show).toHaveBeenCalledOnce();
        await plugin.saveCurrent();
        await plugin.readBaseline();
        expect((await plugin.check()).missing).toEqual(report.missing);
    });
    it('three small losses keep the baseline without a modal', async () => {
        const { plugin } = fixture();
        plugin.baseline = snapshot(Array.from({ length: 3 }, (_, i) => ({ path: `gone${i}.md`, size: 1, mtime: 1 })), 1);
        const show = vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        expect((await plugin.check(true)).missing.length).toBe(3);
        expect(show).not.toHaveBeenCalled();
        expect(plugin.baseline.files.map((f) => f.path)).toEqual(['Notes/a.md', 'gone0.md', 'gone1.md', 'gone2.md']);
    });
    it('accept clears losses and starts the next baseline', async () => {
        const { plugin } = fixture();
        plugin.baseline = snapshot([{ path: 'Gone.md', size: 1200, mtime: 1 }], 1);
        await plugin.acceptBaseline();
        expect((await plugin.check()).missing).toEqual([]);
    });
    it('rename keeps the baseline size and time', async () => {
        const { plugin } = fixture();
        plugin.baseline = snapshot([{ path: 'Old/a.md', size: 1200, mtime: 1 }], 1);
        await plugin.renameBaseline('New', 'Old');
        expect(plugin.baseline.files).toEqual([{ path: 'New/a.md', size: 1200, mtime: 1 }]);
    });
    it('corrupt JSON saves a clean baseline', async () => {
        const { plugin, store } = fixture();
        store.set(plugin.path('baseline.json'), '{bad');
        await plugin.readBaseline();
        await plugin.check();
        expect(JSON.parse(store.get(plugin.path('baseline.json'))!).files).toHaveLength(1);
    });
    it('empty note is retained through periodic save', async () => {
        const { plugin } = fixture({ 'Draft.md': '' });
        plugin.baseline = snapshot([{ path: 'Draft.md', size: 1200, mtime: 1 }], 1);
        vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        expect((await plugin.check()).empty[0]?.path).toBe('Draft.md');
        await plugin.saveCurrent();
        expect(plugin.baseline.files[0]?.size).toBe(1200);
    });
    it('write failure keeps the prior in-memory baseline', async () => {
        const { plugin, app } = fixture();
        plugin.baseline = snapshot([{ path: 'Notes/a.md', size: 5, mtime: 1 }], 1);
        app.vault.adapter.write = vi.fn(async () => { throw new Error('disk full'); });
        await expect(plugin.saveCurrent()).rejects.toThrow();
        expect(plugin.baseline.files[0]?.size).toBe(5);
    });
    it('concurrent acceptance and save leave a readable baseline', async () => {
        const { plugin, store } = fixture();
        await Promise.all([plugin.acceptBaseline(), plugin.saveCurrent(), plugin.acceptBaseline()]);
        expect(JSON.parse(store.get(plugin.path('baseline.json'))!)).toEqual(plugin.baseline);
    });
    it('15000 file save takes under two seconds and two MB', async () => {
        const { plugin, store } = fixture();
        vi.spyOn(plugin, 'capture').mockImplementation((now = Date.now()) => snapshot(Array.from({ length: 15000 }, (_, i) => ({ path: `Notes/${i}.md`, size: 1200, mtime: now })), now));
        const start = performance.now();
        await plugin.saveCurrent();
        expect(performance.now() - start).toBeLessThan(2000);
        expect(new TextEncoder().encode(store.get(plugin.path('current.json'))!).length).toBeLessThan(2000000);
    });
});
describe('delete events', () => {
    it('25 file delete events raise a report with 25 paths', async () => {
        vi.useFakeTimers();
        const { plugin, app } = fixture(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`Notes/${i}.md`, 'Keep in backup'])));
        const show = vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        for (const file of app.vault.getFiles())
            plugin.recordDelete(file as never, 100000);
        await vi.advanceTimersByTimeAsync(DELETE_REFRESH_MS);
        expect(show).toHaveBeenCalledTimes(2);
        expect(plugin.lastReport.missing).toHaveLength(25);
    });
    it('events older than ten minutes do not reach threshold', () => {
        const { plugin, app } = fixture();
        const file = app.vault.getFiles()[0]!;
        const show = vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        for (let i = 0; i < 19; i++)
            plugin.recordDelete(file as never, 0);
        plugin.recordDelete(file as never, 600000);
        expect(plugin.deletes).toHaveLength(1);
        expect(show).not.toHaveBeenCalled();
    });
});
describe('Pro checks', () => {
    it('blocks history and checklist without Pro', async () => { const { plugin } = fixture(); expect(await plugin.diffDates(1, 2)).toBeNull(); expect(await plugin.writeChecklist(plugin.lastReport)).toBeNull(); expect(await plugin.historyDates()).toEqual([]); });
    it('keeps date manifests and prunes older files', async () => {
        enablePro();
        const { plugin, store } = fixture();
        const old = plugin.path('history/1.json');
        store.set(old, '{}');
        await plugin.saveCurrent();
        expect(store.has(old)).toBe(false);
        const dates = await plugin.historyDates();
        expect(dates).toHaveLength(1);
        const current = plugin.capture();
        store.set(plugin.path(`history/${dates[0]! + 1}.json`), JSON.stringify({ ...current, savedAt: dates[0]! + 1, files: [] }));
        expect((await plugin.diffDates(dates[0]!, dates[0]! + 1))?.missing).toHaveLength(1);
    });
    it('ignores folder rules when Pro is off', async () => {
        const { plugin } = fixture();
        plugin.settings.folderRules = 'Work | 1 | 1000000';
        plugin.baseline = snapshot([{ path: 'Work/a.md', size: 1, mtime: 1 }], 1);
        const show = vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        await plugin.check();
        expect(show).not.toHaveBeenCalled();
        enablePro();
        await plugin.check();
        expect(show).toHaveBeenCalledOnce();
    });
    it('facade follows manager and removes its listener', () => {
        const cb = vi.fn();
        let listener = () => { };
        let active = false;
        const off = vi.fn();
        bindPro({ isPro: () => active, onChange: (fn: () => void) => { listener = fn; return off; } } as SponsorsManager);
        const unsub = onProChange(cb);
        active = true;
        listener();
        expect(isPro()).toBe(true);
        expect(cb).toHaveBeenCalledOnce();
        unsub();
        resetPro();
        expect(off).toHaveBeenCalledOnce();
    });
});
describe('settings and constants', () => {
    it('repairs invalid saved settings', () => { expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS); expect(normalizeSettings({ fileThreshold: NaN, byteThreshold: 'x' as never, deleteThreshold: -2 })).toEqual({ ...DEFAULT_SETTINGS, deleteThreshold: 1 }); });
    it('validates folder rules', () => { expect(parseFolderRules('Work | 2 | 500')).toEqual([{ folder: 'Work', files: 2, bytes: 500 }]); expect(() => parseFolderRules('Work | 0 | 500')).toThrow(); });
    it('uses required delay, save interval and sponsor terms', () => { expect(SETTLE_MS).toBe(60000); expect(SAVE_MS).toBe(1800000); expect(SPONSORS).toMatchObject({ clientId: 'Ov23lic5UPGPZqhBlBGg', minMonthlyUsd: 5, oneTimeUsd: 15, scope: 'read:user' }); });
});


describe('baseline retention after an alarm', () => {
    it('keeps the old metadata after files return until acceptance', async () => {
        const { plugin } = fixture();
        const original = snapshot([{ path: 'Notes/a.md', size: 1200, mtime: 1 }], 1);
        plugin.baseline = original;
        vi.spyOn(plugin, 'capture').mockReturnValueOnce(snapshot([], 2));
        vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        await plugin.check();
        expect(plugin.baseline?.held).toBe(true);
        await plugin.saveCurrent();
        expect(plugin.baseline?.files).toEqual(original.files);
        await plugin.acceptBaseline();
        expect(plugin.baseline?.held).toBeUndefined();
    });
    it('keeps delete-event paths that were created after the last manifest', async () => {
        vi.useFakeTimers();
        const { plugin, app } = fixture(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`New/${i}.md`, 'New sample'])));
        plugin.baseline = snapshot([], 1);
        vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        for (const file of app.vault.getFiles()) plugin.recordDelete(file as never, 100000);
        await vi.advanceTimersByTimeAsync(DELETE_REFRESH_MS);
        vi.spyOn(plugin, 'capture').mockReturnValue(snapshot([], 2));
        await plugin.saveCurrent();
        await plugin.readBaseline();
        expect(plugin.baseline?.held).toBe(true);
        expect((await plugin.check()).missing).toHaveLength(25);
    });
    it('a history write failure does not stop the core alarm', async () => {
        enablePro();
        const { plugin, app } = fixture();
        plugin.baseline = snapshot(Array.from({ length: 6 }, (_, i) => ({ path: `Missing/${i}.md`, size: 1200, mtime: 1 })), 1);
        const write = app.vault.adapter.write;
        app.vault.adapter.write = vi.fn(async (path: string, text: string) => {
            if (path.includes('/history/')) throw new Error('History disk error');
            await write(path, text);
        });
        const show = vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        expect((await plugin.check()).missing).toHaveLength(6);
        expect(show).toHaveBeenCalledOnce();
    });
});
describe('review defects', () => {
    it('a held baseline still protects files created after the hold', async () => {
        const { plugin } = fixture();
        plugin.baseline = { ...snapshot([...plugin.capture().files, { path: 'Old.md', size: 10, mtime: 1 }], 1), held: true };
        const fresh = Array.from({ length: 10 }, (_, i) => ({ path: `Later/${i}.md`, size: 500, mtime: 2 }));
        vi.spyOn(plugin, 'capture').mockReturnValueOnce(snapshot([...plugin.capture().files, ...fresh], 2));
        await plugin.saveCurrent();
        const show = vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        const report = await plugin.check();
        expect(report.missing.map((f) => f.path)).toEqual(['Old.md', ...fresh.map((f) => f.path)].sort());
        expect(show).toHaveBeenCalledOnce();
    });
    it('a 2000 file delete storm opens the report and writes the baseline a few times only', async () => {
        vi.useFakeTimers();
        const { plugin, app } = fixture(Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`Big/${i}.png`, 'x'])));
        plugin.baseline = plugin.capture(1);
        const show = vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        for (const file of app.vault.getFiles()) plugin.recordDelete(file as never, 100000);
        await vi.advanceTimersByTimeAsync(2000);
        expect(show.mock.calls.length).toBeLessThanOrEqual(2);
        expect(vi.mocked(app.vault.adapter.write).mock.calls.filter(([p]) => p === plugin.path('baseline.json')).length).toBeLessThanOrEqual(3);
        expect(plugin.lastReport.missing.length).toBeGreaterThanOrEqual(2000);
    });
});
describe('history size', () => {
    it('keeps each save from the last day and one manifest a day before that', () => {
        const day = 24 * 60 * 60 * 1000, now = 40 * day;
        const dates = Array.from({ length: 1440 }, (_, i) => now - i * 30 * 60 * 1000);
        const kept = historyKeep(dates, now);
        expect(kept.length).toBeLessThanOrEqual(49 + 30);
        expect(kept).toContain(now);
        expect(kept).toContain(now - 30 * 60 * 1000);
        expect(Math.min(...kept)).toBeGreaterThanOrEqual(now - 30 * day);
    });
});
describe('audit defects', () => {
    it('a rename onto a held missing path keeps a readable held baseline', async () => {
        const { plugin, store } = fixture({ 'A.md': 'Restored copy' });
        plugin.baseline = { ...snapshot([{ path: 'A.md', size: 1200, mtime: 1 }, { path: 'B.md', size: 13, mtime: 2 }], 1), held: true };
        await plugin.renameBaseline('A.md', 'B.md');
        expect(plugin.baseline?.files).toEqual([{ path: 'A.md', size: 13, mtime: 2 }]);
        await plugin.readBaseline();
        expect(plugin.baseline?.held).toBe(true);
        expect(store.get(plugin.path('baseline.json'))).toBe(JSON.stringify(plugin.baseline));
    });
    it('accept during a delete refresh does not hold the new baseline again', async () => {
        vi.useFakeTimers();
        const { plugin, app } = fixture(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`Notes/${i}.md`, 'Keep in backup'])));
        const show = vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
        for (const file of app.vault.getFiles()) plugin.recordDelete(file as never, 100000);
        await plugin.acceptBaseline();
        await vi.advanceTimersByTimeAsync(DELETE_REFRESH_MS);
        expect(show).toHaveBeenCalledOnce();
        expect(plugin.baseline?.held).toBeUndefined();
    });
});
