// Fade: analogWrite() on pin 9 is PWM at ~490 Hz.
// Probe pin 9 on the Scope tab to see the real duty cycle change.
int brightness = 0;
int step = 5;

void setup() {
  pinMode(9, OUTPUT);
}

void loop() {
  analogWrite(9, brightness);
  brightness += step;
  if (brightness <= 0 || brightness >= 255) step = -step;
  delay(30);
}
