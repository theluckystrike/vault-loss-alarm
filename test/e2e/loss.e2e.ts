import { browser, expect } from '@wdio/globals';
import type VaultLossAlarmPlugin from '../../src/main';
import { pluginId } from './load';
type PluginMap = {
    plugins: Record<string, VaultLossAlarmPlugin>;
    disablePlugin(id: string): Promise<void>;
    enablePlugin(id: string): Promise<boolean>;
};
async function scenario(name: string): Promise<Record<string, unknown>> {
    return browser.executeObsidian(async ({ app }, id, task) => {
        const plugins = (app as unknown as {
            plugins: PluginMap;
        }).plugins;
        let p = plugins.plugins[id];
        p.alarm?.close();
        p.pro?.signOut();
        p.settings = { fileThreshold: 5, byteThreshold: 1000000, deleteThreshold: 20, folderRules: '' };
        const folder = app.vault.getAbstractFileByPath('Loss tests');
        if (folder)
            await app.vault.delete(folder, true);
        await app.vault.createFolder('Loss tests');
        await p.acceptBaseline();
        const create = async (n: number) => { const files = []; for (let i = 0; i < n; i++)
            files.push(await app.vault.create(`Loss tests/n${i}.md`, 'x'.repeat(1200))); await p.acceptBaseline(); return files; };
        if (task === 'first') {
            await app.vault.adapter.remove(p.path('baseline.json'));
            await p.readBaseline();
            await p.check();
            return { alarm: !!p.alarm, saved: await app.vault.adapter.exists(p.path('baseline.json')) };
        }
        if (task === 'startup') {
            const files = await create(100);
            const old = p;
            await plugins.disablePlugin(id);
            await old.saveCurrent();
            for (const f of files.slice(0, 6))
                await app.vault.delete(f, true);
            const original = window.setTimeout;
            let startup: (() => void) | undefined;
            let delay = 0;
            window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => { if (ms === 60000 && typeof callback === 'function') {
                startup = callback as () => void;
                delay = ms;
                return 0;
            } return original(callback, ms, ...args); }) as typeof window.setTimeout;
            try {
                await plugins.enablePlugin(id);
                p = plugins.plugins[id];
                const before = !!p.alarm;
                if (!startup)
                    throw new Error('No startup check');
                startup();
                await p.check();
                return { delay, before, paths: p.lastReport.missing.map(f => f.path), sizes: p.lastReport.missing.map(f => f.size), text: p.alarm?.contentEl.textContent };
            }
            finally {
                window.setTimeout = original;
            }
        }
        if (task === 'small') {
            for (const f of await create(3))
                await app.vault.delete(f, true);
            await p.check(true);
            return { alarm: !!p.alarm, notices: [...document.querySelectorAll('.notice')].map(el => el.textContent) };
        }
        if (task === 'rename') {
            await app.vault.createFolder('Loss tests/Old');
            const f = await app.vault.create('Loss tests/Old/a.md', 'Content');
            await p.acceptBaseline();
            await app.vault.rename(f, 'Loss tests/Old/b.md');
            await p.saveCurrent();
            await app.vault.rename(app.vault.getAbstractFileByPath('Loss tests/Old')!, 'Loss tests/New');
            await p.saveCurrent();
            return { missing: (await p.check()).missing, path: p.baseline?.files.find(f => f.path === 'Loss tests/New/b.md')?.path };
        }
        if (task === 'events') {
            for (const f of await create(25))
                await app.vault.delete(f, true);
            await new Promise(r => window.setTimeout(r, 1100));
            return { count: p.deletes.length, rows: p.lastReport.missing.length, text: p.alarm?.contentEl.textContent };
        }
        if (task === 'empty') {
            const [f] = await create(1);
            await app.vault.modify(f, '');
            await p.check();
            return { empty: p.lastReport.empty.map(f => [f.path, f.size]), text: p.alarm?.contentEl.textContent };
        }
        if (task === 'restart') {
            for (const f of await create(6))
                await app.vault.delete(f, true);
            await p.check();
            const old = p;
            await plugins.disablePlugin(id);
            await old.saveCurrent();
            await plugins.enablePlugin(id);
            p = plugins.plugins[id];
            await p.check();
            const persisted = p.lastReport.missing.length;
            const alarm = !!p.alarm;
            await p.acceptBaseline();
            await p.check();
            return { persisted, alarm, missing: p.lastReport.missing.length, cleared: !p.alarm };
        }
        if (task === 'corrupt') {
            await app.vault.adapter.write(p.path('baseline.json'), '{corrupt');
            await p.readBaseline();
            await p.check();
            return { version: JSON.parse(await app.vault.adapter.read(p.path('baseline.json'))).version, notices: [...document.querySelectorAll('.notice')].map(el => el.textContent), alarm: !!p.alarm };
        }
        if (task === 'free') {
            return { checklist: await p.writeChecklist(p.lastReport), diff: await p.diffDates(1, 2), history: await p.historyDates() };
        }
        if (task === 'pro') {
            if (!p.pro)
                throw new Error('Missing Sponsors manager');
            p.pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
            app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36));
            await p.pro.refreshNow();
            const [f] = await create(1);
            const dates = await p.historyDates();
            const before = dates[dates.length - 1];
            await app.vault.delete(f, true);
            p.settings.folderRules = 'Loss tests | 1 | 1000000';
            await p.check();
            const folderAlarm = !!p.alarm;
            const note = await p.writeChecklist(p.lastReport);
            const content = note ? await app.vault.read(note) : '';
            await app.vault.adapter.write(p.path(`history/${before + 1}.json`), JSON.stringify(p.capture(before + 1)));
            const diff = await p.diffDates(before, before + 1);
            p.pro.signOut();
            return { folderAlarm, content, missing: diff?.missing.map(f => f.path), blocked: await p.writeChecklist(p.lastReport) };
        }
        if (task === 'restored') {
            const [f] = await create(1);
            const before = p.baseline!.files.find(entry => entry.path === f.path)!;
            await app.vault.modify(f, '');
            await p.check();
            await app.vault.modify(f, 'Restored note text');
            await p.saveCurrent();
            const kept = p.baseline!.files.find(entry => entry.path === f.path)!;
            const held = p.baseline!.held;
            await p.acceptBaseline();
            return { held, originalSize: before.size, keptSize: kept.size, keptTime: kept.mtime === before.mtime, released: !p.baseline!.held };
        }
        if (task === 'new-events') {
            const files = [];
            for (let i = 0; i < 25; i++) files.push(await app.vault.create(`Loss tests/new${i}.md`, 'New note'));
            for (const f of files) await app.vault.delete(f, true);
            await new Promise(r => window.setTimeout(r, 1100));
            await p.saveCurrent();
            await p.readBaseline();
            const report = await p.check();
            return { missing: report.missing.length, held: p.baseline?.held };
        }
        if (task === 'large') {
            const original = p.capture.bind(p);
            const files = Array.from({ length: 15000 }, (_, i) => ({ path: `Perf/${i}.md`, size: 1200, mtime: 1 }));
            p.capture = (now = Date.now()) => ({ version: 1, savedAt: now, files });
            p.baseline = null;
            try {
                const start = performance.now();
                await p.saveCurrent();
                const ms = performance.now() - start;
                const text = await app.vault.adapter.read(p.path('current.json'));
                return { ms, bytes: new TextEncoder().encode(text).length, count: JSON.parse(text).files.length };
            }
            finally {
                p.capture = original;
                await p.acceptBaseline();
            }
        }
        throw new Error('Unknown scenario');
    }, pluginId, name);
}
describe('Vault loss checks in the app', function () {
    it('first run saves without an alarm', async () => { expect(await scenario('first')).toEqual({ alarm: false, saved: true }); });
    it('checks six missing paths after the scheduled startup delay', async () => { const r = await scenario('startup'); expect(r.delay).toBe(60000); expect(r.before).toBe(false); expect(r.paths).toHaveLength(6); expect(r.sizes).toEqual([1200, 1200, 1200, 1200, 1200, 1200]); expect(r.text).toContain('Loss tests/n5.md'); });
    it('three small losses show a Notice without a modal', async () => { const r = await scenario('small'); expect(r.alarm).toBe(false); expect(r.notices).toContain('Lost 3 files'); });
    it('note and folder renames move baseline paths', async () => { expect(await scenario('rename')).toEqual({ missing: [], path: 'Loss tests/New/b.md' }); });
    it('lists 25 real delete events', async () => { const r = await scenario('events'); expect(r.count).toBe(25); expect(r.rows).toBe(25); expect(r.text).toContain('Loss tests/n24.md'); });
    it('finds a 1200 byte note that becomes empty', async () => { const r = await scenario('empty'); expect(r.empty).toEqual([['Loss tests/n0.md', 1200]]); expect(r.text).toContain('Now empty'); });
    it('keeps loss through reload until acceptance', async () => { expect(await scenario('restart')).toEqual({ persisted: 6, alarm: true, missing: 0, cleared: true }); });
    it('repairs corrupt JSON with the exact Notice', async () => { const r = await scenario('corrupt'); expect(r.version).toBe(1); expect(r.alarm).toBe(false); expect(r.notices).toContain('Manifest unreadable, new baseline saved'); });
    it('blocks paid actions without a sponsorship', async () => { expect(await scenario('free')).toEqual({ checklist: null, diff: null, history: [] }); });
    it('checks folder rules, history and checklist with a stubbed Sponsors answer', async () => { const r = await scenario('pro'); expect(r.folderAlarm).toBe(true); expect(r.content).toContain('- [ ] Loss tests/n0.md'); expect(r.missing).toContain('Loss tests/n0.md'); expect(r.blocked).toBeNull(); });
    it('keeps the alarm baseline after an empty note is restored', async () => { const r = await scenario('restored'); expect(r).toEqual({ held: true, originalSize: 1200, keptSize: 1200, keptTime: true, released: true }); });
    it('keeps deleted files created after the last manifest', async () => { expect(await scenario('new-events')).toEqual({ missing: 25, held: true }); });
    it('saves 15000 entries to the real disk adapter in less than two seconds', async () => { const r = await scenario('large'); expect(r.count).toBe(15000); expect(r.bytes).toBeLessThan(2000000); expect(r.ms).toBeLessThan(2000); });
});
