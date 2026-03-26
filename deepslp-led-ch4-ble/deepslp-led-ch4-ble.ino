#define CFG_GATT_MAX_MTU_SIZE 247
#include <bluefruit.h>
#include <SPI.h>
#include <Adafruit_NeoPixel.h>

// Forward declaration to keep Arduino auto-prototypes happy.
struct ADS1298_Sample;

// Pin definitions
#define PIN_DRDY    0   // D0
#define PIN_PWDN    1   // D1 - PWDN and RESET tied together
#define PIN_START   2   // D2
#define PIN_CS      3   // D3
#define PIN_ADC     4   // D4
#define PIN_STRIP   5   // D5
#define PIN_BTN     6   // D6
#define PIN_SCLK    8   // D8
#define PIN_MISO    9   // D9
#define PIN_MOSI    10  // D10

inline void ledOn()  { digitalWrite(LED_BUILTIN, LOW); }
inline void ledOff() { digitalWrite(LED_BUILTIN, HIGH); }

unsigned long lastBlinkMs = 0;
const unsigned long ADV_BLINK_MS  = 500;
const unsigned long FAIL_BLINK_MS = 100;
int T_DEBOUNCE = 3000;

// For LED
Adafruit_NeoPixel strip(6, PIN_STRIP, NEO_GRB + NEO_KHZ800);
const unsigned long LED_ON_DURATION_MS = 5000;
unsigned long BTN_PRESS_MS = 0;
bool BTN_PRESSED = false;
bool LED_ON = false;

void blinkNonBlocking(unsigned long intervalMs){
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

// Sample storage
struct ADS1298_Sample {
  uint32_t status;  // 24-bit status word
  int32_t ch2;
  int32_t ch3;
  int32_t ch4;
};

// Ring buffer for no-loss capture (stores all samples before BLE send)
struct SampleFrame {
  uint32_t status;
  int32_t ch2;
  int32_t ch3;
  int32_t ch4;
};

// Buffer varaibales
static const uint16_t RING_CAPACITY = 2000;
static SampleFrame ringBuffer[RING_CAPACITY];
static uint16_t ringHead = 0;
static uint16_t ringTail = 0;
static uint16_t ringCount = 0;
static uint16_t ringMax = 0;

volatile uint32_t drdyCount = 0;
uint32_t drdyEventsThisSecond = 0;
uint32_t maxDrdyBacklog = 0;

// Forward declarations to avoid Arduino auto-prototype issues
void packetizerBuild(uint8_t* out);
bool initADS1298();
void sendCommand(uint8_t cmd);
uint8_t readRegister(uint8_t reg);
void writeRegister(uint8_t reg, uint8_t data);
ADS1298_Sample readData();
void drdyInterrupt();
void enableTestSignal();
void disableTestSignal();
void updateLED(int PIN);
void goToDeepSleep();
void enqueueSample(const ADS1298_Sample& sample);
void write24(uint8_t* p, int32_t v);
void printStats();

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
uint32_t packetsSentThisSecond = 0;
uint32_t notifyFailThisSecond = 0;
uint32_t samplesThisSecond = 0;
uint32_t samplesEnqueuedThisSecond = 0;
uint32_t droppedSamplesThisSecond = 0;
uint32_t droppedSamplesTotal = 0;
uint32_t lastStatsMs = 0;

// ======================================================
// PACKETIZER (single status + CH2 + CH3 + CH4)
// ======================================================
#define ECG_PACKET_SAMPLES 25
#define ECG_SIGNALS 3
#define ECG_PACKET_BYTES ((1 + (ECG_PACKET_SAMPLES * ECG_SIGNALS)) * 3)

void write24(uint8_t* p, int32_t v){
  p[0] = (v >> 16) & 0xFF;
  p[1] = (v >> 8) & 0xFF;
  p[2] = v & 0xFF;
}

void packetizerBuild(uint8_t* out){
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

void enqueueSample(const ADS1298_Sample& sample){
  if (ringCount < RING_CAPACITY) {
    ringBuffer[ringHead].status = sample.status;
    ringBuffer[ringHead].ch2 = sample.ch2;
    ringBuffer[ringHead].ch3 = sample.ch3;
    ringBuffer[ringHead].ch4 = sample.ch4;
    ringHead = (ringHead + 1) % RING_CAPACITY;
    ringCount++;
    samplesEnqueuedThisSecond++;
    if (ringCount > ringMax) {
      ringMax = ringCount;
    }
  } else {
    droppedSamplesTotal++;
    droppedSamplesThisSecond++;
  }
}

void printStats(){
  Serial.print("[STATS] samples_5s=");
  Serial.print(samplesThisSecond);
  Serial.print(" packets_5s=");
  Serial.print(packetsSentThisSecond);
  Serial.print(" samples_enqueued_5s=");
  Serial.print(samplesEnqueuedThisSecond);
  Serial.print(" samples_in_queue_currently=");
  Serial.print(ringCount);
  Serial.print(" drdy_events_5s=");
  Serial.print(drdyEventsThisSecond);
  Serial.println();
  maxDrdyBacklog = 0;
  ringMax = 0;
  droppedSamplesThisSecond = 0;

  samplesThisSecond = 0;
  samplesEnqueuedThisSecond = 0;
  packetsSentThisSecond = 0;
  notifyFailThisSecond = 0;
  drdyEventsThisSecond = 0;
}

// ======================================================
// SETUP
// ======================================================
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(PIN_BTN, INPUT_PULLUP);
  ledOff();

  Serial.begin(115200);
  unsigned long serialWaitStart = millis();
  while (!Serial && (millis() - serialWaitStart < 2000));

  // ---- ADS init ----

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

  // ---- LED init ----
  strip.begin();
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
  // When is maxDrdyBacklog read that is signifcant
  if (pending > maxDrdyBacklog) {
    maxDrdyBacklog = pending;
  }
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

  // Ensure packets are spaced at least packetIntervalUs apart
  uint32_t nowUs = micros();
  if (lastSendUs == 0) lastSendUs = nowUs;
  // LastSendUS
  static uint8_t packet[ECG_PACKET_BYTES];
  while (isStreaming &&
         (uint32_t)(nowUs - lastSendUs) >= packetIntervalUs &&
         ringCount >= ECG_PACKET_SAMPLES) {
    packetizerBuild(packet);

    bool sent = ecgChar.notify(packet, ECG_PACKET_BYTES);
    if (!sent) {
      notifyFailThisSecond++;
      break;
    }

    packetsSentThisSecond++;
    ringTail = (ringTail + ECG_PACKET_SAMPLES) % RING_CAPACITY;
    ringCount -= ECG_PACKET_SAMPLES;
    lastSendUs += packetIntervalUs;
    nowUs = micros();
  }

  uint32_t nowMs = millis();
  if (Serial && (nowMs - lastStatsMs >= 5000)) {
    printStats();
    lastStatsMs = nowMs;
  }

  // Button press logic (noncritical: run after acquisition + BLE send)
  if(digitalRead(PIN_BTN) == LOW){
    if(!BTN_PRESSED){
      // Rising edge
      BTN_PRESSED = true;
      BTN_PRESS_MS = millis();
      LED_ON = true;
      updateLED(PIN_ADC);
    }
    if((millis()-BTN_PRESS_MS)>=T_DEBOUNCE){
      NRF_GPIOTE->EVENTS_PORT = 0;
      strip.clear();
      strip.show();
      while(digitalRead(PIN_BTN) == LOW);// Wait for button release
      delay(250);
      goToDeepSleep();
    }
  }else{
    BTN_PRESSED = false;
    if(LED_ON && BTN_PRESS_MS+LED_ON_DURATION_MS < millis()){
      LED_ON = false;
      strip.clear();
      strip.show();
    }
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
  uint8_t config1_readback = readRegister(ADS1298_REG_CONFIG1);
  Serial.print("  - CONFIG1 readback: 0x");
  Serial.println(config1_readback, HEX);

  Serial.println("  - CONFIG2 = 0x00 (Test signals off)");
  writeRegister(ADS1298_REG_CONFIG2, 0x00);

  Serial.println("  - CH1-8SET = 0x00 (Normal input, Gain=6, Powered up)");
  for (int ch = 0; ch < 8; ch++) {
    writeRegister(ADS1298_REG_CH1SET + ch, 0x00);
  }

  Serial.println("  • Configuring Wilson Central Terminal (WCT)...");
  Serial.println("    WCT1 (0x18): Power up WCTA, route CH2P");
  Serial.println("    WCT2 (0x19): Power up WCTB and WCTC, route CH2N and CH3P");// WCT1 (Address 0x18):
  
  // Bit 7-4: aVF_CH6, aVL_CH5, aVR_CH7, aVR_CH4 = 0000 (not used)
  // Bit 3: PD_WCTA = 0 (power up WCTA)
  // Bits 2-0: WCTA[2:0] = 011 (route CH2P to WCTA)
  // = 0b00000011 = 0x03
  writeRegister(ADS1298_REG_WCT1, 0x0A);// WCT2 (Address 0x19):
  
  // Bit 7: PD_WCTC = 0 (power up WCTC)
  // Bit 6: PD_WCTB = 0 (power up WCTB)
  // Bits 5-3: WCTC[2:0] = 101 (route CH3P to WCTC)
  // Bits 2-0: WCTB[2:0] = 010 (route CH2N to WCTB)
  // = 0b00101010 = 0x2A
  writeRegister(ADS1298_REG_WCT2, 0xE3);

  delay(10);
  Serial.println("  ✓ All registers configured");

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
    // return false;
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

  // CH1 (discarded, but still clocked out)
  SPI.transfer(0x00);
  SPI.transfer(0x00);
  SPI.transfer(0x00);

  // CH2
  uint8_t ch2_1 = SPI.transfer(0x00);
  uint8_t ch2_2 = SPI.transfer(0x00);
  uint8_t ch2_3 = SPI.transfer(0x00);

  int32_t ch2 = ((uint32_t)ch2_1 << 16) | ((uint32_t)ch2_2 << 8) | ch2_3;
  if (ch2 & 0x800000) {
    ch2 |= 0xFF000000;
  }
  sample.ch2 = ch2;

  // CH3
  uint8_t ch3_1 = SPI.transfer(0x00);
  uint8_t ch3_2 = SPI.transfer(0x00);
  uint8_t ch3_3 = SPI.transfer(0x00);

  int32_t ch3 = ((uint32_t)ch3_1 << 16) | ((uint32_t)ch3_2 << 8) | ch3_3;
  if (ch3 & 0x800000) {
    ch3 |= 0xFF000000;
  }
  sample.ch3 = ch3;

  // CH4
  uint8_t ch4_1 = SPI.transfer(0x00);
  uint8_t ch4_2 = SPI.transfer(0x00);
  uint8_t ch4_3 = SPI.transfer(0x00);

  int32_t ch4 = ((uint32_t)ch4_1 << 16) | ((uint32_t)ch4_2 << 8) | ch4_3;
  if (ch4 & 0x800000) {
    ch4 |= 0xFF000000;
  }
  sample.ch4 = ch4;

  // CH5-CH8 (discarded, but still clocked out)
  for (int i = 0; i < 4; i++) {
    SPI.transfer(0x00);
    SPI.transfer(0x00);
    SPI.transfer(0x00);
  }

  delayMicroseconds(2);
  digitalWrite(PIN_CS, HIGH);
  return sample;
}

void drdyInterrupt() {
  drdyCount++;
  drdyEventsThisSecond++;
}

// ============================================================================
// Test Signal Functions
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

// ============================================================================
// Deep Sleep helper function
// ============================================================================

void goToDeepSleep() {
  Serial.println("Entering Deepsleep");
  delay(100); // Give Serial time to flush
  
  // Turn LED OFF
  digitalWrite(LED_BUILTIN, HIGH);
  
  // Disable Serial to save power
  Serial.flush();
  delay(50);
  Serial.end();
  delay(1000);

  // Configure the button pin to wake the device
  // SENSE_LOW tells the chip to wake up when this pin hits GND
  // 43 is the nrf's version of the chip number D6=P1:11 = 32+11
  nrf_gpio_cfg_sense_input(43, NRF_GPIO_PIN_PULLUP, NRF_GPIO_PIN_SENSE_LOW);
  // Trigger System OFF
  NRF_POWER->SYSTEMOFF = 1;
}

// ============================================================================
// LED helper function
// ============================================================================

void updateLED(int PIN){
  int value = analogRead(PIN); // Number between 0-255
  float bar = 167; //Threshold before it goes to the next bar
  strip.clear();
  for (int i = 0; i < 6; i++) {
    if(value>=i*bar){
      strip.setPixelColor(i, strip.Color(127, 0, 0));
    }
  }
  strip.show();
}
