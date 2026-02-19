#include <bluefruit.h>
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

// Keep these UUIDs in sync with the mobile app
const char* SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
const char* CHAR_UUID    = "87654321-4321-4321-4321-abcdefabcdef";

BLEService ecgService = BLEService(SERVICE_UUID);
BLECharacteristic ecgChar = BLECharacteristic(CHAR_UUID);

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
  if (!Bluefruit.begin()) {
    Serial.println("[BLE] ERROR: start failed (fast blink)");
    while (1) blinkNonBlocking(FAIL_BLINK_MS);
  }

  Bluefruit.setName("XIAO-ECG");
  Bluefruit.setTxPower(4);
  Bluefruit.autoConnLed(false);

  ecgService.begin();
  ecgChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  ecgChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  ecgChar.setFixedLen(20);
  ecgChar.begin();

  Bluefruit.Advertising.addService(ecgService);
  Bluefruit.Advertising.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);

  Serial.println("[BLE] Advertising as XIAO-ECG");
}

// --- single-lead ECG sim state (phase accumulator) ---
float phase = 0.0f;
uint32_t seq = 0;

// Signal knobs (tweak as you like)
const float baseFreqHz = 1.2f;       // ~72 bpm
const float amplitude = 1200.0f;     // base amplitude
const int16_t noiseAmp = 80;         // noise amplitude (±noiseAmp)
const float phaseStep = 2.0f * 3.1415926f * baseFreqHz / 500.0f; // per-sample at 500 Hz

// 10 samples per packet at 500 Hz => 20 ms per packet
const uint32_t packetIntervalUs = 20000;
uint32_t lastSendUs = 0;
uint32_t packetCount = 0;

void loop() {
  // Advertising indicator (slow blink) whenever not connected
  if (!Bluefruit.connected()) {
    blinkNonBlocking(ADV_BLINK_MS);
  } else {
    ledOn();
  }

  const uint32_t nowUs = micros();
  if (lastSendUs == 0) lastSendUs = nowUs;
  if ((uint32_t)(nowUs - lastSendUs) < packetIntervalUs) {
    return;
  }
  lastSendUs += packetIntervalUs;

  // Build 10 samples (single lead) => 10 int16 -> 20 bytes payload
  int16_t frameSamples[10];
  for (int i = 0; i < 10; i++) {
    float s = sinf(phase);
    float s2 = sinf(phase * 2.0f);
    phase += phaseStep;
    if (phase >= 2.0f * 3.1415926f) phase -= 2.0f * 3.1415926f;

    int16_t noise = (int16_t)random(-noiseAmp, noiseAmp + 1);

    int32_t ch = (int32_t)(amplitude * (s + 0.15f * s2)) + noise;

    // Clamp to int16 range
    if (ch > 32767) ch = 32767;
    if (ch < -32768) ch = -32768;

    frameSamples[i] = (int16_t)ch;
  }

  uint8_t packet[20] = {0};
  for (int i = 0; i < 10; i++) {
    uint16_t v = (uint16_t)frameSamples[i];
    packet[i * 2]     = (uint8_t)(v & 0xFF);
    packet[i * 2 + 1] = (uint8_t)((v >> 8) & 0xFF);
  }

  // Always advance seq so stream is continuous even when not connected
  seq++;

  if (Bluefruit.connected()) {
    ecgChar.notify(packet, sizeof(packet));
    packetCount++;
    if ((packetCount % 50) == 0) {
      Serial.print("[BLE] Sent packets: ");
      Serial.print(packetCount);
      Serial.print(" | sample0=");
      Serial.println(frameSamples[0]);
    }
  }
}
