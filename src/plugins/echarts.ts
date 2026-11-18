/**
 * Single place where ECharts is registered (tree-shaken `echarts/core`).
 * Import this module once (from `main.ts`); chart components then use
 * `vue-echarts` without registering anything. Add new chart/component types
 * to the `use([...])` list as views need them.
 */
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  PolarComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';

use([
  CanvasRenderer,
  LineChart,
  ScatterChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  DatasetComponent,
  MarkLineComponent,
  MarkAreaComponent,
  MarkPointComponent,
  PolarComponent,
  VisualMapComponent,
]);
