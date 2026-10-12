export interface Entry {
    path: string;
    size: number;
    mtime: number;
}
export interface Manifest {
    version: 1;
    savedAt: number;
    files: Entry[];
    held?: boolean;
}
export interface Threshold {
    files: number;
    bytes: number;
}
export interface FolderRule extends Threshold {
    folder: string;
}
export interface Report {
    missing: Entry[];
    empty: Entry[];
    added: Entry[];
    changed: Entry[];
    bytes: number;
}
export interface DeleteRecord extends Entry {
    at: number;
    isFile?: boolean;
}
export const DEFAULT_THRESHOLD: Threshold = { files: 5, bytes: 1000000 };
export const WINDOW_MS = 10 * 60 * 1000;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export function snapshot(files: Entry[], now: number): Manifest {
    return { version: 1, savedAt: now, files: files.map(({ path, size, mtime }) => ({ path, size, mtime })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
export function parseManifest(text: string): Manifest | null {
    try {
        const v = JSON.parse(text) as Partial<Manifest>;
        if (!v || v.version !== 1 || !Number.isFinite(v.savedAt) || !Array.isArray(v.files) || (v.held !== undefined && typeof v.held !== 'boolean'))
            return null;
        const paths = new Set<string>();
        for (const f of v.files) {
            if (!f || typeof f.path !== 'string' || !f.path || f.path.startsWith('/') || f.path.split('/').some((p) => p === '..' || p === '.' || !p) || !Number.isFinite(f.size) || f.size < 0 || !Number.isFinite(f.mtime) || paths.has(f.path))
                return null;
            paths.add(f.path);
        }
        return v as Manifest;
    }
    catch {
        return null;
    }
}
export function compare(before: Entry[], after: Entry[]): Report {
    const old = new Map(before.map((f) => [f.path, f]));
    const current = new Map(after.map((f) => [f.path, f]));
    const missing = before.filter((f) => !current.has(f.path));
    const empty = before.filter((f) => f.path.toLowerCase().endsWith('.md') && f.size > 0 && current.get(f.path)?.size === 0);
    const added = after.filter((f) => !old.has(f.path));
    const changed = after.filter((f) => { const prev = old.get(f.path); return prev && (prev.size !== f.size || prev.mtime !== f.mtime); });
    return { missing, empty, added, changed, bytes: missing.reduce((n, f) => n + f.size, 0) };
}
export function hasLoss(report: Report): boolean { return report.missing.length > 0 || report.empty.length > 0; }
export function reachesThreshold(files: Entry[], threshold: Threshold): boolean {
    return files.length > 0 && (files.length >= threshold.files || files.reduce((n, f) => n + f.size, 0) >= threshold.bytes);
}
export function shouldAlarm(report: Report, threshold: Threshold, rules: FolderRule[] = []): boolean {
    return report.empty.length > 0 || reachesThreshold(report.missing, threshold) || rules.some((r) => reachesThreshold(report.missing.filter((f) => f.path.startsWith(r.folder + '/')), r));
}
export function movePaths(files: Entry[], oldPath: string, newPath: string): Entry[] {
    const inside = (path: string) => path === oldPath || path.startsWith(oldPath + '/');
    const moved = files.filter((f) => inside(f.path)).map((f) => ({ ...f, path: newPath + f.path.slice(oldPath.length) }));
    // A moved entry replaces an old entry at the same path, so the manifest keeps unique paths.
    const taken = new Set(moved.map((f) => f.path));
    return [...files.filter((f) => !inside(f.path) && !taken.has(f.path)).map((f) => ({ ...f })), ...moved].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function rolling(records: DeleteRecord[], now: number): DeleteRecord[] {
    return records.filter((r) => r.at > now - WINDOW_MS && r.at <= now);
}
export function deleteReport(records: DeleteRecord[]): Report {
    const files = [...new Map(records.map((r) => [r.path, { path: r.path, size: r.size, mtime: r.mtime }])).values()];
    return { missing: files, empty: [], added: [], changed: [], bytes: files.reduce((n, f) => n + f.size, 0) };
}
export function historyWithin(dates: number[], now: number): number[] {
    return dates.filter((d) => Number.isFinite(d) && d >= now - RETENTION_MS && d <= now).sort((a, b) => a - b);
}
export function historyKeep(dates: number[], now: number): number[] {
    const day = 24 * 60 * 60 * 1000;
    const latest = new Map<number, number>();
    for (const d of historyWithin(dates, now))
        latest.set(d >= now - day ? d : Math.floor(d / day), d);
    return [...latest.values()].sort((a, b) => a - b);
}
export function checklist(report: Report): string {
    const line = (f: Entry) => `- [ ] ${f.path.replace(/[\\`*_[\]<>\n\r]/g, (c) => '\\' + c)} — ${f.size} bytes`;
    return ['# Vault restore checklist', '', 'Check your backup before you accept a new baseline.', '', '## Missing', ...report.missing.map(line), '', '## Now empty', ...report.empty.map(line), ''].join('\n');
}
