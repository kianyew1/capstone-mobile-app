import React, { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { BleStreamOptions } from "./types";
import { useBleStream } from "./useBleStream";

type Props = {
  options: BleStreamOptions;
  onConnectionChange?: (device: any | null) => void;
};

export function BleStreamWidget({ options, onConnectionChange }: Props) {
  const {
    isBluetoothOn,
    error,
    connectedDevice,
    isPairing,
    startPairing,
    disconnectAll,
  } = useBleStream(options);

  useEffect(() => {
    if (onConnectionChange) {
      onConnectionChange(connectedDevice || null);
    }
  }, [connectedDevice, onConnectionChange]);

  const handlePair = async () => {
    await startPairing();
  };

  const handleDisconnect = async () => {
    await disconnectAll();
  };

  return (
    <View style={styles.container}>
      {connectedDevice ? (
        <Text style={styles.subtext}>
          Connected to {connectedDevice?.name || connectedDevice?.id}
        </Text>
      ) : null}
      <Pressable
        style={[
          connectedDevice ? styles.dangerButton : styles.primaryButton,
          (isPairing || !isBluetoothOn) && !connectedDevice ? styles.disabled : null,
        ]}
        onPress={connectedDevice ? handleDisconnect : handlePair}
        disabled={(isPairing || !isBluetoothOn) && !connectedDevice}
      >
        <Text style={styles.primaryText}>
          {connectedDevice
            ? "Disconnect from ECG device"
            : isBluetoothOn
            ? "Pair with ECG device"
            : "Turn on Bluetooth"}
        </Text>
      </Pressable>
      <Text style={styles.caption}>
        Service UUID: {options.serviceUUID}
      </Text>
      <Text style={styles.caption}>
        Characteristic UUID: {options.characteristicUUID}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: "#fff", borderRadius: 12 },
  subtext: { fontSize: 12, color: "#6a6a6a", marginTop: 8 },
  caption: { fontSize: 11, color: "#6a6a6a", marginTop: 6 },
  primaryButton: {
    backgroundColor: "#0f5f6b",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 8,
  },
  dangerButton: {
    backgroundColor: "#b3261e",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 8,
  },
  disabled: {
    opacity: 0.6,
  },
  primaryText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  error: { marginTop: 8, color: "#9b2c2c", fontSize: 12 },
});
