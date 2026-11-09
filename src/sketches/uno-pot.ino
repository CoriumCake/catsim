// Potentiometer on A0 sets the LED brightness on pin 9 and is printed to Serial.
void setup() {
  Serial.begin(9600);
  pinMode(9, OUTPUT);
}

void loop() {
  int raw = analogRead(A0);          // 10-bit ADC: 0..1023
  analogWrite(9, raw / 4);           // 8-bit PWM
  Serial.print("A0 = ");
  Serial.print(raw);
  Serial.print("  (");
  Serial.print(raw * 5.0 / 1023.0);
  Serial.println(" V)");
  delay(200);
}
