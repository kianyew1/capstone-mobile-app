#include <ArduinoBLE.h>
#include <math.h>

// LED Blink Legend (BLE Status)
// Fast blink (100 ms)  = BLE start failed
// Slow blink (500 ms)  = Advertising / waiting for connection
// Solid ON             = Connected + sending notifications
// OFF                  = Disconnected / idle

// XIAO nRF52840 onboard LED is commonly active-LOW (LOW=ON, HIGH=OFF)
#ifndef LED_BUILTIN
  #define LED_BUILTIN 2
#endif
inline void ledOn()  { digitalWrite(LED_BUILTIN, LOW); }
inline void ledOff() { digitalWrite(LED_BUILTIN, HIGH); }
inline void ledToggle() {
  static bool on = false;
  on = !on;
  on ? ledOn() : ledOff();
}

// Keep these UUIDs in sync with the mobile app:
// mobile-app/src/ble/bleAdapter.js
const char* SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
const char* CHAR_UUID    = "87654321-4321-4321-4321-abcdefabcdef";

BLEService ecgService(SERVICE_UUID);
// 20 bytes = 10 int16 samples
BLECharacteristic ecgChar(CHAR_UUID, BLERead | BLENotify, 20);

// --- blink timing ---
unsigned long lastBlinkMs = 0;
const unsigned long ADV_BLINK_MS  = 500;
const unsigned long FAIL_BLINK_MS = 100;

void blinkNonBlocking(unsigned long intervalMs) {
  unsigned long now = millis();
  if (now - lastBlinkMs >= intervalMs) {
    lastBlinkMs = now;
    ledToggle();
  }
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  ledOff();

  Serial.begin(115200);
  while (!Serial) {}

  Serial.println("\n[XIAO-ECG] Boot");

  // Seed RNG (gives different noise each boot)
  randomSeed(analogRead(A0));

  Serial.println("[BLE] begin()");
  if (!BLE.begin()) {
    Serial.println("[BLE] ERROR: start failed (fast blink)");
    while (1) blinkNonBlocking(FAIL_BLINK_MS);
  }

  BLE.setDeviceName("XIAO-ECG");
  BLE.setLocalName("XIAO-ECG");
  BLE.setAdvertisedService(ecgService);

  ecgService.addCharacteristic(ecgChar);
  BLE.addService(ecgService);

  // Initialize characteristic
  ecgChar.writeValue((const uint8_t*)"\0\0", 2);

  BLE.advertise();
  Serial.println("[BLE] Advertising as XIAO-ECG");
}

void loop() {
  // Advertising indicator (slow blink) whenever not connected
  if (!BLE.connected()) {
    blinkNonBlocking(ADV_BLINK_MS);
  }

  BLEDevice central = BLE.central();
  if (!central) return;

  // Connected indicator (solid ON)
  ledOn();
  Serial.print("[BLE] Connected: ");
  Serial.println(central.address());

  // --- single variable sine-wave state (phase accumulator) ---
  float phase = 0.0f;

  // Signal knobs (tweak as you like)
  const float phaseStep = 2.0f * 3.1415926f * 1.2f * 0.05f; // ~1.2 Hz at 20 Hz packet rate
  const float amplitude = 1200.0f;                          // base sine amplitude
  const int16_t noiseAmp = 180;                             // noise amplitude (±noiseAmp)

  uint32_t packetCount = 0;

  while (central.connected()) {
    int16_t samples[10];

    // Build 10 samples per notification
    for (int i = 0; i < 10; i++) {
      // Noisy sine (single variable: phase)
      float s = sinf(phase);
      phase += phaseStep;
      if (phase >= 2.0f * 3.1415926f) phase -= 2.0f * 3.1415926f;

      int16_t noise = (int16_t)random(-noiseAmp, noiseAmp + 1);
      int32_t v = (int32_t)(amplitude * s) + noise;

      // Clamp to int16 range (safety)
      if (v > 32767) v = 32767;
      if (v < -32768) v = -32768;

      samples[i] = (int16_t)v;
    }

    // Pack 10x int16_t => 20 bytes (little-endian)
    uint8_t payload[20];
    for (int i = 0; i < 10; i++) {
      payload[i * 2]     = (uint8_t)(samples[i] & 0xFF);         // LSB
      payload[i * 2 + 1] = (uint8_t)((samples[i] >> 8) & 0xFF);  // MSB
    }

    // This line sends the fake ECG samples over BLE (notify)
    ecgChar.writeValue(payload, sizeof(payload));
    packetCount++;

    // Log occasionally (avoid flooding)
    if ((packetCount % 20) == 0) {
      Serial.print("[BLE] Sent packets: ");
      Serial.print(packetCount);
      Serial.print(" | sample0=");
      Serial.println(samples[0]);
    }

    delay(50); // 20 Hz notify rate
  }

  Serial.println("[BLE] Disconnected");
  ledOff();
  lastBlinkMs = millis();
}
