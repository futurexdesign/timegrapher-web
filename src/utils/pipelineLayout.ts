/**
 * Pure layout of the DSP data-flow graph (`caps.pipeline`) for the SVG
 * diagram. Columns are assigned by longest path from the source nodes, rows
 * by node kind (the process chain and sinks on row 0, analysis taps stacked
 * below, quartz last). Columns can be wrapped into bands so the diagram stays
 * legible at phone width. No DOM or Vue dependencies.
 */
import type { PipelineNode } from '@/protocol/types';

/** Geometry options (all in SVG user units). */
export interface LayoutOptions {
  /** Columns per band before wrapping onto a new band (default 10). */
  columnsPerBand?: number;
  /** Node width (default 88). */
  nodeW?: number;
  /** Node height (default 34). */
  nodeH?: number;
  /** Horizontal gap between columns (default 22). */
  gapX?: number;
  /** Vertical gap between rows (default 16). */
  gapY?: number;
  /** Extra vertical gap between bands (default 28). */
  bandGap?: number;
  /** Margin around the drawing (default 14). */
  margin?: number;
}

/** A positioned node. */
export interface LayoutNode {
  /** Node key. */
  key: string;
  /** Pipeline group. */
  group: PipelineNode['group'];
  /** Column (longest path from a source). */
  col: number;
  /** Row within its band (0 = main chain). */
  row: number;
  /** Band index (wrapped column groups). */
  band: number;
  /** Top-left x. */
  x: number;
  /** Top-left y. */
  y: number;
  /** Width. */
  w: number;
  /** Height. */
  h: number;
}

/** A directed edge. */
export interface LayoutEdge {
  /** Source node key. */
  from: string;
  /** Target node key. */
  to: string;
  /** SVG path `d` from the source to the target (arrow at the target end). */
  path: string;
}

/** Result of {@link layoutPipeline}. */
export interface PipelineLayout {
  /** Positioned nodes. */
  nodes: LayoutNode[];
  /** Edges between nodes present in the layout. */
  edges: LayoutEdge[];
  /** Drawing width (viewBox). */
  width: number;
  /** Drawing height (viewBox). */
  height: number;
  /** Centre of the master bypass switch (on the bypass arc), or `null` without a process chain. */
  bypassAnchor: { x: number; y: number } | null;
  /** SVG path of the bypass arc (source over the process chain to the first sink), or `null`. */
  bypassPath: string | null;
}

/**
 * Assigns each node the length of the longest path from a node without inputs.
 * Inputs that are not in the node list are ignored; cycles are broken (a node
 * on the current DFS stack contributes 0) so malformed input cannot hang.
 * @param nodes Pipeline nodes.
 * @returns Column by node key.
 */
export function assignColumns(nodes: readonly PipelineNode[]): Map<string, number> {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (key: string): number => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return -1;
    visiting.add(key);
    let d = 0;
    for (const inp of byKey.get(key)?.inputs ?? []) {
      if (!byKey.has(inp)) continue;
      d = Math.max(d, depth(inp) + 1);
    }
    visiting.delete(key);
    memo.set(key, d);
    return d;
  };
  for (const n of nodes) depth(n.key);
  return memo;
}

/**
 * Computes node positions and edge paths.
 * @param pipeline `caps.pipeline` (or the static fallback).
 * @param opts Geometry options.
 */
export function layoutPipeline(
  pipeline: readonly PipelineNode[],
  opts: LayoutOptions = {},
): PipelineLayout {
  const perBand = Math.max(1, opts.columnsPerBand ?? 10);
  const w = opts.nodeW ?? 88;
  const h = opts.nodeH ?? 34;
  const gapX = opts.gapX ?? 22;
  const gapY = opts.gapY ?? 20;
  const bandGap = opts.bandGap ?? 28;
  const margin = opts.margin ?? 14;
  const topPad = 26; // room for the bypass arc and switch above the chain

  const cols = assignColumns(pipeline);

  // Rows: chain-like nodes on row 0, analysis stacked per column, quartz last.
  const rowOf = new Map<string, number>();
  const analysisByCol = new Map<number, PipelineNode[]>();
  let maxAnalysisRow = 0;
  for (const n of pipeline) {
    if (n.group === 'analysis') {
      const c = cols.get(n.key) ?? 0;
      const list = analysisByCol.get(c) ?? [];
      list.push(n);
      analysisByCol.set(c, list);
    } else if (n.group !== 'quartz') {
      rowOf.set(n.key, 0);
    }
  }
  for (const list of analysisByCol.values()) {
    list.sort((a, b) => a.order - b.order);
    list.forEach((n, i) => {
      rowOf.set(n.key, i + 1);
      maxAnalysisRow = Math.max(maxAnalysisRow, i + 1);
    });
  }
  for (const n of pipeline) {
    if (n.group === 'quartz') rowOf.set(n.key, maxAnalysisRow + 1);
  }

  // Band geometry.
  const bandCount = Math.max(1, Math.floor(Math.max(0, ...cols.values()) / perBand) + 1);
  const bandRows: number[] = Array.from({ length: bandCount }, () => 0);
  for (const n of pipeline) {
    const band = Math.floor((cols.get(n.key) ?? 0) / perBand);
    bandRows[band] = Math.max(bandRows[band] ?? 0, (rowOf.get(n.key) ?? 0) + 1);
  }
  const bandTop: number[] = [];
  let y = margin + topPad;
  for (let b = 0; b < bandCount; b++) {
    bandTop.push(y);
    y += (bandRows[b] ?? 1) * (h + gapY) - gapY + bandGap;
  }
  const bandBottom = bandTop.map((t, b) => t + (bandRows[b] ?? 1) * (h + gapY) - gapY);
  const lastBottom = bandBottom[bandCount - 1] ?? margin;
  const height = lastBottom + 8 + 12 + margin; // room for the bottom lane
  const usedCols = Math.min(perBand, Math.max(0, ...cols.values()) + 1);
  const width = margin * 2 + usedCols * w + (usedCols - 1) * gapX;

  const nodes: LayoutNode[] = pipeline.map((n) => {
    const col = cols.get(n.key) ?? 0;
    const band = Math.floor(col / perBand);
    const row = rowOf.get(n.key) ?? 0;
    return {
      key: n.key,
      group: n.group,
      col,
      row,
      band,
      x: margin + (col % perBand) * (w + gapX),
      y: (bandTop[band] ?? 0) + row * (h + gapY),
      w,
      h,
    };
  });
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  const ctx: RouteCtx = { perBand, gapX, margin, width, bandTop, bandBottom, bandGap };
  const edges: LayoutEdge[] = [];
  for (const n of pipeline) {
    const to = byKey.get(n.key);
    if (!to) continue;
    for (const inp of n.inputs) {
      const from = byKey.get(inp);
      if (!from) continue;
      edges.push({ from: from.key, to: to.key, path: edgePath(from, to, ctx) });
    }
  }

  // Bypass arc: over the process chain from the source to the first sink.
  let bypassAnchor: PipelineLayout['bypassAnchor'] = null;
  let bypassPath: string | null = null;
  const procNodes = pipeline.filter((n) => n.group === 'process');
  const src = pipeline.find((n) => n.group === 'source');
  const sink = nodes.filter((n) => n.group === 'sink').sort((a, b) => a.col - b.col)[0];
  const srcNode = src ? byKey.get(src.key) : undefined;
  if (procNodes.length > 0 && srcNode) {
    const ay = srcNode.y - 13;
    const x1 = srcNode.x + srcNode.w / 2;
    if (sink && srcNode.band === sink.band) {
      const x2 = sink.x + sink.w / 2;
      bypassPath = `M${x1} ${srcNode.y} L${x1} ${ay} L${x2} ${ay} L${x2} ${sink.y}`;
      bypassAnchor = { x: (x1 + x2) / 2, y: ay };
    } else {
      // Wrapped layout: no room for the arc, keep the switch above the source.
      bypassAnchor = { x: x1 + 10, y: ay };
    }
  }

  return { nodes, edges, width, height, bypassAnchor, bypassPath };
}

/** Geometry shared by the edge router. */
interface RouteCtx {
  perBand: number;
  gapX: number;
  margin: number;
  width: number;
  bandTop: number[];
  bandBottom: number[];
  bandGap: number;
}

/** Orthogonal polyline path through points. */
function poly(pts: [number, number][]): string {
  return pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
}

/**
 * Orthogonal edge router that keeps segments in the gaps between nodes:
 * - taps from a source node go down a trunk under the source, along the
 *   channel above the target row, then into the target's top; far or
 *   cross-band taps (e.g. the pre-limiter level tap) run along the bottom
 *   lane and enter the target from below;
 * - other edges leave the source on the right, turn in the gap column left of
 *   the target and enter its left side;
 * - cross-band edges go round the right margin and the channel above the
 *   target band, entering the top (row 0) or left gap column (other rows).
 */
function edgePath(a: LayoutNode, b: LayoutNode, c: RouteCtx): string {
  const ax = a.x + a.w;
  const ay = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bmy = b.y + b.h / 2;
  const tapTarget = b.group === 'analysis' || b.group === 'quartz';
  const sameBand = a.band === b.band;
  const leftGapX = b.x - (b.col % c.perBand === 0 ? c.margin / 2 : c.gapX / 2);

  if (a.group === 'source' && tapTarget) {
    const x0 = a.x + a.w / 2;
    const far = !sameBand || b.col - a.col > 3;
    if (!far) {
      const chan = b.y - 10;
      return poly([
        [x0, a.y + a.h],
        [x0, chan],
        [bcx, chan],
        [bcx, b.y],
      ]);
    }
    const laneA = (c.bandBottom[a.band] ?? a.y) + 8;
    const laneB = (c.bandBottom[b.band] ?? b.y) + 8;
    if (sameBand) {
      return poly([
        [x0, a.y + a.h],
        [x0, laneA],
        [bcx, laneA],
        [bcx, b.y + b.h],
      ]);
    }
    const xr = c.width - c.margin / 2;
    return poly([
      [x0, a.y + a.h],
      [x0, laneA],
      [xr, laneA],
      [xr, laneB],
      [bcx, laneB],
      [bcx, b.y + b.h],
    ]);
  }

  if (sameBand && b.col > a.col) {
    const xg = b.x - c.gapX / 2;
    return ay === bmy
      ? poly([
          [ax, ay],
          [b.x, bmy],
        ])
      : poly([
          [ax, ay],
          [xg, ay],
          [xg, bmy],
          [b.x, bmy],
        ]);
  }

  // Cross-band / back edge: round the right margin and the channel above the target band.
  const xr = c.width - c.margin / 2;
  const chanY = (c.bandTop[b.band] ?? b.y) - c.bandGap / 2;
  if (b.row === 0) {
    return poly([
      [ax, ay],
      [xr, ay],
      [xr, chanY],
      [bcx, chanY],
      [bcx, b.y],
    ]);
  }
  return poly([
    [ax, ay],
    [xr, ay],
    [xr, chanY],
    [leftGapX, chanY],
    [leftGapX, bmy],
    [b.x, bmy],
  ]);
}
