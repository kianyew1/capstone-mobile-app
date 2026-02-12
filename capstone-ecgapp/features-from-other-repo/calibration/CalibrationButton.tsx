import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { CalibrationOptions } from "./types";
import { useCalibration } from "./useCalibration";

type Props = {
  connectedDevice: any | null;
  options: CalibrationOptions;
};

export function CalibrationButton({ connectedDevice, options }: Props) {
  const {
    status,
    buttonLabel,
    startCalibration,
    error,
    remainingSec,
    packetCount,
    exportPayload,
    chunkCount,
    chunkPreview,
  } = useCalibration({
    connectedDevice,
    options,
  });
  const disabled =
    !connectedDevice || status === "recording" || status === "uploading";

  return (
    <View style={styles.container}>
      <Pressable
        style={[styles.button, disabled ? styles.disabled : null]}
        onPress={startCalibration}
        disabled={disabled}
      >
        <Text style={styles.buttonText}>
          {connectedDevice ? buttonLabel : "Connect ECG device first"}
        </Text>
      </Pressable>
      <Text style={styles.caption}>
        Captures ~{options.durationSec || 20}s of ECG at{" "}
        {options.sampleRateHz || 500} Hz
      </Text>
      {status === "recording" && remainingSec !== null ? (
        <Text style={styles.caption}>
          Recording... {remainingSec}s remaining
        </Text>
      ) : null}
      {status === "recording" ? (
        <Text style={styles.caption}>Packets received: {packetCount}</Text>
      ) : null}
      {chunkCount > 0 ? (
        <Text style={styles.caption}>Chunks stored: {chunkCount}</Text>
      ) : null}
      {chunkPreview.length ? (
        <>
          <Text style={styles.caption}>Chunk preview:</Text>
          {chunkPreview.map((row) => (
            <Text key={row.chunk_index} style={styles.caption}>
              #{row.chunk_index} samples={row.sample_count} b64_len={row.b64_len} prefix={row.b64_prefix}
            </Text>
          ))}
        </>
      ) : null}
      {status === "uploading" ? (
        <Text style={styles.caption}>Checking signal quality...</Text>
      ) : null}
      {exportPayload ? (
        <>
          <Text style={styles.caption}>
            Export total samples: {exportPayload.total_samples}
          </Text>
          <Text style={styles.caption}>Export sha256: {exportPayload.sha256}</Text>
        </>
      ) : null}
      <Text style={styles.caption}>
        Sends full signal to quality API, stores clean 10s segment
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 12 },
  button: {
    backgroundColor: "#0f5f6b",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  disabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  caption: { marginTop: 6, fontSize: 11, color: "#6a6a6a" },
  error: { marginTop: 6, fontSize: 11, color: "#9b2c2c" },
});
