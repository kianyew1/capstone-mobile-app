#define CFG_GATT_MAX_MTU_SIZE 247
#include <bluefruit.h>
#include <math.h>
#include <SPI.h>

// Forward declaration to keep Arduino auto-prototypes happy.
struct ADS1298_Sample;

/*
 * ADS1298 ECG with Seeed XIAO nRF52840
 * Adds BLE packet streaming on top of the existing ADS1298 firmware logic.
 *
 * Packet format (228 bytes):
 *   STATUS[1] + CH2[25] + CH3[25] + CH4[25]
 *   Each value is 24-bit, big-endian.
 */

// Pin definitions
#define PIN_DRDY    0   // D0
#define PIN_PWDN    1   // D1 - PWDN and RESET tied together
#define PIN_START   2   // D2
#define PIN_CS      3   // D3
#define PIN_SCLK    8   // D8
#define PIN_MISO    9   // D9
#define PIN_MOSI    10  // D10

// LED
#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

inline void ledOn()  { digitalWrite(LED_BUILTIN, LOW); }
inline void ledOff() { digitalWrite(LED_BUILTIN, HIGH); }

unsigned long lastBlinkMs = 0;
const unsigned long ADV_BLINK_MS  = 500;
const unsigned long FAIL_BLINK_MS = 100;

void blinkNonBlocking(unsigned long intervalMs)
{
  unsigned long now = millis();
  if (now - lastBlinkMs >= intervalMs) {
    lastBlinkMs = now;
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
  }
}

// ADS1298 Commands
#define ADS1298_CMD_WAKEUP   0x02
#define ADS1298_CMD_STANDBY  0x04
#define ADS1298_CMD_RESET    0x06
#define ADS1298_CMD_START    0x08
#define ADS1298_CMD_STOP     0x0A
#define ADS1298_CMD_RDATAC   0x10
#define ADS1298_CMD_SDATAC   0x11
#define ADS1298_CMD_RDATA    0x12
#define ADS1298_CMD_RREG     0x20
#define ADS1298_CMD_WREG     0x40

// ADS1298 Register Addresses
#define ADS1298_REG_ID       0x00
#define ADS1298_REG_CONFIG1  0x01
#define ADS1298_REG_CONFIG2  0x02
#define ADS1298_REG_CONFIG3  0x03
#define ADS1298_REG_LOFF     0x04
#define ADS1298_REG_CH1SET   0x05
#define ADS1298_REG_CH2SET   0x06
#define ADS1298_REG_CH3SET   0x07
#define ADS1298_REG_CH4SET   0x08
#define ADS1298_REG_CH5SET   0x09
#define ADS1298_REG_CH6SET   0x0A
#define ADS1298_REG_CH7SET   0x0B
#define ADS1298_REG_CH8SET   0x0C
#define ADS1298_REG_RLD_SENSP 0x0D
#define ADS1298_REG_RLD_SENSN 0x0E
#define ADS1298_REG_LOFF_SENSP 0x0F
#define ADS1298_REG_LOFF_SENSN 0x10
#define ADS1298_REG_LOFF_FLIP 0x11
#define ADS1298_REG_LOFF_STATP 0x12
#define ADS1298_REG_LOFF_STATN 0x13
#define ADS1298_REG_GPIO     0x14
#define ADS1298_REG_PACE     0x15
#define ADS1298_REG_RESP     0x16
#define ADS1298_REG_CONFIG4  0x17
#define ADS1298_REG_WCT1     0x18
#define ADS1298_REG_WCT2     0x19

// Toggle mock ECG signal (uses synthetic waveform instead of ADS1298 readings)
const bool mock_signal = false;

// Timing constants (in microseconds)
#define T_POR        1000
#define T_CLK        1
#define T_RESET_PULSE 10

// Sample storage
struct ADS1298_Sample {
  uint32_t status;      // 24-bit status word
  int32_t channel[8];   // 8 channels, 24-bit each (sign-extended to 32-bit)
};

volatile uint32_t drdyCount = 0;
uint32_t maxDrdyBacklog = 0;

// Ring buffer for no-loss capture (stores all samples before BLE send)
struct SampleFrame {
  uint32_t status;
  int32_t ch2;
  int32_t ch3;
  int32_t ch4;
};

static const uint16_t RING_CAPACITY = 2000;
static SampleFrame ringBuffer[RING_CAPACITY];
static uint16_t ringHead = 0;
static uint16_t ringTail = 0;
static uint16_t ringCount = 0;
static uint16_t ringMax = 0;

// Synthetic ECG generator (24-bit range)
static float mockPhase = 0.0f;
static const float mockSampleRateHz = 500.0f;
static const float mockHeartRateHz = 1.2f; // ~72 BPM
static const float mockPhaseStep =
  (2.0f * 3.14159265f * mockHeartRateHz) / mockSampleRateHz;
static const uint32_t mockSamplePeriodUs = 2000;
static uint32_t lastMockUs = 0;

int32_t mockEcgWave(float phase, float phaseOffset) {
  // Phase in radians -> normalized cycle [0, 1)
  const float twoPi = 2.0f * 3.14159265f;
  float p = phase + phaseOffset;
  if (p >= twoPi) p -= twoPi;
  float x = p / twoPi;

  // PQRST model as sum of Gaussians + mild baseline wander
  float pWave = 0.12f * expf(-0.5f * powf((x - 0.18f) / 0.025f, 2.0f));
  float qWave = -0.20f * expf(-0.5f * powf((x - 0.46f) / 0.012f, 2.0f));
  float rWave = 1.00f * expf(-0.5f * powf((x - 0.50f) / 0.010f, 2.0f));
  float sWave = -0.25f * expf(-0.5f * powf((x - 0.54f) / 0.015f, 2.0f));
  float tWave = 0.35f * expf(-0.5f * powf((x - 0.76f) / 0.050f, 2.0f));
  float wander = 0.02f * sinf(twoPi * x);

  float value = pWave + qWave + rWave + sWave + tWave + wander;

  // Scale to 24-bit signed range (keep some headroom)
  float scaled = value * 2500000.0f;
  if (scaled > 8388607.0f) scaled = 8388607.0f;
  if (scaled < -8388608.0f) scaled = -8388608.0f;
  return (int32_t)scaled;
}

void fillMockSample(ADS1298_Sample* sample) {
  sample->status = 0xC00000;
  sample->channel[1] = mockEcgWave(mockPhase, 0.0f);
  sample->channel[2] = mockEcgWave(mockPhase, 0.4f);
  sample->channel[3] = mockEcgWave(mockPhase, 0.8f);
  mockPhase += mockPhaseStep;
  if (mockPhase >= 2.0f * 3.14159265f) {
    mockPhase -= 2.0f * 3.14159265f;
  }
}

// Forward declarations to avoid Arduino auto-prototype issues
void packetizerPush(const ADS1298_Sample& s);
bool packetizerReady();
void packetizerBuild(uint8_t* out);
void packetizerConsume();
bool initADS1298();
void sendCommand(uint8_t cmd);
uint8_t readRegister(uint8_t reg);
void writeRegister(uint8_t reg, uint8_t data);
ADS1298_Sample readData();
void drdyInterrupt();
void enableTestSignal();
void disableTestSignal();

// ======================================================
// BLE
// ======================================================
const char* SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
const char* CHAR_UUID    = "87654321-4321-4321-4321-abcdefabcdef";

BLEService ecgService(SERVICE_UUID);
BLECharacteristic ecgChar(CHAR_UUID);

static const float sampleRateHz = 500.0f;
static const int SAMPLES_PER_PACKET = 25;
static const uint32_t packetIntervalUs =
  (uint32_t)(1000000.0f * SAMPLES_PER_PACKET / sampleRateHz);
uint32_t lastSendUs = 0;

// ======================================================
// PACKETIZER (single status + CH2 + CH3 + CH4)
// ======================================================
#define ECG_PACKET_SAMPLES 25
#define ECG_SIGNALS 3
#define ECG_PACKET_BYTES ((1 + (ECG_PACKET_SAMPLES * ECG_SIGNALS)) * 3)

struct ECGFrame {
  int32_t ch2;
  int32_t ch3;
  int32_t ch4;
};

static ECGFrame frameBuffer[ECG_PACKET_SAMPLES];
static volatile uint8_t frameCount = 0;
static uint32_t packetStatus = 0;

void packetizerPush(const ADS1298_Sample& s)
{
  if (frameCount >= ECG_PACKET_SAMPLES) return;

  ECGFrame& f = frameBuffer[frameCount];
  packetStatus = s.status;
  f.ch2 = s.channel[1];
  f.ch3 = s.channel[2];
  f.ch4 = s.channel[3];
  frameCount++;
}

bool packetizerReady()
{
  return frameCount == ECG_PACKET_SAMPLES;
}

void write24(uint8_t* p, int32_t v)
{
  p[0] = (v >> 16) & 0xFF;
  p[1] = (v >> 8) & 0xFF;
  p[2] = v & 0xFF;
}

void packetizerBuild(uint8_t* out)
{
  uint8_t* p = out;

  // STATUS (single)
  write24(p, packetStatus);
  p += 3;

  // CH2 (25 samples)
  for (int i = 0; i < ECG_PACKET_SAMPLES; i++) {
    write24(p, frameBuffer[i].ch2);
    p += 3;
  }

  // CH3 (25 samples)
  for (int i = 0; i < ECG_PACKET_SAMPLES; i++) {
    write24(p, frameBuffer[i].ch3);
    p += 3;
  }

  // CH4 (25 samples)
  for (int i = 0; i < ECG_PACKET_SAMPLES; i++) {
    write24(p, frameBuffer[i].ch4);
    p += 3;
  }
}

void packetizerConsume()
{
  frameCount = 0;
}

// ======================================================
// DEBUG PRINT (periodic stats)
// ======================================================
uint32_t totalPacketsSent = 0;
uint32_t packetsSentThisSecond = 0;
uint32_t notifyFail = 0;
uint32_t notifyFailThisSecond = 0;
uint32_t samplesThisSecond = 0;
uint32_t droppedSamplesThisSecond = 0;
uint32_t droppedSamplesTotal = 0;
uint32_t lastStatsMs = 0;

void printPacketSummary(uint32_t packetNumber)
{
  Serial.print("[BLE] packet#");
  Serial.print(packetNumber);
  Serial.print(" status=0x");
  Serial.print(packetStatus, HEX);

  Serial.print(" ch2=[");
  for (int i = 0; i < ECG_PACKET_SAMPLES; i++) {
    Serial.print(frameBuffer[i].ch2);
    if (i + 1 < ECG_PACKET_SAMPLES) Serial.print(", ");
  }
  Serial.print("] ch3=[");
  for (int i = 0; i < ECG_PACKET_SAMPLES; i++) {
    Serial.print(frameBuffer[i].ch3);
    if (i + 1 < ECG_PACKET_SAMPLES) Serial.print(", ");
  }
  Serial.print("] ch4=[");
  for (int i = 0; i < ECG_PACKET_SAMPLES; i++) {
    Serial.print(frameBuffer[i].ch4);
    if (i + 1 < ECG_PACKET_SAMPLES) Serial.print(", ");
  }
  Serial.println("]");
}

void printStats()
{
  // const uint32_t expectedSamplesPerSec = 500;
  // const uint32_t expectedPacketsPerSec = expectedSamplesPerSec / SAMPLES_PER_PACKET;

  // Serial.print("[STATS] samples/sec=");
  // Serial.print(samplesThisSecond);
  // Serial.print(" packets/sec=");
  // Serial.print(packetsSentThisSecond);
  // Serial.print(" expected_packets/sec=");
  // Serial.print(expectedPacketsPerSec);
  // Serial.print(" notifyFail/sec=");
  // Serial.println(notifyFailThisSecond);
  // Serial.print("[STATS] buffer_fill=");
  // Serial.print(ringCount);
  // Serial.print(" buffer_max=");
  // Serial.print(ringMax);
  // Serial.print(" dropped_samples/sec=");
  // Serial.println(droppedSamplesThisSecond);
  // Serial.print("[STATS] drdy_backlog_max=");
  // Serial.println(maxDrdyBacklog);
  Serial.println("... dropped: ");
  Serial.print(droppedSamplesThisSecond);
  maxDrdyBacklog = 0;
  ringMax = 0;
  droppedSamplesThisSecond = 0;

  samplesThisSecond = 0;
  packetsSentThisSecond = 0;
  notifyFailThisSecond = 0;
}

// ======================================================
// SETUP
// ======================================================
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  ledOff();

  Serial.begin(115200);
  unsigned long serialWaitStart = millis();
  while (!Serial && (millis() - serialWaitStart < 2000)) {
    // wait briefly for serial monitor without blocking forever
  }

  if (initADS1298()) {
    if (Serial) {
      Serial.println("\n✓ ADS1298 Initialized Successfully!");
      Serial.println("Ready to acquire data...\n");
    }
  } else {
    if (Serial) {
      Serial.println("\n✗ ADS1298 Initialization FAILED!");
    }
    while (1) blinkNonBlocking(FAIL_BLINK_MS);
  }

  pinMode(PIN_DRDY, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_DRDY), drdyInterrupt, FALLING);
  enableTestSignal();
  disableTestSignal();

  // ---- BLE init ----
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
  Bluefruit.Periph.setConnInterval(6, 12);

  if (!Bluefruit.begin()) {
    if (Serial) {
      Serial.println("✗ Bluefruit init failed!");
    }
    while (1) blinkNonBlocking(FAIL_BLINK_MS);
  }

  Bluefruit.setTxPower(4);
  Bluefruit.setName("XIAO-ECG");
  ecgService.begin();
  ecgChar.setProperties(CHR_PROPS_NOTIFY);
  ecgChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  ecgChar.setMaxLen(ECG_PACKET_BYTES);
  ecgChar.begin();

  Bluefruit.Advertising.addService(ecgService);
  Bluefruit.Advertising.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.start(0);

  if (Serial) {
    Serial.println("[BLE] Advertising...");
    Serial.print("[BLE] Max MTU (periph)=");
    Serial.println(Bluefruit.getMaxMtu(BLE_GAP_ROLE_PERIPH));
    Serial.print("[BLE] mock_signal=");
    Serial.println(mock_signal ? "true" : "false");
  }
}

void loop() {
  static bool wasConnected = false;
  bool isConnected = Bluefruit.connected();

  // ===== ADC driven acquisition =====
  // Drain pending DRDY events into ring buffer
  uint32_t pending = 0;
  noInterrupts();
  pending = drdyCount;
  drdyCount = 0;
  interrupts();
  if (pending > maxDrdyBacklog) {
    maxDrdyBacklog = pending;
  }
  while (pending > 0) {
    ADS1298_Sample sample = readData();
    if (mock_signal) {
      fillMockSample(&sample);
    }
    samplesThisSecond++;
    if (isConnected) {
      if (ringCount < RING_CAPACITY) {
        ringBuffer[ringHead].status = sample.status;
        ringBuffer[ringHead].ch2 = sample.channel[1];
        ringBuffer[ringHead].ch3 = sample.channel[2];
        ringBuffer[ringHead].ch4 = sample.channel[3];
        ringHead = (ringHead + 1) % RING_CAPACITY;
        ringCount++;
        if (ringCount > ringMax) {
          ringMax = ringCount;
        }
      } else {
        droppedSamplesTotal++;
        droppedSamplesThisSecond++;
      }
    }
    pending--;
  }

  if (mock_signal && isConnected) {
    uint32_t nowMockUs = micros();
    if (lastMockUs == 0) lastMockUs = nowMockUs;
    while ((uint32_t)(nowMockUs - lastMockUs) >= mockSamplePeriodUs) {
      lastMockUs += mockSamplePeriodUs;
      ADS1298_Sample sample;
      fillMockSample(&sample);
      samplesThisSecond++;
      if (ringCount < RING_CAPACITY) {
        ringBuffer[ringHead].status = sample.status;
        ringBuffer[ringHead].ch2 = sample.channel[1];
        ringBuffer[ringHead].ch3 = sample.channel[2];
        ringBuffer[ringHead].ch4 = sample.channel[3];
        ringHead = (ringHead + 1) % RING_CAPACITY;
        ringCount++;
        if (ringCount > ringMax) {
          ringMax = ringCount;
        }
      } else {
        droppedSamplesTotal++;
        droppedSamplesThisSecond++;
      }
    }
  }

  // ===== BLE state =====
  if (!isConnected) {
    if (wasConnected) {
      wasConnected = false;
      ringHead = 0;
      ringTail = 0;
      ringCount = 0;
    }
    blinkNonBlocking(ADV_BLINK_MS);
  } else {
    if (!wasConnected) {
      wasConnected = true;
      if (Serial) {
        Serial.println("[BLE] Connected");
      }
    }
    ledOn();
  }

  // ===== timing (20 ms) =====
  uint32_t nowUs = micros();
  if (lastSendUs == 0) lastSendUs = nowUs;
  if ((uint32_t)(nowUs - lastSendUs) < packetIntervalUs) return;
  lastSendUs += packetIntervalUs;

  if (isConnected) {
    // ===== send only when we have enough samples =====
    if (ringCount >= ECG_PACKET_SAMPLES) {
      static uint8_t packet[ECG_PACKET_BYTES];

      // Build packet from ring buffer without consuming (only consume on success)
      uint16_t idx = ringTail;
      for (int i = 0; i < ECG_PACKET_SAMPLES; i++) {
        SampleFrame f = ringBuffer[idx];
        frameBuffer[i].ch2 = f.ch2;
        frameBuffer[i].ch3 = f.ch3;
        frameBuffer[i].ch4 = f.ch4;
        packetStatus = f.status; // keep last sample status
        idx = (idx + 1) % RING_CAPACITY;
      }
      frameCount = ECG_PACKET_SAMPLES;
      packetizerBuild(packet);

      bool sent = ecgChar.notify(packet, ECG_PACKET_BYTES);
      if (sent) {
        totalPacketsSent++;
        packetsSentThisSecond++;

        // Consume samples only after successful notify
        ringTail = (ringTail + ECG_PACKET_SAMPLES) % RING_CAPACITY;
        ringCount -= ECG_PACKET_SAMPLES;
        packetizerConsume();

        if (Serial && (totalPacketsSent % 100 == 0)) {
          printPacketSummary(totalPacketsSent);
        }
      } else {
        // Still consume to keep streaming continuous, even if no subscriber
        notifyFail++;
        notifyFailThisSecond++;
        ringTail = (ringTail + ECG_PACKET_SAMPLES) % RING_CAPACITY;
        ringCount -= ECG_PACKET_SAMPLES;
        packetizerConsume();
      }
    }
  }

  uint32_t nowMs = millis();
  if (Serial && (nowMs - lastStatsMs >= 1000)) {
    printStats();
    lastStatsMs = nowMs;
  }
}

// ============================================================================
// ADS1298 Functions
// ============================================================================

bool initADS1298() {
  pinMode(PIN_CS, OUTPUT);
  pinMode(PIN_START, OUTPUT);
  pinMode(PIN_PWDN, OUTPUT);
  pinMode(PIN_DRDY, INPUT);

  digitalWrite(PIN_CS, HIGH);
  digitalWrite(PIN_START, LOW);
  digitalWrite(PIN_PWDN, LOW);

  SPI.begin();
  SPI.beginTransaction(SPISettings(2000000, MSBFIRST, SPI_MODE1));

  Serial.println("Step 1: Power-Up Sequence");
  Serial.println("  - CLKSEL = 1 (internal oscillator)");
  Serial.println("  - Setting PWDN = 1, RESET = 1");

  digitalWrite(PIN_PWDN, HIGH);

  Serial.print("  - Waiting ");
  Serial.print(T_POR);
  Serial.println("ms for power-on reset (tPOR)...");
  delay(T_POR);

  Serial.println("  ✓ Assuming VCAP1 >= 1.1V");

  Serial.println("\nStep 2: Issue Reset Pulse");
  digitalWrite(PIN_PWDN, LOW);
  delayMicroseconds(T_RESET_PULSE);
  digitalWrite(PIN_PWDN, HIGH);
  delayMicroseconds(18 * T_CLK);
  Serial.println("  ✓ Reset complete");

  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(10);

  Serial.println("\nStep 3: Send SDATAC Command");
  sendCommand(ADS1298_CMD_SDATAC);
  delay(10);
  Serial.println("  ✓ Device ready for register configuration");

  Serial.println("\nStep 4: Configure Internal Reference");
  Serial.println("  - CONFIG3 = 0xC0 (Enable internal reference, no external reference)");
  writeRegister(ADS1298_REG_CONFIG3, 0xC0);
  delay(150);
  Serial.println("  ✓ Internal reference enabled and settled");

  Serial.println("\nStep 5: Configure Device Registers");
  Serial.println("  - CONFIG1 = 0x86 (HR mode, DR = fMOD/1024 = 500 SPS)");
  writeRegister(ADS1298_REG_CONFIG1, 0x86);

  Serial.println("  - CONFIG2 = 0x00 (Test signals off)");
  writeRegister(ADS1298_REG_CONFIG2, 0x00);

  Serial.println("  - CH1-8SET = 0x00 (Normal input, Gain=6, Powered up)");
  for (int ch = 0; ch < 8; ch++) {
    writeRegister(ADS1298_REG_CH1SET + ch, 0x00);
  }

  delay(10);
  Serial.println("  ✓ All registers configured");

  if (!mock_signal) {
    Serial.println("\nStep 6: Verify Device ID");
    uint8_t deviceID = readRegister(ADS1298_REG_ID);
    Serial.print("  - Device ID: 0x");
    Serial.println(deviceID, HEX);

    if ((deviceID & 0xF8) == 0x98){
      Serial.println("  ✓ ADS1298 detected");
    } else if ((deviceID & 0xF8) == 0x90) {
      Serial.println("  ✓ ADS1296 detected");
    } else if ((deviceID & 0xF8) == 0x88) {
      Serial.println("  ✓ ADS1294 detected");
    } else {
      Serial.println("  ✗ Unknown device!");
      return false;
    }
  } else {
    Serial.println("Mock code and device being used instead");
  }

  Serial.println("\nStep 7: Start Conversion");
  digitalWrite(PIN_START, HIGH);
  sendCommand(ADS1298_CMD_START);
  delay(10);
  Serial.println("  ✓ Conversions started");

  Serial.println("\nStep 8: Enable Continuous Data Mode");
  sendCommand(ADS1298_CMD_RDATAC);
  delay(10);
  Serial.println("  ✓ RDATAC mode active");

  return true;
}

void sendCommand(uint8_t cmd) {
  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(2);
  SPI.transfer(cmd);
  delayMicroseconds(2);
  digitalWrite(PIN_CS, HIGH);
  delayMicroseconds(2);
}

uint8_t readRegister(uint8_t reg) {
  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(2);

  SPI.transfer(ADS1298_CMD_RREG | reg);
  SPI.transfer(0x00);
  delayMicroseconds(2);
  uint8_t data = SPI.transfer(0x00);

  delayMicroseconds(2);
  digitalWrite(PIN_CS, HIGH);
  return data;
}

void writeRegister(uint8_t reg, uint8_t data) {
  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(2);

  SPI.transfer(ADS1298_CMD_WREG | reg);
  SPI.transfer(0x00);
  SPI.transfer(data);

  delayMicroseconds(2);
  digitalWrite(PIN_CS, HIGH);
  delayMicroseconds(2);
}

ADS1298_Sample readData() {
  ADS1298_Sample sample;

  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(2);

  uint8_t stat1 = SPI.transfer(0x00);
  uint8_t stat2 = SPI.transfer(0x00);
  uint8_t stat3 = SPI.transfer(0x00);
  sample.status = ((uint32_t)stat1 << 16) | ((uint32_t)stat2 << 8) | stat3;

  for (int ch = 0; ch < 8; ch++) {
    uint8_t byte1 = SPI.transfer(0x00);
    uint8_t byte2 = SPI.transfer(0x00);
    uint8_t byte3 = SPI.transfer(0x00);

    int32_t value = ((uint32_t)byte1 << 16) | ((uint32_t)byte2 << 8) | byte3;
    if (value & 0x800000) {
      value |= 0xFF000000;
    }
    sample.channel[ch] = value;
  }

  delayMicroseconds(2);
  digitalWrite(PIN_CS, HIGH);
  return sample;
}

void drdyInterrupt() {
  drdyCount++;
}

// ============================================================================
// Optional: Test Signal Functions
// ============================================================================

void enableTestSignal() {
  sendCommand(ADS1298_CMD_SDATAC);
  delay(10);

  writeRegister(ADS1298_REG_CONFIG2, 0x10);

  for (int ch = 0; ch < 8; ch++) {
    writeRegister(ADS1298_REG_CH1SET + ch, 0x05);
  }

  sendCommand(ADS1298_CMD_RDATAC);
  delay(10);

  Serial.println("Test signal enabled on all channels");
}

void disableTestSignal() {
  sendCommand(ADS1298_CMD_SDATAC);
  delay(10);

  writeRegister(ADS1298_REG_CONFIG2, 0x00);

  for (int ch = 0; ch < 8; ch++) {
    writeRegister(ADS1298_REG_CH1SET + ch, 0x00);
  }

  sendCommand(ADS1298_CMD_RDATAC);
  delay(10);

  Serial.println("Test signal disabled, normal input restored");
}
