# Timegrapher Web

End-user web front end for the USB **timegrapher stand**, a watch timing
device. The app talks to the device over
[WebHID](https://developer.mozilla.org/en-US/docs/Web/API/WebHID_API) using a
framed JSON protocol. The firmware repo (`timegrapher-stand`) is the **source
of truth** for the protocol: the normative spec is `docs/HID_CONTROL_PLANE.md`
there. A built-in **virtual device** (simulator, `src/sim`) lets you use and
develop the UI without hardware.

Stack: Vite 8, Vue 3 (`<script setup>`), TypeScript (strict), Vuetify 4,
Pinia, vue-router (hash history), ECharts via vue-echarts, Vitest.

Module map and data flow: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Views

Every view shows a connect prompt until a device is connected. Routes use hash
history (`#/`, `#/audio`, `#/timebase`, `#/settings`).

- **Time Grapher** (`/`, landing page). A header holds the Mechanical / Quartz
  toggle (Quartz needs `caps.quartz`), the quartz sub-mode (Motor / LCD / Fork),
  Start / Stop, the capture-mode select and status chips.
  - _Mechanical_: rate, beat error and amplitude tiles (averaged value plus the
    instant one), A/h, editable lift angle, lock state; the tick-tock
    (paper-strip) chart with window, raw / flatten, scale (auto, fixed, full)
    and fold options; a balance-wheel animation; a trend chart.
  - _Quartz_: headline rate (motor: with inhibition; LCD / fork: oscillator
    rate), raw and uncalibrated rates, state and reason, motor inhibition, gate
    selector, fork frequency, SNR / clipping hints and the motor pulse chart.
- **Audio Analysis / Filtering** (`/audio`). Live level meters (5 Hz), the DSP
  pipeline graph (SVG built from `caps.pipeline`, with a static fallback), an
  optional spectrum-peaks chart, and block cards in two groups: analysis taps
  and the filtering (process) chain. Blocks absent from `caps.blocks` are hidden.
- **Timebase** (`/timebase`). Active sample-clock correction (set / save /
  clear), PC-assisted calibration against the host clock, GPS / PPS status with
  a sky view (needs `caps.gps`), and the calibration history chart with a
  collapsed table and the log-delta threshold (needs `caps.timebaseLog`).
- **Settings** (`/settings`). Expansion panels: Device mode (needs
  `caps.deviceMode`), Device info, Performance (`getTiming`), Faults and
  events, Advanced (subscription state, raw request console, developer-tools
  toggle), Appearance (light / dark / system) and the Simulator panel.

Rates are shown in s/d with an explicit sign (+ = watch gaining), beat error in
ms, amplitude in degrees. Uncalibrated timing (`calSource` `none`) is flagged.

## Device modalities

The stand reports its mode through `getDevice` (`deviceMode` capability):

- **USB microphone (`usbMic`)**: the stand appears as a USB audio input and
  streams the watch audio to the computer. Capture runs while the host has the
  audio stream open (or after `start`). HID carries control only; audio never
  travels over HID.
- **Standalone timegrapher (`standalone`)**: the stand analyses the signal
  itself and (optionally) shows results on its own display. It starts at boot,
  and the web app only needs HID to read results and change settings. USB audio
  packets are zeros in this mode.

Changing mode is persisted to flash and is refused (`busy`) while the audio
stream is open. On firmware without `caps.deviceMode` capture is always on and
the mode / Start / Stop controls are hidden.

## Connecting

Use the **Connect** menu in the app bar (or the buttons on the connect prompt):

- **Real device (WebHID)**: opens the browser device chooser (filtered on usage
  page `0xFFA0` / usage `0x0001`), then sends `hello`. Disabled when the
  browser has no WebHID. It has not been run against real hardware yet (see
  Known limitations).
- **Virtual device**: an in-browser simulation of the protocol surface. Nothing
  to plug in; it behaves like a stand with a watch on it.

Both implement the same `Transport` interface, so every view works unchanged.
Features are gated on `hello.caps` (`useConnectionStore().features`):
unsupported features are hidden, not reported as errors.

## Simulator

The virtual device is driven from **Settings > Simulator**. The panel is shown
while connected to the virtual device, or on a real device when "Show developer
tools" (Settings > Advanced, remembered in `localStorage`) is on. It uses only
the `SimulatorControl` API of `src/sim`.

- **Presets**: Healthy 28800 watch, Worn watch, Quartz motor with inhibition,
  LCD, Tuning fork, No GPS, GPS cold start.
- **Physics**: the attached watch (none / mechanical / quartz motor / LCD /
  tuning fork) and its rate, beat error, amplitude, lift angle, jitter and
  missed-beat probability; quartz source (motor rate, step, inhibition period
  and jump, SNR, LCD pattern, fork rate, motor clipping, LCD no-pattern); GPS
  (satellite count, time to fix, first sentence); board crystal error and
  drift; noise floor; time scale (time acceleration) and reply latency;
  simulated USB audio stream open / closed.
- **Watch follows the mode** (on by default): choosing Motor, LCD or Fork on
  the Time Grapher puts that kind of watch on the simulated stand, and
  Mechanical puts the mechanical watch back, so every mode measures without a
  trip to this panel. Turn it off to test a mismatch: the watch then changes
  only here, and a mode that does not match it sees no signal, as on a real
  stand with the wrong watch on it.
- **Fault injection**: flags `timebaseUnverified`, `unsupportedRate`,
  `flashBusy`, `flashError`, `backendUnhealthy`; fail the next N requests with
  a chosen error; log a DSP fault (block plus `underrun` / `usbStall` /
  `overload`); inject a capture sample loss; drop the link.
- **Build options** (quartz engine, GPS, PPS): they live in `hello.caps`, so
  they take effect at the next connect.
- A live "truth" readout shows the simulated values behind what the UI measures.

Physical settings are remembered between virtual sessions in memory only
(module state, lost on page reload).

## Commands

Requires Node >= 22 (`.nvmrc`). Every script below has been run and works.

```sh
npm install
npm run dev          # Vite dev server (http://localhost:5173)
npm run build        # vue-tsc --noEmit && vite build -> dist/
npm run preview      # serve dist/
npm run lint         # ESLint (typescript-eslint strict type-checked + vue), no `any`
npm run format       # Prettier --write .
npm run typecheck    # vue-tsc --noEmit
npm test             # Vitest, single run
npm run test:watch   # Vitest watch mode
npm run coverage     # vitest run --coverage (v8; text + lcov in coverage/)
npm run sync-types   # copy protocol types from the firmware repo
```

Formatting is checked with `npx prettier --check .` (there is no `format:check`
script). `dist/` uses relative asset paths (`base: './'`) and hash routing, so
it can be hosted from any static path.

## Testing

- **Unit tests**: Vitest + happy-dom, `*.test.ts` next to the code (framer,
  transport queue, stores, pure maths in `src/utils`, simulator models, the PC
  calibration state machine, a few components). Run with `npm test`.
- **Contract suite**: `tests/contract/transportContract.ts` exercises the
  `Transport` interface (hello / caps, state, `subscribe`, run control and
  device mode, beats, quartz, timebase, timebase log, GPS) through a
  `ContractHarness`. `tests/contract/contract.test.ts` runs it against the
  simulator (`simHarness.ts`: fake timers, pinned physics). It is part of
  `npm test`.
- **`test:device` is not implemented yet.** The harness abstraction exists so a
  hardware harness (real sleeps, optional hooks left undefined) can run the same
  suite against a stand, but no such script or harness is in the repo.

## CI

`.github/workflows/`:

- `ci.yml` (push, pull request, manual): one `build` job on the Node version
  from `.nvmrc`: `npm ci`, lint, typecheck, `vitest run --coverage`, build,
  upload `dist/`, then `npm audit --audit-level=high` (blocking). A separate
  `dependency-review` job runs on pull requests. On a push to `main` the build
  job also packages `dist/` as a Pages artifact, and the `deploy-pages` job
  publishes it to GitHub Pages, so only a build that passed every check goes
  live. One-time setup: in the repository's **Settings → Pages**, set
  **Source** to **GitHub Actions**. The site is then at
  `https://<owner>.github.io/<repo>/`, which works as is because the build uses
  relative asset paths (`base: './'`) and hash routing.
- `codeql.yml` (push, pull request, weekly): CodeQL for JavaScript / TypeScript.
- `dependabot.yml`: weekly npm and GitHub Actions updates.

## Browser requirements

- A Chromium-based browser (Chrome, Edge, Opera) for a real device. Firefox and
  Safari have no WebHID; the virtual device still works there.
- A **secure context**: HTTPS, or `http://localhost`.
- On Linux you may need a udev rule granting access to the hidraw device.
- Optional: the Screen Wake Lock API keeps the screen on during a PC-assisted
  calibration; the app works without it.

## Protocol types

The TypeScript declarations are authored in the firmware repo
(`docs/hid/timegrapher_hid.d.ts`) and copied, **never edited**, into
`src/protocol/timegrapher_hid.d.ts`:

```sh
npm run sync-types                          # expects ../timegrapher-stand
TIMEGRAPHER_FW_DIR=/path/to/fw npm run sync-types
node scripts/sync-types.mjs /path/to/fw
```

The script prints "already up to date" when the files are identical. Change the
protocol in the firmware repo, then re-run it; nothing checks the copy for
drift automatically. The file is a `.d.ts` (type-only; it declares ambient
constants but has no runtime values), so import it with `import type`, usually
through `@/protocol/types`. Runtime constants (report id, chunk size, device
filter) live in `src/protocol/constants.ts`; a unit test guards them against
the spec.

## Project structure

```
index.html, vite.config.ts, tsconfig.json, eslint.config.js, .prettierrc.json
scripts/sync-types.mjs      protocol type sync
src/
  main.ts, App.vue          entry and root component (v-app, global snackbar, theme)
  protocol/                 timegrapher_hid.d.ts (synced), types, constants, framer, messages
  transport/                Transport interface + DeviceError, WebHidTransport
  sim/                      virtual device: VirtualTransport, VirtualDevice, scenarios
                            (SimulatorControl), notifier, rings, clock, rng, models/
  stores/                   Pinia: connection, subscriptions, snackbar, theme, device,
                            mechanical, quartz, dspState, metrics, timebase, gps, diagnostics
  composables/              usePcCalibration (PC-assisted timebase calibration)
  layouts/                  DefaultLayout (drawer, app bar, router-view)
  router/                   hash-history routes
  plugins/                  Vuetify and tree-shaken ECharts registration
  views/                    TimeGrapher, AudioAnalysis, Timebase, Settings
  components/               shared (ConnectPrompt, AppBarConnection) and per view:
                            timegrapher/, audio/, timebase/, settings/
  utils/                    pure helpers with tests (format, tickTock, balance, sky,
                            calibration, quartzPulses, dspMeta, pipelineLayout, ...)
tests/contract/             transport contract suite + simulator harness
docs/ARCHITECTURE.md        module map and data flow
.github/                    CI, CodeQL, Dependabot
```

## Stores and the subscription-claim model

The device keeps **one** push subscription per connection, and every
`subscribe` re-seeds the event / pulse / beat baselines. If each view sent its
own `subscribe`, they would fight over rates. So nothing calls `subscribe`
directly: consumers register a _claim_ with `useSubscriptionsStore()`:

```ts
const subs = useSubscriptionsStore();
await subs.claim('my-owner', { beatHz: 2, beats: true });
const off = subs.on('beats', (d) => {
  /* ... */
});
// later
await subs.release('my-owner');
off();
```

The effective subscription is the merge of all claims (rates: maximum; flags:
logical OR). Only changed fields are sent, so a claim that does not change the
merged value costs nothing and does not re-seed baselines. Claims survive a
disconnect and are re-applied on the next connection. A failed `subscribe` is
retried with backoff (1 s, 2 s, 5 s, then every 10 s) while connected.

Device-specific data (mechanical ticks / trend / rate, quartz snapshot and
pulses, metrics, diagnostics, timebase) is cleared whenever the connection goes
up or down, so a new device never shows the previous one's series. `device`
polls `getDevice` every 2 s app-wide while connected. The Settings raw console
does not offer `subscribe` (it would overwrite the merged claims). Requests
above 2030 bytes are refused client-side (`protocol` error) because the device
drops them silently; `hello.protocolVersion` other than 1 only shows a warning.

- `connection`: active transport, status, `hello`, caps and derived `features`;
  `connect('webhid' | 'virtual')`.
- `subscriptions`: claim merge, diff-only `subscribe`, notify bus (`on`).
- `snackbar`: global error / notice messages.
- `theme`: light / dark / system preference (`localStorage`).
- `device`: `getDevice` / `setDevice` / `start` / `stop`; running, mode, USB-streaming flag.
- `mechanical`: `beat` snapshot, capped trend series, per-beat tick-tock points
  (`beats`); claim `{beatHz: 2, beats: true}`.
- `quartz`: `quartz` snapshot, motor pulses, settings and mode / gate / fork
  patches; claim `{quartzHz: 2, quartzPulses: true}`.
- `dspState`: `getState` mirror with optimistic, debounced, serialised `patchState` edits.
- `metrics`: reference-counted 5 Hz `metrics` claim and capped level series.
- `timebase`: `getTimebase` polling (1 Hz), paged calibration log, set / save /
  clear, log-delta (sends only `logDeltaPpm`).
- `gps`: `getGps` polling (1 Hz), tuple-to-satellite adapter, hide-position
  toggle (`localStorage`).
- `diagnostics`: `getTiming` polling, fault log (`error` notifies), recent
  events (`event` notifies).

## Known limitations

- **No run against real hardware yet.** `WebHidTransport` is covered by unit
  tests with fake devices only; the contract suite runs against the simulator
  only, and `test:device` does not exist.
- The simulator mirrors the firmware docs, not the firmware itself, so
  simulator-only behaviour can differ from a real stand.
- `npm audit` reports 5 moderate advisories (`glob` / `minimatch` through
  `@vue/test-utils` > `js-beautify`; dev dependencies; the only offered fix is a
  breaking downgrade). `high` and `critical` pass, and the CI audit step is
  blocking at `--audit-level=high`.
- Timebase, GPS, timing and spectrum values are polled at 1 Hz; the device has
  no notify for them.
- Simulator physical settings are not persisted across page reloads.
