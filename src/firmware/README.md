# Example firmware

Compiled Arduino Uno firmware for the examples, built with the official toolchain:

```sh
arduino-cli core install arduino:avr
arduino-cli compile -b arduino:avr:uno --output-dir build uno-blink   # sketch folder containing uno-blink.ino
```

Each `.hex` is the `build/<name>.ino.hex` output for the `.ino` next to it (arduino:avr 1.8.8).
