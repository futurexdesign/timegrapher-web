# Architecture

Module map and data flow of the web app. See `README.md` for usage.

## Layers

```
views / components  ->  stores (Pinia)  ->  Transport  ->  WebHidTransport  -> device
                                                      \->  VirtualTransport -> VirtualDevice (src/sim)
```

Upper layers only know the `Transport` interface (`src/transport/Transport.ts`):
`open`, `close`, typed `request(op, body, timeoutMs)`, `onNotify`, `onDisconnect`.
They never see which implementation is behind it.

## Module map

| Path                          | Role                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/protocol/`               | `timegrapher_hid.d.ts` (synced from the firmware repo, never edited), `types.ts` (re-export), `constants.ts` (runtime values), `framer.ts` (encoder / reassembler), `messages.ts` (response / notify guards, error normalisation). |
| `src/transport/`              | `Transport` interface, `DeviceError` (device error codes plus client codes `timeout`, `disconnected`, `notOpen`, `protocol`), `WebHidTransport`.                                                                                   |
| `src/sim/`                    | Virtual device (below).                                                                                                                                                                                                            |
| `src/stores/`                 | Pinia stores. `connection` owns the transport; `subscriptions` owns the push subscription and notify bus; the rest are feature stores.                                                                                             |
| `src/composables/`            | `usePcCalibration`: PC-assisted timebase calibration (injectable state machine, wake lock, visibility).                                                                                                                            |
| `src/views/`                  | One routed page each; they claim polling / subscriptions while mounted.                                                                                                                                                            |
| `src/components/`             | `timegrapher/`, `audio/`, `timebase/`, `settings/` plus shared `ConnectPrompt`, `AppBarConnection`.                                                                                                                                |
| `src/utils/`                  | Pure, unit-tested helpers (no Vue state): `tickTock`, `balance`, `sky`, `calibration`, `quartzPulses`, `dspMeta` (block metadata), `pipelineLayout`, `format`, `budget`, `capsChips`, `rawConsole`.                                |
| `src/router/`, `src/layouts/` | Hash-history routes (lazy views; `meta.nav` feeds the drawer) and the shell.                                                                                                                                                       |
| `src/plugins/`                | Vuetify and tree-shaken ECharts registration.                                                                                                                                                                                      |
| `tests/contract/`             | Transport contract suite plus the simulator harness.                                                                                                                                                                               |

## Transport

`WebHidTransport` sends one request at a time (a second request while one is
pending is dropped silently by the device; `busy` only means a flash write was
refused): a queue with a single in-flight slot, matching replies by `id`,
per-request timeout (default 4 s), late replies ignored. Requests are framed
into 63-byte reports with a 5-byte header (`flags, msgSeq, fragIndex,
fragCount, payloadLen`) carrying at most 58 UTF-8 bytes each, up to 2030 bytes
of JSON for requests (`HID_MAX_REQUEST_BYTES`; longer ones are dropped silently by
the device, so the transport rejects them with a `protocol` error) and 2048
bytes for replies. Messages without an `id` are notifies and go to the `onNotify`
listeners; a HID `disconnect` event fails every outstanding request and fires
`onDisconnect`.

## Connection

After `hello`, a `protocolVersion` other than 1 shows a warning snackbar but
the connection stays up.

`useConnectionStore().connect(kind)` builds the transport with a factory
(`defaultTransportFactory`: `'webhid'` gives `WebHidTransport`, `'virtual'`
gives `createVirtualTransport()` from `src/sim`), opens it and sends `hello`.
The store exposes `status`, `hello`, `caps` and `features` (booleans derived
from caps: `quartz`, `beats`, `deviceMode`, `gps`, `pps`, `timebaseLog`,
`timing`, `pipeline`). Every feature-dependent UI part is gated on
`features` / `caps`.

## Push data: claims and the notify bus

`useSubscriptionsStore()` is the only place that sends `subscribe` (the raw
console does not offer it). A failed `subscribe` is retried with backoff (1 s,
2 s, 5 s, then every 10 s) while connected; a disconnect stops the retries.

1. A consumer calls `claim(owner, patch)` (one claim per owner id; calling again
   replaces it) and `release(owner)`.
2. `desired = mergeClaims(claims)`: rates take the maximum, flags are OR-ed.
3. `sync()` (serialised through a promise chain) computes
   `diffSubscription(active, desired)` and sends only the changed fields. A
   no-change claim sends nothing, so baselines (events, pulses, beats) are not
   re-seeded. The device echo becomes `active`; it is authoritative because the
   firmware clamps rates.
4. On connect the store attaches one `transport.onNotify` listener, resets
   `active` to the quiet subscription and re-applies the merged claims.
5. `on(op, handler)` registers typed handlers per notify op; the notify bus
   fans each notify out to them (a throwing handler is logged and does not
   affect the others).

Claim owners in use: `timegrapher.mechanical` (`beatHz 2`, `beats`),
`timegrapher.quartz` (`quartzHz 2`, `quartzPulses`), `metrics` (`metricsHz 5`),
`diagnostics` (`errors`, optionally `events`).

Notify handlers: `mechanical` (`beat`, `beats`), `quartz` (`quartz`,
`quartzPulse`) and `metrics` register at store creation or acquire; `diagnostics`
registers `error` / `event` on `attach()` and removes them on the last
`detach()`.

## Polling stores

`timebase`, `gps` and `diagnostics` (timing) have no push notify, so they poll
at 1 Hz through `createPoller` (`src/stores/timebase.ts`): reference counted
(`startPolling` / `stopPolling`; the first user starts a timer with an
immediate tick, the last stops it) and never overlapping ticks (a tick is
skipped while the previous request is in flight). Views start polling on mount
and pause it while the browser tab is hidden (`visibilitychange`). `gps` and
`diagnostics` skip their requests without `caps.gps` / `caps.timing`.
`timebase` also keeps a capped in-memory series of live PPS ppm samples
(`sessionPps`) and reads the calibration log in pages until
`offset + entries >= total`.

`device` re-reads `getDevice` on connect and polls it every 2 s app-wide while
connected, so `usbStreaming` is fresh in every view. On a disconnect or connect
the `mechanical`, `quartz`, `metrics`, `diagnostics` and `timebase` stores
watch `connection.isConnected` and drop their device data (quartz also forgets
the measurement id so a colliding id on a new device still ingests pulses).
`timebase.sessionPps` is capped at 86 400 points and trimmed in place
(`triggerRef`), not copied each second.

## Data flow of the Time Grapher view

1. `HeaderBar` Start: `mechanical.begin()` (or `quartz.begin()`) sends `start`
   through `device` and claims the subscription.
2. `subscriptions` merges and sends `subscribe`; the device pushes `beat`
   (about 2 Hz) and `beats` (at most 8 per notify).
3. The notify bus calls `mechanical.ingestRate` / `ingestBeats`, which append to
   capped arrays (`TREND_CAP`, `TICK_CAP`) mutated in place and bump a version
   counter. A `gridId` change clears the tick-tock trace.
4. Charts watch the version counters through `useThrottled` (trailing edge, at
   most 4 Hz, one rebuild per burst) and feed `<v-chart>` (ECharts, `autoresize`).

## State editing

`dspState` mirrors `getState`. Edits show optimistically (overlay keyed per
field), are debounced (sliders 250 ms) and serialised, and the post-patch
snapshot from the device always replaces local state. A failed write drops the
overlay, shows a snackbar and re-reads the state. `clear()` on disconnect
cancels pending writes through a generation counter.

## Simulator

`src/sim` implements the same protocol surface in the browser.

- `VirtualTransport` (a `Transport`): one request in flight, configurable reply
  latency and timeout, `DeviceError` for failures. While a subscription is
  active it runs a 10 ms poll that asks the device for the next due notify (one
  message per poll). Timers come from an injectable `Scheduler` and the time
  source from an injectable `Clock` (tests use fake timers).
- `VirtualDevice`: op handlers mirroring `hid_control.cpp` and the protocol
  spec, plus the signal-time engine. Slow processes (UTC, GPS, PPS, crystal
  drift) advance with real time scaled by `timeScale`; signal models advance
  only while capture runs. `models/` holds the mechanical watch, quartz (motor,
  LCD, tuning fork), DSP telemetry, GPS, timebase and timebase-log models;
  `notifier.ts` holds subscription state and periodic scheduling; `rings.ts`
  the event / error / beat logs; `dspState.ts` the `getState` / `patchState`
  merge semantics.
- The device models which watch is on the stand (`attached`); a quartz mode
  measures only when the matching kind is attached. With `autoAttach` (default
  on), a mode selected through `patchState` swaps the attached watch to match
  (`followMode`), so the app works without the Simulator panel. Turning it off
  in the panel models a wrong watch on the stand. See
  `src/sim/quartzModes.test.ts`.
- `scenarios.ts`: the `SimulatorControl` API (presets, physics setters, faults,
  failure injection, time scale, build options, snapshot) and the module-level
  registry of the active control. The transport registers its control on
  creation and open and releases it on close or drop; `getSimulatorControl()`
  returns it (or `undefined`), and released settings are remembered for the
  next virtual session. `SimulatorPanel.vue` drives only this API.
- Plug-in point: `defaultTransportFactory` in `src/stores/connection.ts`
  (`case 'virtual'`), and `setTransportFactory` for tests.

## Conventions

- No `any`; no unjustified non-null assertions; JSDoc on exported symbols and a
  header comment per file.
- Never call `subscribe` directly; use claims.
- Large live series are capped and charts redraw at most 4 Hz.
- `localStorage` access is always wrapped in try/catch (theme, GPS
  hide-position, developer-tools toggle).
- Every timer, listener and notify handler registered by a component is
  removed in `onBeforeUnmount`.
