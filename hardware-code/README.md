# Hardware Firmware

This folder contains the Arduino firmware used by the ECG hardware.

## Current contents

- `batteryIndicatorFix.ino` - XIAO nRF52840 + ADS1298 firmware with BLE streaming, battery handling, button/deep-sleep logic, and LED behavior

## Hardware assumptions in the code

- MCU: Seeed XIAO nRF52840
- AFE: ADS1298
- BLE stack: Adafruit Bluefruit
- LED strip: Adafruit NeoPixel

The firmware samples CH2, CH3, and CH4 from the ADS1298 and streams them over BLE notifications.

## BLE contract used by the software stack

These values must stay aligned with both the mobile app and the showcase / web tooling.

### UUIDs

- service UUID: `12345678-1234-1234-1234-1234567890ab`
- characteristic UUID: `87654321-4321-4321-4321-abcdefabcdef`

### Packet format

Each BLE notification packet is 231 bytes:

1. 3-byte status word
2. 25 CH2 samples
3. 25 CH3 samples
4. 25 CH4 samples
5. 3-byte elapsed-time field in milliseconds

Each sample is a signed 24-bit big-endian ADS1298 count.

Derived constants used across the stack:

- sample rate: `500 Hz`
- samples per packet: `25`
- packet interval: ~`50 ms`
- channels streamed: `CH2`, `CH3`, `CH4`

## Firmware behavior

### Acquisition

- ADS1298 runs at 500 SPS in high-resolution mode.
- DRDY interrupts enqueue samples into a ring buffer.
- BLE notifications are emitted in 25-sample packets when a client is connected and notifications are enabled.

### Connection behavior

- device name: `XIAO-ECG`
- advertising restarts automatically on disconnect
- ring buffer is reset on disconnect / when streaming stops

### Power and UI behavior

- button press at boot decides whether the device stays awake
- long press triggers deep sleep
- battery level is checked before startup
- builtin LED and NeoPixel strip are used for status indication

## Libraries needed in Arduino IDE

At minimum, the sketch depends on:

- `Adafruit Bluefruit nRF52`
- `Adafruit NeoPixel`
- `SPI`

## Files in the rest of the repo that depend on this packet format

- `capstone-ecgapp/services/bluetooth-service.ts`
- `backend/app.py`
- any standalone BLE display tooling derived from this firmware

If the firmware packet layout changes, those consumers must be updated together.
