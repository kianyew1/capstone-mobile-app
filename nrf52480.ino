#include <bluefruit.h>
#include <math.h>

// ======================================================
// LED STATUS (production-safe)
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
// BLE CONFIGURATION (KEEP FOR FINAL PRODUCT)
// ======================================================
const char* SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
const char* CHAR_UUID    = "87654321-4321-4321-4321-abcdefabcdef";

BLEService ecgService(SERVICE_UUID);
BLECharacteristic ecgChar(CHAR_UUID);

// ======================================================
// STREAMING CONFIG (KEEP FOR FINAL PRODUCT)
// ======================================================

// Desired real sampling rate
static const float sampleRateHz = 500.0f;

// 10 samples per BLE packet
static const int SAMPLES_PER_PACKET = 10;

// 50 packets/sec -> 20ms interval
static const uint32_t packetIntervalUs =
  (uint32_t)(1000000.0f * SAMPLES_PER_PACKET / sampleRateHz);

uint32_t lastSendUs = 0;

// ======================================================
// DEBUG / RATE VERIFICATION (optional for production)
// ======================================================
uint32_t packetsThisSecond = 0;
uint32_t lastStatsMs = 0;
uint32_t notifyOk = 0;
uint32_t notifyFail = 0;


// ======================================================
// 🔵🔵🔵 MOCK ECG SECTION (REMOVE FOR REAL SENSOR) 🔵🔵🔵
// ======================================================
// EVERYTHING INSIDE THIS BLOCK IS SIMULATION ONLY.
// Replace getNextSample() with real ADC sampling later.
// ======================================================

static float phase = 0.0f;
static float bpm = 72.0f;
static const float amplitude = 1200.0f;
static const int16_t noiseAmp = 40;

float syntheticECG(float t) {
  float p  =  0.12f * expf(-powf((t - 0.18f) / 0.035f, 2.0f));
  float q  = -0.15f * expf(-powf((t - 0.40f) / 0.010f, 2.0f));
  float r  =  1.20f * expf(-powf((t - 0.42f) / 0.012f, 2.0f));
  float s  = -0.25f * expf(-powf((t - 0.45f) / 0.012f, 2.0f));
  float tw =  0.35f * expf(-powf((t - 0.70f) / 0.060f, 2.0f));
  return p + q + r + s + tw;
}

// 🔵 THIS FUNCTION IS THE ONLY THING YOU REPLACE LATER
int16_t getNextSample() {

  float baseFreqHz = bpm / 60.0f;
  float phaseStep =
    2.0f * 3.1415926f * baseFreqHz / sampleRateHz;

  float t = phase / (2.0f * 3.1415926f);
  float ecg = syntheticECG(t);

  phase += phaseStep;
  if (phase >= 2.0f * 3.1415926f)
    phase -= 2.0f * 3.1415926f;

  int16_t noise = random(-noiseAmp, noiseAmp + 1);

  int32_t val = (int32_t)(amplitude * ecg) + noise;

  if (val > 32767) val = 32767;
  if (val < -32768) val = -32768;

  return (int16_t)val;
}

// ======================================================
// END OF MOCK SECTION
// ======================================================



// ======================================================
// SETUP
// ======================================================
void setup() {

  pinMode(LED_BUILTIN, OUTPUT);
  ledOff();

  Serial.begin(115200);
  while (!Serial) {}

  Serial.println("\n[ECG STREAMER] Boot");

  if (!Bluefruit.begin()) {
    while (1) blinkNonBlocking(FAIL_BLINK_MS);
  }

  // BLE throughput optimizations (KEEP)
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
  Bluefruit.Periph.setConnInterval(6, 12);
  Bluefruit.setTxPower(4);
  Bluefruit.setName("XIAO-ECG");

  ecgService.begin();

  ecgChar.setProperties(CHR_PROPS_NOTIFY);
  ecgChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  ecgChar.setFixedLen(SAMPLES_PER_PACKET * 2);
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

  // ==================================================
  // PACKET BUILD (THIS STAYS FOR FINAL PRODUCT)
  // ==================================================
  uint8_t packet[SAMPLES_PER_PACKET * 2];

  for (int i = 0; i < SAMPLES_PER_PACKET; i++) {

    // 🔵 CURRENTLY MOCK
    int16_t sample = getNextSample();

    // Pack little-endian
    packet[i * 2]     = (uint8_t)(sample & 0xFF);
    packet[i * 2 + 1] = (uint8_t)((sample >> 8) & 0xFF);
  }

  // ==================================================
  // BLE SEND (KEEP FOR FINAL PRODUCT)
  // ==================================================
  bool sent = ecgChar.notify(packet, sizeof(packet));

  if (sent) {
    notifyOk++;
    packetsThisSecond++;
  } else {
    notifyFail++;
  }

  // Optional runtime verification
  uint32_t nowMs = millis();
  if (nowMs - lastStatsMs >= 1000) {

    Serial.print("[STATS] packets/sec=");
    Serial.print(packetsThisSecond);
    Serial.print(" samples/sec=");
    Serial.print(packetsThisSecond * SAMPLES_PER_PACKET);
    Serial.print(" fail=");
    Serial.println(notifyFail);

    packetsThisSecond = 0;
    lastStatsMs = nowMs;
  }
}
