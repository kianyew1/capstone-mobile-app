import React, { useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text } from "react-native";
import { BleStreamWidget } from "../ble-stream";
import { CalibrationButton } from "../calibration";

export function BleStreamDemoScreen() {
  const [connectedDevice, setConnectedDevice] = useState<any | null>(null);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>BLE Stream Demo</Text>
        <Text style={styles.subtitle}>
          Pair and connect to the ECG device, then run calibration.
        </Text>
        <BleStreamWidget
          options={{
            serviceUUID: "12345678-1234-1234-1234-1234567890ab",
            characteristicUUID: "87654321-4321-4321-4321-abcdefabcdef",
            scanTimeoutMs: 12000,
          }}
          onConnectionChange={setConnectedDevice}
        />     
        <CalibrationButton
          connectedDevice={connectedDevice}
          options={{
            serviceUUID: "12345678-1234-1234-1234-1234567890ab",
            characteristicUUID: "87654321-4321-4321-4321-abcdefabcdef",
            sampleRateHz: 500,
            durationSec: 20,
            apiUrl: "https://example.com/v1/calibration/assess",
          }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f7f5f0" },
  content: { padding: 20 },
  title: { fontSize: 20, fontWeight: "700", marginBottom: 6 },
  subtitle: { fontSize: 13, color: "#4d4d4d", marginBottom: 16 },
});
