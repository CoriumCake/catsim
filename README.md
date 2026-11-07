# CatSim: ESP32 IoT Simulator

A browser-based circuit and IoT simulator for the **ESP32 DevKit V1**. You wire parts on a canvas, write an Arduino sketch, and watch the result in the Terminal (serial monitor) and the built-in MQTT dashboard.

Live at **https://sim.catcodehq.com**.

## Develop

Requires Node.js 22 or newer.

```sh
npm install
npm run dev          # http://localhost:5173 with hot reload
```

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then build the static site into `dist/` |
| `npm run typecheck` | TypeScript check only |
| `npm test` | Unit tests (Vitest). The analog engine is also compared with ngspice when it is installed (`pacman -S ngspice` / `apt install ngspice`). |
| `npm run test:e2e` | End-to-end tests (Playwright) against `wrangler dev`, i.e. the real Cloudflare server with the CSP headers. Run `npm run build` first. Set `CHROMIUM_PATH` to use a system Chromium. |

Everything is bundled, so the built site works offline (no CDN scripts).

## Features

- **ESP32 DevKit V1 (30-pin)** with real GPIO numbering. Hover a pin to see its functions (ADC1/ADC2, touch, DAC, strapping, I2C). The on-board LED is on GPIO2.
- **Parts:** LED, resistor, push button, potentiometer, DHT22, LDR, PIR motion sensor, piezo buzzer (plays sound), servo, 16×2 I2C LCD.
- **Wiring:** click a pin, then another pin. Circuits are resolved into nets, so an LED only lights if it has a path to GND, and a button only works if it's wired to the input.
- **Arduino-ESP32 API:** GPIO, 12-bit ADC, LEDC PWM (core 2.x and 3.x APIs), `dacWrite`, `tone`, interrupts, `Serial` in both directions (Terminal tab), `printf`.
- **IoT:** `WiFi.h`, `PubSubClient` talking to a built-in MQTT broker (publish to the device from the *IoT · MQTT* tab), and `HTTPClient` making real HTTPS requests to CORS-enabled servers.
- **Analog circuit engine:** voltages and currents are solved like SPICE (modified nodal analysis, Newton–Raphson, trapezoidal integration with error control), validated against ngspice in CI. LEDs are real diodes with colour-specific forward voltages, and their brightness follows the actual current, so a resistor value or a blue LED on 3.3 V makes a visible difference. GPIOs have realistic output resistance, pull-ups and input thresholds; PWM, `tone()` and servo signals are real waveforms; `dacWrite` outputs a real voltage.
- **Oscilloscope:** the *Scope* tab probes up to four nets, with timebase, volts/div, edge trigger and frequency/peak readouts.
- **Simulation clock:** pause and resume, and run at 0.1× to 10× speed. `delay(1000)` advances simulated time by exactly 1000 ms; under heavy load the simulation runs slower than real time instead of skipping.
- **ESP32 pitfall checks:** warnings for flash pins 6–11, output on input-only pins 34–39, missing pull-ups, ADC2 used while WiFi is on, floating inputs, and unpowered sensors.
- **3D view:** switch the stage to *3D* to orbit a full 360° (including under the boards) around a live 3D model of the circuit (LEDs glow, the servo turns, the LCD shows text, and you can press buttons). Wiring and moving parts still happen in 2D. Three.js loads only when you first open it.
- **Projects** auto-save in the browser. You can also export or import JSON, or copy a compressed share link (the whole project is encoded in the URL; older `#p=` links still open).

Keyboard shortcuts: `Ctrl+Enter` starts or stops the simulation, `Del` deletes the selection, `Esc` cancels a wire.

## How it works

`src/transpiler.js` rewrites the common Arduino C++ subset (typed declarations, functions, arrays, enums, casts, `#define`) into async JavaScript. `delay()` becomes `await`, and loops yield so nothing freezes. `src/runtime.js` provides the simulated ESP32 API and the net solver, and runs in a Web Worker. Not supported: `class`/`struct`, templates, pointer arithmetic, FreeRTOS tasks.

```
index.html            layout
public/_headers       Cloudflare headers: CSP, caching
src/main.ts           entry point
src/app.js            app shell, panels, persistence
src/editor.ts         CodeMirror 6 sketch editor
src/project.ts        project validation (untrusted input) and share links
src/types.ts          shared types, including PartDef (the part definition format)
src/components.js     part definitions (pins, behaviour, SVG)
src/canvas.js         2D diagram editor (drag, wire, pan/zoom)
src/view3d.js         3D view (Three.js, code-split)
src/transpiler.js     sketch → JS
src/runtime.js        simulator, Arduino/ESP32 API, WiFi/MQTT/HTTP
src/clock.ts          virtual simulation clock
src/analog/           analog engine: circuit.ts (MNA solver), models.ts (part models), bridge.ts
                      (couples it to the sketch), waveform.ts, spice.ts (netlist export), nets.ts
src/scope.ts          oscilloscope panel
src/sim-worker.js     runs the sketch in a Web Worker
src/sim-host.js       page side: mirrors worker state, validates its messages
src/examples.js       example projects
tests/unit/           Vitest
tests/e2e/            Playwright
```

New code is written in TypeScript. The older modules are still JavaScript ES modules and are being converted one at a time.

## Security

Share links and imported files can contain anything, so they are treated as untrusted:

- Projects are rebuilt field by field on load (`normalizeProject()` in `src/project.ts`). Ids, colours, positions and part properties are type-checked, and wires must reference real pins.
- Sketches run in a Web Worker with no access to the page, the DOM or `localStorage`. Everything the worker sends back is validated before it reaches the UI (`src/sim-host.js`). Stopping the simulation terminates the worker.
- A Content Security Policy (`public/_headers`) blocks inline and third-party scripts on the page. Only the sketch worker may compile code (`unsafe-eval`), and it can load no other scripts.

## Deploy

The site is hosted on Cloudflare Workers as static assets at **https://sim.catcodehq.com**.

GitHub Actions (`.github/workflows/ci-cd.yml`) typechecks, runs the unit and end-to-end tests, and builds on every push and pull request. Pushes to `main` then deploy exactly the build that passed. It needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

To deploy by hand instead:

```sh
npm run build && npx wrangler deploy
```
