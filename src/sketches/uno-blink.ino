// Blink: the on-board LED (pin 13) and an external LED on pin 9 alternate.
void setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(9, OUTPUT);
  Serial.println("Uno blink started");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(9, LOW);
  Serial.println("tick");
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  digitalWrite(9, HIGH);
  Serial.println("tock");
  delay(500);
}
