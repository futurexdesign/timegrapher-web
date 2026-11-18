/** Tests for the pure pipeline layout. */
import { describe, expect, it } from 'vitest';
import { STATIC_PIPELINE } from './dspMeta';
import { assignColumns, layoutPipeline } from './pipelineLayout';

describe('assignColumns', () => {
  it('uses the longest path from input', () => {
    const c = assignColumns(STATIC_PIPELINE);
    expect(c.get('input')).toBe(0);
    expect(c.get('notch')).toBe(1);
    expect(c.get('limiter')).toBe(7);
    expect(c.get('usb')).toBe(9);
    expect(c.get('eventDetect')).toBe(2);
    expect(c.get('beatRate')).toBe(3);
    // post-limiter tap sits after the limiter
    expect(c.get('levelMeter')).toBe(8);
  });

  it('survives cycles and unknown inputs', () => {
    const c = assignColumns([
      { key: 'a', group: 'process', order: 0, inputs: ['b', 'zzz'] },
      { key: 'b', group: 'process', order: 1, inputs: ['a'] },
    ]);
    expect(c.size).toBe(2);
  });
});

describe('layoutPipeline', () => {
  it('puts the chain on row 0 and taps below, with no overlaps', () => {
    const l = layoutPipeline(STATIC_PIPELINE);
    const by = new Map(l.nodes.map((n) => [n.key, n]));
    expect(by.get('agc')?.row).toBe(0);
    expect(by.get('spectrum')?.row).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const n of l.nodes) {
      const id = `${n.band}:${n.col}:${n.row}`;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(l.edges.length).toBe(STATIC_PIPELINE.reduce((s, n) => s + n.inputs.length, 0));
    expect(l.bypassAnchor).not.toBeNull();
  });

  it('places the quartz node on its own last row', () => {
    const l = layoutPipeline([
      ...STATIC_PIPELINE,
      { key: 'quartz', group: 'quartz', order: 0, inputs: ['input'] },
    ]);
    const q = l.nodes.find((n) => n.key === 'quartz');
    const maxOther = Math.max(...l.nodes.filter((n) => n.key !== 'quartz').map((n) => n.row));
    expect(q?.row).toBe(maxOther + 1);
  });

  it('wraps columns into bands and stays within width', () => {
    const l = layoutPipeline(STATIC_PIPELINE, { columnsPerBand: 4 });
    expect(Math.max(...l.nodes.map((n) => n.band))).toBeGreaterThan(0);
    for (const n of l.nodes) expect(n.x + n.w).toBeLessThanOrEqual(l.width);
    for (const n of l.nodes) expect(n.y + n.h).toBeLessThanOrEqual(l.height);
  });

  it('handles an empty pipeline', () => {
    const l = layoutPipeline([]);
    expect(l.nodes).toEqual([]);
    expect(l.bypassAnchor).toBeNull();
  });
});

/** Axis-aligned segments of an `M x y L x y ...` path. */
function segments(d: string): [number, number, number, number][] {
  const pts = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const out: [number, number, number, number][] = [];
  for (let i = 2; i + 1 < pts.length; i += 2) {
    out.push([pts[i - 2] ?? 0, pts[i - 1] ?? 0, pts[i] ?? 0, pts[i + 1] ?? 0]);
  }
  return out;
}

describe('edge routing', () => {
  for (const cpb of [10, 4]) {
    it(`no edge segment crosses a node (columnsPerBand ${cpb})`, () => {
      const l = layoutPipeline(
        [...STATIC_PIPELINE, { key: 'quartz', group: 'quartz', order: 0, inputs: ['input'] }],
        { columnsPerBand: cpb },
      );
      for (const e of l.edges) {
        for (const [x1, y1, x2, y2] of segments(e.path)) {
          const [lx, hx] = [Math.min(x1, x2), Math.max(x1, x2)];
          const [ly, hy] = [Math.min(y1, y2), Math.max(y1, y2)];
          for (const n of l.nodes) {
            // Allow touching the endpoints' own borders; forbid passing through interiors.
            const inside =
              hx > n.x + 0.5 && lx < n.x + n.w - 0.5 && hy > n.y + 0.5 && ly < n.y + n.h - 0.5;
            expect(inside, `${e.from}>${e.to} crosses ${n.key}`).toBe(false);
          }
        }
      }
    });
  }

  it('provides a bypass arc above the chain', () => {
    const l = layoutPipeline(STATIC_PIPELINE);
    expect(l.bypassPath).not.toBeNull();
    const top = Math.min(...l.nodes.map((n) => n.y));
    expect(l.bypassAnchor?.y).toBeLessThan(top);
  });
});
