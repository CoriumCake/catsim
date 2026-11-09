# CatSim: ESP32 & Arduino Simulator

A browser-based circuit and IoT simulator for the **ESP32 DevKit V1** and the **Arduino Uno**. You wire parts on a canvas, write an Arduino sketch, and watch the result in the Terminal (serial monitor) and the built-in MQTT dashboard.

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

- **Arduino Uno sketches in the browser:** write the sketch in the editor and press Start, just like the ESP32. It runs with the Uno's rules: pins 0–13 and A0–A5, 5 V logic, 16-bit `int`, a 10-bit ADC, PWM only on pins 3, 5, 6, 9, 10 and 11, and interrupts on pins 2 and 3. ESP32-only features (WiFi, `ledc…`) stop the sketch with an explanation. Direct register access (`PORTB`, timer registers) is not simulated.
- **ESP32-C3 Super Mini** (16 pins: GPIO 0–10, 20, 21; ADC on 0–4; the blue LED on GPIO8 is active LOW; I2C on 8/9) next to the ESP32 DevKit and the Uno.
- **Battery power:** any board can be set to run *from its pins* instead of USB (click it → *Powered by*). It then runs only while its supply is up: build a real chain like 18650 → TP4056 (charger + protection) → ON/OFF switch → 3.3 V buck-boost → 3V3, and flipping the switch turns the board off and restarts the sketch when it comes back.
- **Alerts for wiring and power mistakes:** pop-ups (also in the Console) that point at the part: a supply or battery shorted to GND, more current than a pin, regulator or battery can give, an LED backwards / starved of current / burnt, a part with a required pin unconnected, a relay coil a GPIO can't pull in, a servo or sensor without power, I2C SDA/SCL swapped, a sketch driving a pin with nothing on it, a missing flyback diode.
- **Breadboard:** drop a part on it and its legs plug into the holes (they snap into place); columns a–e / f–j and the power rails are joined as on a real one, and the centre channel separates the halves.
- **Batteries that drain and charge:** the charge follows the current your circuit really draws, and rises while a TP4056 charges it (choose a small capacity to watch it move). A battery-powered board's HIGH outputs follow its sagging supply.
- **To a real board:** the *</>* button downloads the open board's sketch as an `.ino` (with the board to pick in the IDE and the wiring as comments) to upload with the Arduino IDE.
- **Serial Plotter:** the *Plotter* tab graphs the numbers the sketch prints (`12 34`, `12,34` or `temp:21.5 hum:40`).
- **Arduino libraries:** `#include` the popular ones and use them as on real hardware, each wired to a simulated part:
  Adafruit SSD1306 + GFX (OLED), Adafruit NeoPixel and FastLED (WS2812B strip and ring), TM1637Display (4-digit display),
  OneWire + DallasTemperature (DS18B20), NewPing and `pulseIn()` (HC-SR04), RTClib (DS3231), Keypad (4×4 keypad),
  Bounce2, IRremote (VS1838B receiver + a clickable NEC remote), Encoder and ESP32Encoder (KY-040), Adafruit BME280 / BMP280, Adafruit MPU6050, MPU6050 / MPU6050_light, LiquidCrystal (parallel 16×2), ArduinoJson, EEPROM, Preferences, Ticker, Stepper and
  AccelStepper (28BYJ-48 + ULN2003). Wiring mistakes behave as they would on the bench: a stepper wired in the wrong
  order only jitters, a NeoPixel sketch with the wrong color order swaps red and green, a DS18B20 bus without a pull-up
  gets a warning. EEPROM, Preferences and the RTC's time survive Stop/Start for the browser session. Other libraries
  are not available: CatSim converts sketches to JavaScript rather than compiling C++, so each library is a JS
  reimplementation of the real one's API (see `src/libs/`).
- **ESP32 DevKit V1 (30-pin)** with real GPIO numbering. Hover a pin to see its functions (ADC1/ADC2, touch, DAC, strapping, I2C). The on-board LED is on GPIO2.
- **Parts:** LED, resistor, push button, potentiometer, DHT22, LDR, PIR motion sensor, piezo buzzer (plays sound), servo, RGB LED (common anode/cathode), 7-segment digit, slide switch, joystick, KY-040 rotary encoder, FSR 402 force sensor, sound / soil-moisture / MQ-2 gas modules, batteries (18650, 2×AA, 9 V, CR2032), TP4056 charger, 3.3 V buck-boost regulator, coin vibration motor, L298N motor driver, a half-size breadboard, BME280 / BMP280, MPU6050 (GY-521), a parallel 16×2 LCD, AO3400 and 2N7000 MOSFETs, 16×2 I2C LCD, 128×64 OLED, TM1637 display, NeoPixel strip and ring, DS18B20, HC-SR04, DS3231 RTC, 4×4 keypad, IR receiver and remote, 28BYJ-48 stepper, NPN (2N2222) and PNP (2N2907) transistors, N-MOSFET (2N7000), diodes (1N4148, 1N4007, 1N5819), an LM358 op-amp, capacitors, a DC motor, a 5 V relay, and logic chips with real DIP pinouts: 74HC00/02/04/08/14/32/86 gates, 74HC74 flip-flops, 74HC595 shift register, CD4017 counter and the NE555 timer.
- **Wiring:** click a pin, then another pin. Circuits are resolved into nets, so an LED only lights if it has a path to GND, and a button only works if it's wired to the input.
- **Arduino-ESP32 API:** GPIO, 12-bit ADC, LEDC PWM (core 2.x and 3.x APIs), `dacWrite`, `tone`, interrupts, `Serial` in both directions (Terminal tab), `printf`.
- **IoT:** `WiFi.h`, `PubSubClient` talking to a built-in MQTT broker (publish to the device from the *IoT · MQTT* tab), and `HTTPClient` making real HTTPS requests to CORS-enabled servers.
- **Analog circuit engine:** voltages and currents are solved like SPICE (modified nodal analysis, Newton–Raphson, trapezoidal integration with error control), validated against ngspice in CI. LEDs are real diodes with colour-specific forward voltages, and their brightness follows the actual current, so a resistor value or a blue LED on 3.3 V makes a visible difference. GPIOs have realistic output resistance, pull-ups and input thresholds; PWM, `tone()` and servo signals are real waveforms; `dacWrite` outputs a real voltage.
- **Electromechanics:** the DC motor's mechanics (inertia, friction, torque, back-EMF) are modelled as part of the circuit, so its speed is solved together with the electronics; relays pull in and drop out on their coil current. Switching a coil off without a flyback diode makes a real inductive spike, and the Console explains it.
- **Your own SPICE models:** diodes, transistors, MOSFETs and the op-amp accept a pasted `.model` (or a `.subckt` for MOSFETs and op-amps, as vendors publish them). Errors are reported with line numbers and the built-in model is used instead.
- **Mixed-signal logic:** chip outputs drive the analog circuit through realistic output resistance; inputs read real node voltages with 74HC thresholds (so a 74HC at 5 V does not accept a 3.3 V signal). The solver stops exactly where a chip input crosses its threshold, so RC timing (a 555, a Schmitt-trigger oscillator) is accurate.
- **Damage:** an LED driven without a resistor burns out (and stays dead until you restart), and the Console warns when a GPIO carries more than the ESP32's 40 mA limit.
- **SPICE netlists:** `src/analog/parser.ts` reads R, C, L, V, I, D, Q, M, E, G and X elements with `.model` (diode, BJT, level-1 MOSFET) and `.subckt`.
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
src/libs/             Arduino libraries (OLED, NeoPixel/FastLED, sensors, keypad, IR, JSON, storage, steppers)
src/parts-libs.js     the parts those libraries drive
src/parts-basic.js    basic, power and module parts (RGB LED, battery, TP4056, regulator, ESP32-C3…)
src/analog/models-extra.ts  their electrical models (regulators, protection, board power)
src/plotter.js        Serial Plotter
src/contacts.js       legs plugged into a breadboard
src/clock.ts          virtual simulation clock
src/analog/           analog engine: circuit.ts (MNA solver), devices.ts (BJT, MOSFET, op-amp,
                      controlled sources), parser.ts (SPICE netlists), models.ts (part models), bridge.ts
                      (couples it to the sketch), waveform.ts, spice.ts (netlist export), nets.ts
src/scope.ts          oscilloscope panel
src/digital/chips.ts  logic chips: pinouts and behaviour
src/sketches/         Arduino Uno example sketches (.ino)
src/sim-worker.js     runs the sketch in a Web Worker
src/sim-host.js       page side: mirrors worker state, validates its messages
src/examples.js       example projects (src/examples-libs.js: one per library)
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
