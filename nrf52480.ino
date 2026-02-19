#include <bluefruit.h>
#include <math.h>

// ======================================================
// LED STATUS
// ======================================================
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

// ======================================================
// BLE SETUP
// ======================================================
const char* SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
const char* CHAR_UUID    = "87654321-4321-4321-4321-abcdefabcdef";

BLEService ecgService(SERVICE_UUID);
BLECharacteristic ecgChar(CHAR_UUID);

// ======================================================
// ECG SIMULATION (Single Channel @ 500 Hz)
// ======================================================
float phase = 0.0f;

const float sampleRateHz = 500.0f;
const float baseFreqHz   = 1.2f;      // ~72 bpm
const float amplitude    = 1200.0f;
const int16_t noiseAmp   = 80;

const float phaseStep =
  2.0f * 3.1415926f * baseFreqHz / sampleRateHz;

const int SAMPLES_PER_PACKET = 10;    // 10 samples per BLE notify
const uint32_t packetIntervalUs =
  (uint32_t)(1000000.0f * SAMPLES_PER_PACKET / sampleRateHz); // 20000 us

uint32_t lastSendUs = 0;

// ======================================================
// DEBUG / VERIFICATION COUNTERS
// ======================================================
uint32_t notifyOk = 0;
uint32_t notifyFail = 0;

uint32_t packetsThisSecond = 0;
uint32_t lastStatsMs = 0;

// ======================================================
// SETUP
// ======================================================
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  ledOff();

  Serial.begin(115200);
  while (!Serial) {}

  Serial.println("\n[XIAO-ECG 500Hz TEST] Boot");

  randomSeed(analogRead(A0));

  if (!Bluefruit.begin()) {
    Serial.println("[BLE] ERROR: start failed");
    while (1) blinkNonBlocking(FAIL_BLINK_MS);
  }

  Bluefruit.setName("XIAO-ECG");
  Bluefruit.setTxPower(4);
  Bluefruit.autoConnLed(false);

  ecgService.begin();

  ecgChar.setProperties(CHR_PROPS_NOTIFY);
  ecgChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  ecgChar.setFixedLen(SAMPLES_PER_PACKET * 2); // 20 bytes
  ecgChar.begin();

  Bluefruit.Advertising.addService(ecgService);
  Bluefruit.Advertising.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.start(0);

  Serial.println("[BLE] Advertising...");
}

// ======================================================
// LOOP
// ======================================================
void loop() {

  if (!Bluefruit.connected()) {
    blinkNonBlocking(ADV_BLINK_MS);
    return;
  }

  ledOn();

  uint32_t nowUs = micros();
  if (lastSendUs == 0) lastSendUs = nowUs;

  if ((uint32_t)(nowUs - lastSendUs) < packetIntervalUs)
    return;

  lastSendUs += packetIntervalUs;

  // --------------------------------------------------
  // Generate 10 ECG samples (single channel)
  // --------------------------------------------------
  uint8_t packet[SAMPLES_PER_PACKET * 2];

  for (int i = 0; i < SAMPLES_PER_PACKET; i++) {

    float s  = sinf(phase);
    float s2 = sinf(phase * 2.0f);

    phase += phaseStep;
    if (phase >= 2.0f * 3.1415926f)
      phase -= 2.0f * 3.1415926f;

    int16_t noise =
      (int16_t)random(-noiseAmp, noiseAmp + 1);

    int32_t val =
      (int32_t)(amplitude * (s + 0.15f * s2)) + noise;

    if (val > 32767) val = 32767;
    if (val < -32768) val = -32768;

    int16_t sample = (int16_t)val;

    packet[i * 2]     = (uint8_t)(sample & 0xFF);
    packet[i * 2 + 1] = (uint8_t)((sample >> 8) & 0xFF);
  }

  // --------------------------------------------------
  // Send via BLE and track actual throughput
  // --------------------------------------------------
  bool sent = ecgChar.notify(packet, sizeof(packet));

  if (sent) {
    notifyOk++;
    packetsThisSecond++;
  } else {
    notifyFail++;
  }

  // --------------------------------------------------
  // Print true throughput every second
  // --------------------------------------------------
  uint32_t nowMs = millis();
  if (nowMs - lastStatsMs >= 1000) {

    uint32_t samplesPerSec =
      packetsThisSecond * SAMPLES_PER_PACKET;

    Serial.print("[STATS] packets/sec=");
    Serial.print(packetsThisSecond);
    Serial.print(" samples/sec=");
    Serial.print(samplesPerSec);
    Serial.print(" notify ok=");
    Serial.print(notifyOk);
    Serial.print(" fail=");
    Serial.println(notifyFail);

    packetsThisSecond = 0;
    lastStatsMs = nowMs;
  }
}
