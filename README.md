# CatSim: ESP32 IoT Simulator

A browser-based circuit and IoT simulator for the **ESP32 DevKit V1**. You wire parts on a canvas, write an Arduino sketch, and watch the result in the Terminal (serial monitor) and the built-in MQTT dashboard.

## Run it

There's no build step. Either open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

An internet connection is needed for the CodeMirror editor (loaded from cdnjs). Without it, the app falls back to a plain textarea.

## Features

- **ESP32 DevKit V1 (30-pin)** with real GPIO numbering. Hover a pin to see its functions (ADC1/ADC2, touch, DAC, strapping, I2C). The on-board LED is on GPIO2.
- **Parts:** LED, resistor, push button, potentiometer, DHT22, LDR, PIR motion sensor, piezo buzzer (plays sound), servo, 16×2 I2C LCD.
- **Wiring:** click a pin, then another pin. Circuits are resolved into nets, so an LED only lights if it has a path to GND, and a button only works if it's wired to the input.
- **Arduino-ESP32 API:** GPIO, 12-bit ADC, LEDC PWM (core 2.x and 3.x APIs), `dacWrite`, `tone`, interrupts, `Serial` in both directions (Terminal tab), `printf`.
- **IoT:** `WiFi.h`, `PubSubClient` talking to a built-in MQTT broker (publish to the device from the *IoT · MQTT* tab), and `HTTPClient` making real HTTPS requests to CORS-enabled servers.
- **ESP32 pitfall checks:** warnings for flash pins 6–11, output on input-only pins 34–39, missing pull-ups, ADC2 used while WiFi is on, floating inputs, and unpowered sensors.
- **3D view:** switch the stage to *3D* to orbit around a live 3D model of the circuit (LEDs glow, the servo turns, the LCD shows text, and you can press buttons). Wiring and moving parts still happen in 2D. Three.js loads only when you first open it.
- **Projects** auto-save in the browser. You can also export or import JSON, or copy a share link (the whole project is encoded in the URL).

Keyboard shortcuts: `Ctrl+Enter` starts or stops the simulation, `Del` deletes the selection, `Esc` cancels a wire.

## How it works

`js/transpiler.js` rewrites the common Arduino C++ subset (typed declarations, functions, arrays, enums, casts, `#define`) into async JavaScript. `delay()` becomes `await`, and the loops yield to the browser so the page never freezes. `js/runtime.js` provides the simulated ESP32 API and the net solver. Not supported: `class`/`struct`, templates, pointer arithmetic, FreeRTOS tasks.

```
index.html        layout
css/style.css     theme
js/components.js  part definitions (SVG rendering, pins, behaviour)
js/transpiler.js  sketch → JS
js/runtime.js     simulator, Arduino/ESP32 API, WiFi/MQTT/HTTP
js/canvas.js      diagram editor (drag, wire, pan/zoom)
js/view3d.js      3D view (Three.js, loaded on demand)
js/examples.js    example projects
js/app.js         app shell, panels, persistence
```

## Deploy

The site is hosted on Cloudflare Workers as static assets at **https://sim.catcodehq.com**.

GitHub Actions (`.github/workflows/ci-cd.yml`) runs the tests (`node --test tests/*.test.js`) on every push and pull request, and deploys every push to `main` that passes. It needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

To deploy by hand instead:

```sh
npx wrangler deploy
```
