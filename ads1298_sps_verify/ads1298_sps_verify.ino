#include <SPI.h>

// Pin definitions
#define PIN_DRDY    0   // D0
#define PIN_PWDN    1   // D1 - PWDN and RESET tied together
#define PIN_START   2   // D2
#define PIN_CS      3   // D3
#define PIN_SCLK    8   // D8
#define PIN_MISO    9   // D9
#define PIN_MOSI    10  // D10

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

// Minimal sample holder for SPI alignment during reads.
struct ADS1298_Sample {
  uint32_t status;      // 24-bit status word
  int32_t channel[8];   // 8 channels, 24-bit each
};

// DRDY accounting: ISR increments drdyCount each time DRDY fires.
volatile uint32_t drdyCount = 0;
// Windowed counters for 5s logging.
uint32_t drdyEventsWindow = 0;
uint32_t samplesReadWindow = 0;
uint32_t lastStatsMs = 0;

bool initADS1298();
void sendCommand(uint8_t cmd);
uint8_t readRegister(uint8_t reg);
void writeRegister(uint8_t reg, uint8_t data);
ADS1298_Sample readData();
void drdyInterrupt();
void printStats();

// ============================================================================
// Setup: initialize ADS and attach DRDY interrupt
// ============================================================================
void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000);

  Serial.println("ADS1298 SPS verify");

  if (initADS1298()) {
    Serial.println("Init OK");
  } else {
    Serial.println("Init FAILED");
    while (1);
  }

  pinMode(PIN_DRDY, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_DRDY), drdyInterrupt, FALLING);
}

// ============================================================================
// Main loop: drain DRDY events and read samples
// ============================================================================
void loop() {
  // Snapshot and clear the DRDY counter with interrupts off.
  // This tells us how many sample-ready events happened since the last loop.
  uint32_t pending = 0;
  noInterrupts();
  pending = drdyCount;
  drdyCount = 0;
  interrupts();

  // Read one ADS sample per pending DRDY event.
  while (pending > 0) {
    ADS1298_Sample sample = readData();
    (void)sample;
    samplesReadWindow++;
    pending--;
  }

  uint32_t nowMs = millis();
  if (nowMs - lastStatsMs >= 5000) {
    printStats();
    lastStatsMs = nowMs;
  }
}

// ============================================================================
// 5-second stats
// ============================================================================
void printStats() {
  Serial.print("[SPS] drdy_events_5s=");
  Serial.print(drdyEventsWindow);
  Serial.print(" samples_read_5s=");
  Serial.println(samplesReadWindow);
  drdyEventsWindow = 0;
  samplesReadWindow = 0;
}

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

  // WCT config preserved from deepslp-led-ch4.ino
  writeRegister(ADS1298_REG_WCT1, 0x0A);
  writeRegister(ADS1298_REG_WCT2, 0xE3);

  delay(10);

  uint8_t config1 = readRegister(ADS1298_REG_CONFIG1);
  Serial.print("CONFIG1 readback: 0x");
  Serial.println(config1, HEX);

  uint8_t deviceID = readRegister(ADS1298_REG_ID);
  Serial.print("Device ID: 0x");
  Serial.println(deviceID, HEX);

  digitalWrite(PIN_START, HIGH);
  sendCommand(ADS1298_CMD_START);
  delay(10);

  sendCommand(ADS1298_CMD_RDATAC);
  delay(10);

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

// ============================================================================
// DRDY ISR: counts each sample-ready pulse
// ============================================================================
void drdyInterrupt() {
  drdyCount++;
  drdyEventsWindow++;
}
