import { describe, expect, it } from 'vitest';
import vectors from './vectors/vault-loss-alarm.json';
import * as engine from '../src/engine';
describe('golden acceptance vectors', () => {
    it('has at least twenty cases', () => expect(vectors.cases.length).toBeGreaterThanOrEqual(20));
    for (const c of vectors.cases)
        it(c.name, () => {
            if (c.function === 'largeSnapshot') {
                const [count, now] = c.args as number[];
                const data = engine.snapshot(Array.from({ length: count! }, (_, i) => ({ path: `Notes/${String(i).padStart(5, '0')}.md`, size: 1200, mtime: now! })), now!);
                expect({ count: data.files.length, under2MB: new TextEncoder().encode(JSON.stringify(data)).length < 2000000, first: data.files[0]!.path, last: data.files.at(-1)!.path }).toEqual(c.expected);
            }
            else {
                const fn = (engine as unknown as Record<string, (...args: unknown[]) => unknown>)[c.function]!;
                expect(fn(...c.args)).toEqual(c.expected);
            }
        });
});
