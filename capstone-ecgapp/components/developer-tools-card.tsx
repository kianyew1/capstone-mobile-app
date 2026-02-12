import { useMemo, useState } from "react";
import { View, Alert } from "react-native";

import { Text } from "@/components/ui/text";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { TestResult } from "@/tests/ecg-test-harness";
import { runPhase6SupabaseTests } from "@/tests/ecg-test-harness";
import { runRealDataPhaseTests } from "@/tests/ecg-realdata-tests";
import {
  runLiveBleSanityCheck,
  type LiveSanityProgress,
} from "@/tests/ecg-live-sanity";
import { useBleDevConnect } from "@/features-from-other-repo/ble-stream/useBleDevConnect";
import type { BleStreamOptions } from "@/features-from-other-repo/ble-stream/types";

export function DeveloperToolsCard() {
  const [sanityResults, setSanityResults] = useState<TestResult[]>([]);
  const [liveStatus, setLiveStatus] = useState<LiveSanityProgress | null>(null);
  const [liveRunning, setLiveRunning] = useState(false);
  const [resetRunning, setResetRunning] = useState(false);
  const [sanityRunning, setSanityRunning] = useState(false);

  const serviceUUID =
    process.env.EXPO_PUBLIC_ECG_SERVICE_UUID ??
    "12345678-1234-1234-1234-1234567890ab";
  const characteristicUUID =
    process.env.EXPO_PUBLIC_ECG_CHARACTERISTIC_UUID ??
    "87654321-4321-4321-4321-abcdefabcdef";

  const bleOptions: BleStreamOptions = useMemo(
    () => ({
      serviceUUID,
      characteristicUUID,
      scanTimeoutMs: 12000,
    }),
    [serviceUUID, characteristicUUID],
  );

  const {
    isPairing,
    isBluetoothOn,
    error: bleError,
    connectedDevice,
    connect,
    disconnect,
  } = useBleDevConnect({
    ...bleOptions,
    autoConnect: true,
  });

  const runSanityChecks = async () => {
    if (sanityRunning) return;
    setSanityRunning(true);
    setSanityResults([]);
    setLiveStatus({ status: "checking", message: "Running real-data tests..." });
    try {
      const real = await runRealDataPhaseTests(
        { deviceId: connectedDevice?.id },
        (message) => {
          setLiveStatus({ status: "checking", message });
        },
        (result) => {
          setSanityResults((prev) => [...prev, result]);
        },
      );
      const phase6 = await runPhase6SupabaseTests();
      setSanityResults((prev) => [...prev, ...phase6]);
      setLiveStatus({ status: "done", message: "Sanity checks completed." });
      const combined = [...real, ...phase6];
      const failed = combined.filter((r) => !r.ok);
      Alert.alert(
        "Sanity Checks",
        failed.length === 0
          ? "All checks passed."
          : `${failed.length} checks failed.`,
      );
    } catch {
      Alert.alert("Sanity Checks", "Failed to run checks.");
    } finally {
      setSanityRunning(false);
    }
  };

  const runLiveSanity = async () => {
    if (liveRunning) return;
    setLiveRunning(true);
    setLiveStatus({ status: "checking", message: "Starting live BLE check..." });
    try {
      const result = await runLiveBleSanityCheck(
        { deviceId: connectedDevice?.id },
        (progress) => {
          setLiveStatus(progress);
        },
      );
      if (!result.ok) {
        Alert.alert(
          "Live BLE Check",
          result.error ?? "Live BLE check failed.",
        );
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Live BLE check failed to run.";
      Alert.alert("Live BLE Check", message);
    } finally {
      setLiveRunning(false);
    }
  };

  const handlePairByUuid = async () => {
    if (!isBluetoothOn) {
      Alert.alert("Pair Device", "Bluetooth is off.");
      return;
    }
    if (isPairing || connectedDevice) return;
    await connect();
  };

  const handleResetBle = async () => {
    if (resetRunning) return;
    setResetRunning(true);
    try {
      await disconnect();
      setLiveStatus(null);
      Alert.alert("Reset BLE", "Disconnected from current BLE device.");
    } finally {
      setResetRunning(false);
    }
  };

  return (
    <View className="px-5 mb-6">
      <Text className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">
        Developer
      </Text>
      <Card>
        <CardContent className="p-4 gap-3">
          <Button onPress={runSanityChecks} disabled={sanityRunning}>
            <Text className="text-primary-foreground">Run Sanity Checks</Text>
          </Button>
          <Button
            variant="outline"
            onPress={handlePairByUuid}
            disabled={!isBluetoothOn || isPairing || !!connectedDevice}
          >
            <Text>
              {!isBluetoothOn
                ? "Bluetooth Off"
                : isPairing
                  ? "Pairing..."
                  : connectedDevice
                    ? `Connected: ${connectedDevice.name ?? "ECG Device"}`
                    : "Pair + Connect (UUID)"}
            </Text>
          </Button>
          <Button
            variant="outline"
            onPress={runLiveSanity}
            disabled={liveRunning}
          >
            <Text>Run Live BLE Check</Text>
          </Button>
          <Button
            variant="outline"
            onPress={handleResetBle}
            disabled={resetRunning}
          >
            <Text>Reset BLE</Text>
          </Button>
          {bleError ? (
            <Text className="text-destructive text-sm">{bleError}</Text>
          ) : null}
          {sanityResults.length > 0 && (
            <View className="gap-1">
              {sanityResults.map((result) => (
                <Text
                  key={result.name}
                  className={result.ok ? "text-green-600" : "text-red-600"}
                >
                  {result.ok ? "PASS" : "FAIL"} - {result.name}
                  {result.details ? ` (${result.details})` : ""}
                </Text>
              ))}
            </View>
          )}
          {liveStatus && (
            <View className="gap-1">
              <Text className="text-muted-foreground">
                Live BLE: {liveStatus.status}
              </Text>
              {liveStatus.message && (
                <Text className="text-muted-foreground">
                  {liveStatus.message}
                </Text>
              )}
              {typeof liveStatus.packets === "number" && (
                <Text className="text-muted-foreground">
                  Packets: {liveStatus.packets} | Decode errors:{" "}
                  {liveStatus.decodeErrors ?? 0}
                </Text>
              )}
              {liveStatus.deviceName && (
                <Text className="text-muted-foreground">
                  Device: {liveStatus.deviceName}
                </Text>
              )}
            </View>
          )}
        </CardContent>
      </Card>
    </View>
  );
}
