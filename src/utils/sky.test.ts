import { describe, expect, it } from 'vitest';
import {
  compass,
  groupBySystem,
  satLabel,
  toSat,
  type SatView,
  skyPosition,
  snrSymbolSize,
  sortBySnr,
  splitSats,
} from './sky';

const sat = (o: Partial<SatView>): SatView => ({
  sys: 'GP',
  prn: 1,
  el: 45,
  az: 90,
  snr: 30,
  used: true,
  ...o,
});

describe('sky', () => {
  it('maps zenith to the centre and horizon to the rim', () => {
    expect(skyPosition(sat({ el: 90, az: 10 }))).toEqual([0, 10]);
    expect(skyPosition(sat({ el: 0, az: 180 }))).toEqual([90, 180]);
    expect(skyPosition(sat({ el: 30, az: 359 }))).toEqual([60, 359]);
  });
  it('returns null for unknown el/az and splits them off', () => {
    expect(skyPosition(sat({ el: -1 }))).toBeNull();
    expect(skyPosition(sat({ az: -1 }))).toBeNull();
    const { placed, unplaced } = splitSats([sat({}), sat({ prn: 2, el: -1 })]);
    expect(placed).toHaveLength(1);
    expect(unplaced.map((s) => s.prn)).toEqual([2]);
  });
  it('scales symbols by SNR', () => {
    expect(snrSymbolSize(-1)).toBe(8);
    expect(snrSymbolSize(0)).toBe(8);
    expect(snrSymbolSize(50)).toBe(26);
    expect(snrSymbolSize(99)).toBe(26);
    expect(snrSymbolSize(25)).toBeCloseTo(17);
  });
  it('sorts by SNR with untracked last, groups by system', () => {
    const s = sortBySnr([
      sat({ prn: 1, snr: -1 }),
      sat({ prn: 2, snr: 40 }),
      sat({ prn: 3, snr: 20, sys: 'GL' }),
    ]);
    expect(s.map((x) => x.prn)).toEqual([2, 3, 1]);
    expect(groupBySystem(s).map((g) => g.sys)).toEqual(['GP', 'GL']);
  });
  it('labels and compass', () => {
    expect(satLabel(sat({ sys: 'GA', prn: 7 }))).toBe('GA7');
    expect(satLabel(sat({ sys: '??', prn: 7 }))).toBe('7');
    expect(compass(0)).toBe('N');
    expect(compass(92)).toBe('E');
    expect(compass(359)).toBe('N');
  });
});

describe('toSat', () => {
  it('names the tuple columns and converts used to boolean', () => {
    expect(toSat(['GA', 7, 45, 120, 33, 1])).toEqual({
      sys: 'GA',
      prn: 7,
      el: 45,
      az: 120,
      snr: 33,
      used: true,
    });
    expect(toSat(['??', 1, -1, -1, -1, 0]).used).toBe(false);
  });
});
