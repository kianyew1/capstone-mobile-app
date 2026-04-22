## Packet management

To handle the ECG data, each sample is stored within a custom structure that only contains the channels of interest, namely CH2, CH3, and CH4, together with the 24-bit status word. When the ADS1298 asserts the DRDY control signal, an interrupt is triggered and the nRF52840 records that a new sample is ready. In the main loop, each pending DRDY event is serviced by reading one sample from the ADC and placing it into a ring buffer. This buffering stage decouples data acquisition from BLE transmission, allowing samples to continue being captured even if the wireless link is temporarily delayed.

Once 25 samples have been accumulated, they are retrieved from the ring buffer as one batch, and the tail of the buffer advances by 25 positions. These 25 samples are then packed into a BLE payload together with additional metadata. The packet begins with a single 24-bit status word taken from the most recent sample in the batch, followed by 25 CH2 samples, 25 CH3 samples, and 25 CH4 samples. After the channel data, a final 24-bit field is appended to store the elapsed time in milliseconds since the previous packet was created. This results in a total packet size of 231 bytes. By grouping samples into one notification, the firmware reduces BLE overhead while still preserving the sequence of the ECG data and providing timing information for downstream reconstruction. To maintain a stable stream, packets are transmitted at intervals matched to the sampling rate, so that each packet represents 50 ms of ECG data at 500 Hz. If streaming stops or the BLE connection is lost, the ring buffer is cleared so that outdated samples are not transmitted later.

```mermaid
flowchart TD
    A[ADS1298 asserts DRDY] --> B[Interrupt increments DRDY counter]
    B --> C[Main loop checks pending DRDY events]
    C --> D[Read one sample<br/>status + CH2 + CH3 + CH4]
    D --> E{BLE connected and notify enabled?}

    E -- No --> F[Do not queue for streaming]
    E -- Yes --> G[Store sample in ring buffer]

    G --> H{At least 25 samples buffered<br/>and packet interval reached?}
    H -- No --> C
    H -- Yes --> I[Build 231-byte BLE packet]

    I --> J[Add latest 24-bit status word]
    J --> K[Append 25 CH2 samples]
    K --> L[Append 25 CH3 samples]
    L --> M[Append 25 CH4 samples]
    M --> N[Append 24-bit elapsed-time field]

    N --> O[Send BLE notification]
    O --> P{Notification successful?}
    P -- Yes --> Q[Advance ring tail by 25<br/>reduce ring count]
    P -- No --> R[Keep buffered data for next attempt]

    Q --> C
    R --> C

    S[Streaming disabled or BLE disconnected] --> T[Clear ring buffer]
```
