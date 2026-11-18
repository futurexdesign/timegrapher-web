/** Shared types of the Time Grapher view components. */
import type { QuartzMode } from '@/protocol/types';

/** Which panel is shown. */
export type TimegrapherKind = 'mechanical' | 'quartz';
/** Quartz sub-modes selectable in the UI. */
export type QuartzSubMode = Exclude<QuartzMode, 'mechanical'>;
