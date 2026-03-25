/*
 * ADS1298 ECG with Seeed XIAO nRF52840
 * Complete initialization following Figure 93 (Section 10.1)
 * 
 * Hardware Connections:
 * - D0  → DRDY (Data Ready)
 * - D1  → PWDN & RESET (tied together)
 * - D2  → START
 * - D3  → CS (Chip Select)
 * - D8  → SCLK (SPI Clock)
 * - D9  → MISO (Master In, Slave Out)
 * - D10 → MOSI (Master Out, Slave In)
 * 
 * Additional Connections (REQUIRED):
 * - CLKSEL → VDD (3.3V) - Use internal oscillator
 * - VCAP1 → 1µF ceramic capacitor to GND
 * - VCAP2 → 1µF ceramic capacitor to GND
 * - VCAP3 → 1µF ceramic capacitor to GND
 * - VCAP4 → 1µF ceramic capacitor to GND
 * - VREFP → Leave floating (using internal reference)
 * - AVDD, DVDD → 3.3V
 * - AVSS, DGND → GND
 */

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
#define ADS1298_CMD_RREG     0x20  // Read register: 001r rrrr where rrrrr = register address
#define ADS1298_CMD_WREG     0x40  // Write register: 010r rrrr where rrrrr = register address

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
#define T_POR        1000    // Power-on reset time (tPOR >= 2^18 * tCLK = ~128ms, use 1000ms to be safe)
#define T_CLK        1       // Clock cycle (~0.5us at 2.048MHz)
#define T_RESET_PULSE 10     // Reset pulse width (minimum 2 * tCLK)

// Sample storage
struct ADS1298_Sample {
  uint32_t status;      // 24-bit status word
  int32_t channel[8];   // 8 channels, 24-bit each (sign-extended to 32-bit)
};

volatile bool newDataReady = false;

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000); // Wait for serial or timeout
  
  Serial.println("===========================================");
  Serial.println("ADS1298 Initialization - Following Figure 93");
  Serial.println("===========================================\n");
  
  // Initialize ADS1298
  if (initADS1298()) {
    Serial.println("\n✓ ADS1298 Initialized Successfully!");
    Serial.println("Ready to acquire data...\n");
  } else {
    Serial.println("\n✗ ADS1298 Initialization FAILED!");
    while(1); // Halt
  }
  
  // Attach interrupt for DRDY
  pinMode(PIN_DRDY, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_DRDY), drdyInterrupt, FALLING);
  
  Serial.println("Sample# Status   CH1      CH2      CH3      CH4      CH5      CH6      CH7      CH8");
  Serial.println("-----------------------------------------------------------------------------------------");
}

void loop() {
  static uint32_t sampleCount = 0;
  
  if (newDataReady) {
    newDataReady = false;
    
    ADS1298_Sample sample = readData();
    
    // Print sample
    Serial.print(sampleCount++);
    Serial.print("\t");
    Serial.print(sample.status, HEX);
    Serial.print("\t");
    
    for (int i = 0; i < 8; i++) {
      Serial.print(sample.channel[i]);
      Serial.print("\t");
    }
    Serial.println();
  }
}

// ============================================================================
// ADS1298 Functions
// ============================================================================

bool initADS1298() {
  // Step 1: Configure pins
  pinMode(PIN_CS, OUTPUT);
  pinMode(PIN_START, OUTPUT);
  pinMode(PIN_PWDN, OUTPUT);
  pinMode(PIN_DRDY, INPUT);
  
  digitalWrite(PIN_CS, HIGH);
  digitalWrite(PIN_START, LOW);
  digitalWrite(PIN_PWDN, LOW);
  
  // Step 2: Initialize SPI
  SPI.begin();
  SPI.beginTransaction(SPISettings(2000000, MSBFIRST, SPI_MODE1)); // 2 MHz, Mode 1
  
  Serial.println("Step 1: Power-Up Sequence");
  Serial.println("  - CLKSEL = 1 (internal oscillator)");
  Serial.println("  - Setting PWDN = 1, RESET = 1");
  
  // Step 3: Power-up sequence (Figure 93)
  // PWDN and RESET are tied together in your hardware
  digitalWrite(PIN_PWDN, HIGH);  // PWDN = 1, RESET = 1
  
  Serial.print("  - Waiting ");
  Serial.print(T_POR);
  Serial.println("ms for power-on reset (tPOR)...");
  delay(T_POR);
  
  // Note: In real hardware, you should check VCAP1 >= 1.1V here
  Serial.println("  ✓ Assuming VCAP1 >= 1.1V");
  
  // Step 4: Issue Reset Pulse
  Serial.println("\nStep 2: Issue Reset Pulse");
  digitalWrite(PIN_PWDN, LOW);
  delayMicroseconds(T_RESET_PULSE);
  digitalWrite(PIN_PWDN, HIGH);
  delayMicroseconds(18 * T_CLK); // Wait 18 clock cycles
  Serial.println("  ✓ Reset complete");
  
  // Step 5: Enable chip select
  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(10);
  
  // Step 6: Send SDATAC (Stop Read Data Continuously)
  Serial.println("\nStep 3: Send SDATAC Command");
  sendCommand(ADS1298_CMD_SDATAC);
  delay(10);
  Serial.println("  ✓ Device ready for register configuration");
  
  // Step 7: Configure internal reference (CONFIG3)
  Serial.println("\nStep 4: Configure Internal Reference");
  Serial.println("  - CONFIG3 = 0xC0 (Enable internal reference, no external reference)");
  writeRegister(ADS1298_REG_CONFIG3, 0xC0);
  delay(150); // Wait for internal reference to settle (~150ms)
  Serial.println("  ✓ Internal reference enabled and settled");
  
  // Step 8: Configure device settings
  Serial.println("\nStep 5: Configure Device Registers");
  
  // CONFIG1: HR mode, DR = fMOD/1024 (500 SPS for 2.048 MHz clock)
  Serial.println("  - CONFIG1 = 0x86 (HR mode, DR = fMOD/1024 = 500 SPS)");
  writeRegister(ADS1298_REG_CONFIG1, 0x86);
  
  // CONFIG2: Test signal settings (initially off)
  Serial.println("  - CONFIG2 = 0x00 (Test signals off)");
  writeRegister(ADS1298_REG_CONFIG2, 0x00);
  
  // Channel settings: Normal electrode input, Gain = 6, Powered up
  // CHnSET: 0x00 = Normal electrode input, Gain=6, powered up
  // For testing with input shorted: 0x01
  Serial.println("  - CH1-8SET = 0x00 (Normal input, Gain=6, Powered up)");
  for (int ch = 0; ch < 8; ch++) {
    writeRegister(ADS1298_REG_CH1SET + ch, 0x00); // Normal operation
    // Use 0x01 for input short (testing)
  }
  
  delay(10);
  
  // Configure Wilson Central Terminal (WCT) registers
  Serial.println("  • Configuring Wilson Central Terminal (WCT)...");
  Serial.println("    WCT1 (0x18): Power up WCTA, route CH2P");
  Serial.println("    WCT2 (0x19): Power up WCTB and WCTC, route CH2N and CH3P");
  
  // WCT1 (Address 0x18):
  // Bit 7-4: aVF_CH6, aVL_CH5, aVR_CH7, aVR_CH4 = 0000 (not used)
  // Bit 3: PD_WCTA = 0 (power up WCTA)
  // Bits 2-0: WCTA[2:0] = 011 (route CH2P to WCTA)
  // = 0b00000011 = 0x03
  writeRegister(ADS1298_REG_WCT1, 0x0A);
  
  // WCT2 (Address 0x19):
  // Bit 7: PD_WCTC = 0 (power up WCTC)
  // Bit 6: PD_WCTB = 0 (power up WCTB)
  // Bits 5-3: WCTC[2:0] = 101 (route CH3P to WCTC)
  // Bits 2-0: WCTB[2:0] = 010 (route CH2N to WCTB)
  // = 0b00101010 = 0x2A
  writeRegister(ADS1298_REG_WCT2, 0xE3);
  
  // Verify WCT registers
  uint8_t wct1_readback = readRegister(ADS1298_REG_WCT1);
  uint8_t wct2_readback = readRegister(ADS1298_REG_WCT2);
  Serial.print("    WCT1 readback: 0x");
  Serial.println(wct1_readback, HEX);
  Serial.print("    WCT2 readback: 0x");
  Serial.println(wct2_readback, HEX);
  
  delay(10);
  Serial.println("  ✓ All registers configured");
  
  // Step 9: Read back device ID
  Serial.println("\nStep 6: Verify Device ID");
  uint8_t deviceID = readRegister(ADS1298_REG_ID);
  Serial.print("  - Device ID: 0x");
  Serial.println(deviceID, HEX);
  
  if ((deviceID & 0xF8) == 0x98) {
    Serial.println("  ✓ ADS1298 detected");
  } else if ((deviceID & 0xF8) == 0x90) {
    Serial.println("  ✓ ADS1296 detected");
  } else if ((deviceID & 0xF8) == 0x88) {
    Serial.println("  ✓ ADS1294 detected");
  } else {
    Serial.println("  ✗ Unknown device!");
    return false;
  }
  
  // Step 10: Start conversion
  Serial.println("\nStep 7: Start Conversion");
  digitalWrite(PIN_START, HIGH); // START = 1
  sendCommand(ADS1298_CMD_START);
  delay(10);
  Serial.println("  ✓ Conversions started");
  
  // Step 11: Put device in RDATAC mode
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
  
  SPI.transfer(ADS1298_CMD_RREG | reg); // RREG command + register address
  SPI.transfer(0x00);                   // Number of registers to read - 1 (0 = 1 register)
  delayMicroseconds(2);
  uint8_t data = SPI.transfer(0x00);    // Read data
  
  delayMicroseconds(2);
  digitalWrite(PIN_CS, HIGH);
  return data;
}

void writeRegister(uint8_t reg, uint8_t data) {
  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(2);
  
  SPI.transfer(ADS1298_CMD_WREG | reg); // WREG command + register address
  SPI.transfer(0x00);                   // Number of registers to write - 1 (0 = 1 register)
  SPI.transfer(data);                   // Write data
  
  delayMicroseconds(2);
  digitalWrite(PIN_CS, HIGH);
  delayMicroseconds(2);
}

ADS1298_Sample readData() {
  ADS1298_Sample sample;
  
  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(2);
  
  // Read 24-bit status word (3 bytes)
  uint8_t stat1 = SPI.transfer(0x00);
  uint8_t stat2 = SPI.transfer(0x00);
  uint8_t stat3 = SPI.transfer(0x00);
  sample.status = ((uint32_t)stat1 << 16) | ((uint32_t)stat2 << 8) | stat3;
  
  // Read 8 channels (3 bytes each = 24 bits)
  for (int ch = 0; ch < 8; ch++) {
    uint8_t byte1 = SPI.transfer(0x00);  // MSB
    uint8_t byte2 = SPI.transfer(0x00);
    uint8_t byte3 = SPI.transfer(0x00);  // LSB
    
    // Combine into 24-bit value
    int32_t value = ((uint32_t)byte1 << 16) | ((uint32_t)byte2 << 8) | byte3;
    
    // Sign extend from 24-bit to 32-bit
    if (value & 0x800000) {
      value |= 0xFF000000; // Extend sign bit
    }
    
    sample.channel[ch] = value;
  }
  
  delayMicroseconds(2);
  digitalWrite(PIN_CS, HIGH);
  
  return sample;
}

void drdyInterrupt() {
  newDataReady = true;
}

// ============================================================================
// Optional: Test Signal Functions
// ============================================================================

void enableTestSignal() {
  // Send SDATAC to stop continuous mode
  sendCommand(ADS1298_CMD_SDATAC);
  delay(10);
  
  // Enable 1mV test signal (CONFIG2 = 0x10)
  writeRegister(ADS1298_REG_CONFIG2, 0x10);
  
  // Set all channels to test signal input (CHnSET = 0x05)
  for (int ch = 0; ch < 8; ch++) {
    writeRegister(ADS1298_REG_CH1SET + ch, 0x05);
  }
  
  // Resume continuous mode
  sendCommand(ADS1298_CMD_RDATAC);
  delay(10);
  
  Serial.println("Test signal enabled on all channels");
}

void disableTestSignal() {
  sendCommand(ADS1298_CMD_SDATAC);
  delay(10);
  
  // Disable test signal
  writeRegister(ADS1298_REG_CONFIG2, 0x00);
  
  // Set all channels back to normal input
  for (int ch = 0; ch < 8; ch++) {
    writeRegister(ADS1298_REG_CH1SET + ch, 0x00);
  }
  
  sendCommand(ADS1298_CMD_RDATAC);
  delay(10);
  
  Serial.println("Test signal disabled, normal input restored");
}
