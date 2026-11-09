// Button on pin 2 (INPUT_PULLUP, pressed = LOW) switches the LED on pin 9.
// Press and hold the button while the simulation runs.
int last = HIGH;

void setup() {
  Serial.begin(9600);
  pinMode(2, INPUT_PULLUP);
  pinMode(9, OUTPUT);
}

void loop() {
  int b = digitalRead(2);
  digitalWrite(9, b == LOW ? HIGH : LOW);
  if (b != last) {
    Serial.println(b == LOW ? "pressed" : "released");
    last = b;
  }
  delay(5);
}
