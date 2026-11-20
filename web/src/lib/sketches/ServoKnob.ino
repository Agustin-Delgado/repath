// The Servo library's Knob example: a potentiometer on A0 sets the angle of
// the servo on pin 9.
#include <Servo.h>

Servo myservo;

void setup() {
  myservo.attach(9);
}

void loop() {
  int val = analogRead(A0);
  val = map(val, 0, 1023, 0, 180);
  myservo.write(val);
  delay(15);
}
