#define CFG_GATT_MAX_MTU_SIZE 247
#include <bluefruit.h>
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

// Timing constants (in microseconds)
#define T_POR        1000
#define T_CLK        1
#define T_RESET_PULSE 10
#define ADS1298_SPI_HZ 2000000

// Sample storage
struct ADS1298_Sample {
  uint32_t status;      // 24-bit status word
  int32_t channel[8];   // 8 channels, 24-bit each (sign-extended to 32-bit)
};

volatile uint32_t drdyCount = 0;

// Ring buffer for sample capture ahead of BLE packetization.
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

// Forward declarations to avoid Arduino auto-prototype issues
void packetizerBuild(uint8_t* out);
bool initADS1298();
void sendCommand(uint8_t cmd);
uint8_t readRegister(uint8_t reg);
void writeRegister(uint8_t reg, uint8_t data);
ADS1298_Sample readData();
void drdyInterrupt();
void enqueueSample(const ADS1298_Sample& sample);

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
const uint32_t STATS_INTERVAL_MS = 5000;

// ======================================================
// PACKETIZER (single status + CH2 + CH3 + CH4)
// ======================================================
#define ECG_PACKET_SAMPLES 25
#define ECG_SIGNALS 3
#define ECG_PACKET_BYTES ((1 + (ECG_PACKET_SAMPLES * ECG_SIGNALS)) * 3)

void write24(uint8_t* p, int32_t v)
{
  p[0] = (v >> 16) & 0xFF;
  p[1] = (v >> 8) & 0xFF;
  p[2] = v & 0xFF;
}

void packetizerBuild(uint8_t* out)
{
  uint8_t* p = out;
  uint16_t idx = ringTail;
  uint32_t packetStatus = ringBuffer[(ringTail + ECG_PACKET_SAMPLES - 1) % RING_CAPACITY].status;

  // STATUS (single)
  write24(p, packetStatus);
  p += 3;

  // CH2 (25 samples)
  for (int i = 0; i < ECG_PACKET_SAMPLES; i++) {
    write24(p, ringBuffer[idx].ch2);
    p += 3;
    idx = (idx + 1) % RING_CAPACITY;
  }

  idx = ringTail;
  // CH3 (25 samples)
  for (int i = 0; i < ECG_PACKET_SAMPLES; i++) {
    write24(p, ringBuffer[idx].ch3);
    p += 3;
    idx = (idx + 1) % RING_CAPACITY;
  }

  idx = ringTail;
  // CH4 (25 samples)
  for (int i = 0; i < ECG_PACKET_SAMPLES; i++) {
    write24(p, ringBuffer[idx].ch4);
    p += 3;
    idx = (idx + 1) % RING_CAPACITY;
  }
}

void enqueueSample(const ADS1298_Sample& sample)
{
  if (ringCount >= RING_CAPACITY) {
    droppedSamplesTotal++;
    droppedSamplesThisSecond++;
    return;
  }

  ringBuffer[ringHead].status = sample.status;
  // Match the known-good standalone reader in `testnew.ino`:
  // ADS channel 2 -> CH2, ADS channel 3 -> CH3, ADS channel 4 -> CH4.
  ringBuffer[ringHead].ch2 = sample.channel[1];
  ringBuffer[ringHead].ch3 = sample.channel[2];
  ringBuffer[ringHead].ch4 = sample.channel[3];
  ringHead = (ringHead + 1) % RING_CAPACITY;
  ringCount++;
  if (ringCount > ringMax) {
    ringMax = ringCount;
  }
}

void printStats()
{
  const uint32_t expectedSamplesPerInterval = (uint32_t)(sampleRateHz * (STATS_INTERVAL_MS / 1000.0f));
  const uint32_t expectedPacketsPerInterval = expectedSamplesPerInterval / SAMPLES_PER_PACKET;

  Serial.print("[STATS] samples/");
  Serial.print(STATS_INTERVAL_MS / 1000);
  Serial.print("s=");
  Serial.print(samplesThisSecond);
  Serial.print(" packets/");
  Serial.print(STATS_INTERVAL_MS / 1000);
  Serial.print("s=");
  Serial.print(packetsSentThisSecond);
  Serial.print(" expected_samples=");
  Serial.print(expectedSamplesPerInterval);
  Serial.print(" expected_packets=");
  Serial.print(expectedPacketsPerInterval);
  Serial.print(" notifyFail=");
  Serial.print(notifyFailThisSecond);
  Serial.print(" buffer_fill=");
  Serial.print(ringCount);
  Serial.print(" buffer_max=");
  Serial.print(ringMax);
  Serial.print(" dropped_samples=");
  Serial.print(droppedSamplesThisSecond);
  Serial.print(" dropped_total=");
  Serial.println(droppedSamplesTotal);

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
  }
}

void loop() {
  static bool wasConnected = false;
  static bool wasStreaming = false;
  bool isConnected = Bluefruit.connected();
  bool isStreaming = isConnected && ecgChar.notifyEnabled();

  // ===== ADC driven acquisition =====
  // Drain pending DRDY events into ring buffer
  uint32_t pending = 0;
  noInterrupts();
  pending = drdyCount;
  drdyCount = 0;
  interrupts();
  while (pending > 0) {
    ADS1298_Sample sample = readData();
    samplesThisSecond++;
    if (isStreaming) {
      enqueueSample(sample);
    }
    pending--;
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
  if (wasStreaming && !isStreaming) {
    ringHead = 0;
    ringTail = 0;
    ringCount = 0;
    drdyCount = 0;
  } else if (!isStreaming && ringCount > 0) {
    ringHead = 0;
    ringTail = 0;
    ringCount = 0;
  }
  wasStreaming = isStreaming;

  // ===== timing (50 ms @ 25 samples/packet, 500 SPS) =====
  uint32_t nowUs = micros();
  if (lastSendUs == 0) lastSendUs = nowUs;
  if (!isStreaming) {
    return;
  }

  static uint8_t packet[ECG_PACKET_BYTES];
  while ((uint32_t)(nowUs - lastSendUs) >= packetIntervalUs &&
         ringCount >= ECG_PACKET_SAMPLES) {
    packetizerBuild(packet);

    bool sent = ecgChar.notify(packet, ECG_PACKET_BYTES);
    if (!sent) {
      notifyFail++;
      notifyFailThisSecond++;
      break;
    }

    totalPacketsSent++;
    packetsSentThisSecond++;

    ringTail = (ringTail + ECG_PACKET_SAMPLES) % RING_CAPACITY;
    ringCount -= ECG_PACKET_SAMPLES;
    lastSendUs += packetIntervalUs;
    nowUs = micros();
  }

  uint32_t nowMs = millis();
  if (Serial && (nowMs - lastStatsMs >= STATS_INTERVAL_MS)) {
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
  SPI.beginTransaction(SPISettings(ADS1298_SPI_HZ, MSBFIRST, SPI_MODE1));

  digitalWrite(PIN_PWDN, HIGH);
  delay(T_POR);

  digitalWrite(PIN_PWDN, LOW);
  delayMicroseconds(T_RESET_PULSE);
  digitalWrite(PIN_PWDN, HIGH);
  delayMicroseconds(18 * T_CLK);

  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(10);

  sendCommand(ADS1298_CMD_SDATAC);
  delay(10);


  writeRegister(ADS1298_REG_CONFIG3, 0xC0);
  delay(150);

  writeRegister(ADS1298_REG_CONFIG1, 0x86);
  writeRegister(ADS1298_REG_CONFIG2, 0x00);
  for (int ch = 0; ch < 8; ch++) {
    writeRegister(ADS1298_REG_CH1SET + ch, 0x00);
  }

  // Match the working WCT routing from `testnew.ino`.
  writeRegister(ADS1298_REG_WCT1, 0x0A);
  writeRegister(ADS1298_REG_WCT2, 0xE3);

  delay(10);

  uint8_t deviceID = readRegister(ADS1298_REG_ID);
  if ((deviceID & 0xF8) != 0x98 &&
      (deviceID & 0xF8) != 0x90 &&
      (deviceID & 0xF8) != 0x88 &&
      (deviceID & 0xF8) != 0x80 ){
    if (Serial) {
      Serial.print("ADS129x device check failed, ID=0x");
      Serial.println(deviceID, HEX);
    }
    return false;
  }

  digitalWrite(PIN_START, HIGH);
  sendCommand(ADS1298_CMD_START);
  delay(10);

  sendCommand(ADS1298_CMD_RDATAC);
  delay(10);

  if (Serial) {
    Serial.print("[ADS] ID=0x");
    Serial.print(deviceID, HEX);
    Serial.print(" WCT1=0x");
    Serial.print(readRegister(ADS1298_REG_WCT1), HEX);
    Serial.print(" WCT2=0x");
    Serial.println(readRegister(ADS1298_REG_WCT2), HEX);
  }

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
