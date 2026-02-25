import { router, useLocalSearchParams } from "expo-router";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  FlaskConical,
  RefreshCw,
  X,
  Zap,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, ScrollView, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Text } from "@/components/ui/text";
import { ENABLE_MOCK_MODE } from "@/config/mock-config";
import { getCalibrationSignalQuality } from "@/services/calibration-quality";
import { useBluetoothService } from "@/services/bluetooth-service";
import {
  getLatestCalibrationRunId,
  getPacketsForRun,
  saveCalibrationRun,
} from "@/services/ecg-storage";
import { useAppStore } from "@/stores/app-store";
import type { CalibrationStatus } from "@/types";
import { toByteArray } from "base64-js";

type CalibrationStep = "guidance" | "ready" | "calibrating" | "result";

export default function CalibrationScreen() {
  const params = useLocalSearchParams<{ fromOnboarding?: string }>();
  const isFromOnboarding = params.fromOnboarding === "true";
  const targetPacketCount = ENABLE_MOCK_MODE ? 100 : 400;
  const calibrationSeconds = ENABLE_MOCK_MODE ? 5 : 20;
  const expectedPacketBytes = 228;
  const SHOW_CALIBRATION_GRAPH = true;

  const [step, setStep] = useState<CalibrationStep>("guidance");
  const [calibrationStatus, setCalibrationStatus] =
    useState<CalibrationStatus>("not-started");
  const [progress, setProgress] = useState(0);
  const [resultMessage, setResultMessage] = useState("");
  const [signalQuality, setSignalQuality] = useState(0);
  const [recommendations, setRecommendations] = useState<string[]>([]);
  const [packetCount, setPacketCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastPacketBytes, setLastPacketBytes] = useState<Uint8Array | null>(
    null,
  );
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [graphPoints, setGraphPoints] = useState<number[]>([]);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [isGraphLoading, setIsGraphLoading] = useState(false);

  const { setCalibrationResult, completeOnboarding, isOnboardingComplete } =
    useAppStore();
  const { startEcgNotifications, stopEcgNotifications } = useBluetoothService();
  const packetCountRef = useRef(0);
  const invalidPacketCountRef = useRef(0);
  const packetsRef = useRef<Array<{ data: Uint8Array; receivedAt: number }>>(
    [],
  );
  const calibrationStartRef = useRef<number | null>(null);
  const isFinishingRef = useRef(false);

  // Pulse animation for the device indicator
  const pulseAnim = useSharedValue(1);

  useEffect(() => {
    if (step === "calibrating") {
      pulseAnim.value = withRepeat(
        withSequence(
          withTiming(1.2, { duration: 800, easing: Easing.ease }),
          withTiming(1, { duration: 800, easing: Easing.ease }),
        ),
        -1,
        false,
      );
    } else {
      pulseAnim.value = 1;
    }
  }, [step]);

  useEffect(() => {
    const loadGraph = async () => {
      if (!SHOW_CALIBRATION_GRAPH) return;
      if (step !== "result" || calibrationStatus !== "success") return;

      setIsGraphLoading(true);
      setGraphError(null);
      setGraphPoints([]);

      try {
        const runId = lastRunId ?? (await getLatestCalibrationRunId());
        if (!runId) {
          setGraphError("No calibration run found.");
          return;
        }

        const packets = await getPacketsForRun(runId);
        if (packets.length === 0) {
          setGraphError("No packets found for the latest run.");
          return;
        }

        const samples: number[] = [];
        for (const packet of packets) {
          for (let i = 0; i + 1 < packet.length; i += 2) {
            const raw = packet[i] | (packet[i + 1] << 8);
            const signed = raw & 0x8000 ? raw - 0x10000 : raw;
            samples.push(signed);
          }
        }

        const maxPoints = 800;
        const stepSize = Math.max(1, Math.ceil(samples.length / maxPoints));
        const sampled: number[] = [];
        for (let i = 0; i < samples.length; i += stepSize) {
          sampled.push(samples[i]);
        }

        const mean =
          sampled.reduce((sum, value) => sum + value, 0) / sampled.length;
        let maxAbs = 0;
        for (const v of sampled) {
          const delta = Math.abs(v - mean);
          if (delta > maxAbs) maxAbs = delta;
        }
        const scale = maxAbs || 1;
        const normalized = sampled.map((v) => (v - mean) / scale);

        setGraphPoints(normalized);
      } catch (error) {
        console.error("Failed to load calibration graph:", error);
        setGraphError("Failed to load calibration graph.");
      } finally {
        setIsGraphLoading(false);
      }
    };

    void loadGraph();
  }, [SHOW_CALIBRATION_GRAPH, calibrationStatus, lastRunId, step]);

  useEffect(() => {
    return () => {
      stopEcgNotifications();
    };
  }, [stopEcgNotifications]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseAnim.value }],
  }));

  const handleReady = () => {
    setStep("ready");
  };

  const handleStartCalibration = async () => {
    setStep("calibrating");
    setCalibrationStatus("in-progress");
    setProgress(0);
    setResultMessage("");
    setRecommendations([]);
    setSignalQuality(0);
    setPacketCount(0);
    setElapsedMs(0);
    setLastPacketBytes(null);
    packetCountRef.current = 0;
    invalidPacketCountRef.current = 0;
    packetsRef.current = [];
    calibrationStartRef.current = Date.now();
    isFinishingRef.current = false;
    invalidPacketCountRef.current = 0;
    console.log(
      `[CAL] start mock=${ENABLE_MOCK_MODE} env=${process.env.EXPO_PUBLIC_MOCK_MODE ?? "undefined"} target=${targetPacketCount} expectedBytes=${expectedPacketBytes}`,
    );

    const runTimestamp = Date.now();
    const runId = formatRunId(runTimestamp);
    const startedAt = calibrationStartRef.current ?? Date.now();

    const finishSuccess = async () => {
      if (isFinishingRef.current) return;
      isFinishingRef.current = true;
      stopEcgNotifications();

      const endedAt = Date.now();
      setElapsedMs(endedAt - startedAt);

      try {
        const bytes = concatUint8Arrays(
          packetsRef.current.map((packet) => packet.data),
        );
        const quality = await getCalibrationSignalQuality(bytes);

        await saveCalibrationRun(runId, startedAt, endedAt, packetsRef.current);

        const message = quality.signalSuitable
          ? `Signal quality ${quality.qualityPercentage}%. Calibration successful.`
          : `Signal quality ${quality.qualityPercentage}%. Calibration failed. Please adjust device placement.`;

        setSignalQuality(quality.qualityPercentage);
        setProgress(100);
        setResultMessage(message);
        setCalibrationStatus(quality.signalSuitable ? "success" : "failed");
        setLastRunId(runId);
        setCalibrationResult({
          status: quality.signalSuitable ? "success" : "failed",
          message,
          timestamp: new Date(),
          signalQuality: quality.qualityPercentage,
        });
      } catch (error) {
        console.error("Failed to save calibration packets:", error);
        setCalibrationStatus("failed");
        setSignalQuality(0);
        setResultMessage(
          "Calibration failed while checking signal quality. Please try again.",
        );
      } finally {
        setStep("result");
      }
    };

    const finishFailure = (message: string) => {
      if (isFinishingRef.current) return;
      isFinishingRef.current = true;
      stopEcgNotifications();
      setCalibrationStatus("failed");
      setResultMessage(message);
      setStep("result");
    };

    const started = await startEcgNotifications(
      (payloadBase64) => {
        if (isFinishingRef.current) return;

        const bytes = toByteArray(payloadBase64);
        const receivedAt = Date.now();

        if (bytes.length !== expectedPacketBytes) {
          invalidPacketCountRef.current += 1;
          const invalidCount = invalidPacketCountRef.current;
          if (invalidCount <= 5 || invalidCount % 50 === 0) {
            console.log(
              `[CAL] invalid packet len=${bytes.length} expected=${expectedPacketBytes} count=${invalidCount}`,
            );
          }
          return;
        }

        packetsRef.current.push({ data: bytes, receivedAt });
        packetCountRef.current += 1;
        const count = packetCountRef.current;
        setPacketCount(count);
        setLastPacketBytes(bytes);
        if (count === 1) {
          console.log(
            `[CAL] first packet len=${bytes.length} bytes=${Array.from(bytes).join(",")}`,
          );
        } else if (count % 20 === 0) {
          console.log(`[CAL] packet=${count} len=${bytes.length}`);
        }
        if (calibrationStartRef.current) {
          setElapsedMs(receivedAt - calibrationStartRef.current);
        }
        const pct = Math.min(
          100,
          Math.round((count / targetPacketCount) * 100),
        );
        setProgress(pct);

        if (count >= targetPacketCount) {
          void finishSuccess();
        }
      },
      ENABLE_MOCK_MODE ? { mockPacketsPerTick: 4 } : undefined,
    );

    if (!started) {
      finishFailure(
        "Failed to start ECG stream. Make sure the device is connected.",
      );
      return;
    }
  };

  const handleRetry = () => {
    stopEcgNotifications();
    setStep("guidance");
    setCalibrationStatus("not-started");
    setProgress(0);
    setResultMessage("");
    setRecommendations([]);
    setSignalQuality(0);
    setPacketCount(0);
    setElapsedMs(0);
    setLastPacketBytes(null);
    setLastRunId(null);
    setGraphPoints([]);
    setGraphError(null);
    packetCountRef.current = 0;
    packetsRef.current = [];
    calibrationStartRef.current = null;
    isFinishingRef.current = false;
  };

  const navigateBackOrTabs = () => {
    if (typeof router.canGoBack === "function" && router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/(tabs)");
  };

  const handleContinue = () => {
    if (isFromOnboarding) {
      if (!isOnboardingComplete) {
        completeOnboarding();
      }
      router.replace("/(tabs)");
    } else {
      navigateBackOrTabs();
    }
  };

  const handleBack = () => {
    if (step === "guidance" || step === "result") {
      navigateBackOrTabs();
    } else {
      stopEcgNotifications();
      setStep("guidance");
    }
  };

  const handleSkip = () => {
    if (isFromOnboarding) {
      if (!isOnboardingComplete) {
        completeOnboarding();
      }
      router.replace("/(tabs)");
    } else {
      navigateBackOrTabs();
    }
  };

  const formatPacketBytes = (bytes: Uint8Array) =>
    `Uint8Array(${bytes.length}) [${Array.from(bytes).join(", ")}]`;

  const formatSeconds = (ms: number) => (ms / 1000).toFixed(1);

  const formatRunId = (timestamp: number) => {
    const date = new Date(timestamp);
    const day = String(date.getDate()).padStart(2, "0");
    const month = date.toLocaleString("en-US", { month: "short" });
    const year = String(date.getFullYear()).slice(-2);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `calibration_${day}${month}${year}_${hours}${minutes}H`;
  };

  const concatUint8Arrays = (chunks: Uint8Array[]) => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  };

  const buildWavePath = (points: number[], height: number, stepX: number) => {
    if (points.length === 0) return "";
    const mid = height / 2;
    let d = "";
    for (let i = 0; i < points.length; i += 1) {
      const x = i * stepX;
      const y = mid - points[i] * mid;
      d += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
    }
    return d;
  };

  const renderGuidance = () => (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="items-center mb-2">
        <Text variant="h3" className="text-center mb-1">
          Device Placement Guide
        </Text>
        <Text className="text-muted-foreground text-center">
          Follow these steps to ensure accurate readings
        </Text>
      </View>

      {/* Device placement image */}
      <View className="bg-muted rounded-2xl h-64 items-center justify-center mb-4 overflow-hidden">
        <Image
          source={require("../assets/images/calibration_example.png")}
          className="w-full h-full"
          resizeMode="cover"
        />
      </View>

      {/* Instructions */}
      <View className="gap-2 mb-3">
        <Card>
          <CardContent>
            <View className="flex-row gap-3">
              <View className="w-8 h-8 rounded-full bg-primary items-center justify-center">
                <Text className="text-primary-foreground font-bold">1</Text>
              </View>
              <View className="flex-1">
                <Text className="font-semibold">Clean the area</Text>
                <Text className="text-muted-foreground text-sm mt-0">
                  Wipe the sensor area on your skin with a damp cloth to ensure
                  good electrode contact.
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <View className="flex-row gap-3">
              <View className="w-8 h-8 rounded-full bg-primary items-center justify-center">
                <Text className="text-primary-foreground font-bold">2</Text>
              </View>
              <View className="flex-1">
                <Text className="font-semibold">Position the device</Text>
                <Text className="text-muted-foreground text-sm mt-0">
                  Place the ECG device on your chest, slightly to the left of
                  center, below your collarbone.
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <View className="flex-row gap-3">
              <View className="w-8 h-8 rounded-full bg-primary items-center justify-center">
                <Text className="text-primary-foreground font-bold">3</Text>
              </View>
              <View className="flex-1">
                <Text className="font-semibold">Secure the device</Text>
                <Text className="text-muted-foreground text-sm mt-0">
                  Make sure the device sits flat against your skin and the strap
                  is snug but comfortable.
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <View className="flex-row gap-3">
              <View className="w-8 h-8 rounded-full bg-primary items-center justify-center">
                <Text className="text-primary-foreground font-bold">4</Text>
              </View>
              <View className="flex-1">
                <Text className="font-semibold">Stay still</Text>
                <Text className="text-muted-foreground text-sm mt-0">
                  During calibration, remain still and relaxed. Avoid talking or
                  moving for about 30 seconds.
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>
      </View>

      {/* Ready Button */}
      <View className="pb-1">
        <Button size="lg" onPress={handleReady} className="w-full mb-2">
          <Text className="text-primary-foreground font-semibold text-lg">
            I'm Ready
          </Text>
        </Button>
        <Button variant="ghost" onPress={handleSkip}>
          <Text className="text-muted-foreground">Skip for now</Text>
        </Button>
      </View>
    </ScrollView>
  );

  const renderReady = () => (
    <View className="flex-1 items-center justify-center px-6">
      <Animated.View
        style={pulseStyle}
        className="w-32 h-32 rounded-full bg-primary/20 items-center justify-center mb-5"
      >
        <View className="w-24 h-24 rounded-full bg-primary/40 items-center justify-center">
          <View className="w-16 h-16 rounded-full bg-primary items-center justify-center">
            <Zap size={32} className="text-primary-foreground" />
          </View>
        </View>
      </Animated.View>

      <Text variant="h3" className="text-center mb-0">
        Ready to Calibrate
      </Text>
      <Text className="text-muted-foreground text-center mb-3">
        Make sure your device is positioned correctly and you're comfortable.
        The calibration will take about {calibrationSeconds} seconds.
      </Text>

      <View className="w-full gap-2">
        <Button size="lg" onPress={handleStartCalibration} className="w-full">
          <Text className="text-primary-foreground font-semibold text-lg">
            Start Calibration
          </Text>
        </Button>
        <Button variant="outline" onPress={() => setStep("guidance")}>
          <Text>Review Instructions</Text>
        </Button>
      </View>
    </View>
  );

  const renderCalibrating = () => (
    <View className="flex-1 items-center justify-center px-6">
      <Animated.View
        style={pulseStyle}
        className="w-32 h-32 rounded-full bg-primary/20 items-center justify-center mb-5"
      >
        <ActivityIndicator size="large" color="#0a7ea4" />
      </Animated.View>

      <Text variant="h3" className="text-center mb-0">
        Calibrating...
      </Text>
      <Text className="text-muted-foreground text-center mb-3">
        Please remain still while we calibrate your device. This will take about
        {calibrationSeconds} seconds.
      </Text>

      <View className="w-full mb-2">
        <Progress value={progress} className="h-3" />
      </View>
      <Text className="text-muted-foreground">{Math.round(progress)}%</Text>
      <View className="mt-2 items-center">
        <Text className="text-muted-foreground text-sm">
          Packets received: {packetCount} / {targetPacketCount}
        </Text>
        <Text className="text-muted-foreground text-sm mt-0">
          Time: {formatSeconds(elapsedMs)}s
        </Text>
        {lastPacketBytes && (
          <Text className="text-muted-foreground text-xs mt-0">
            Last packet bytes: {formatPacketBytes(lastPacketBytes)}
          </Text>
        )}
      </View>
    </View>
  );

  const renderResult = () => (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="items-center pt-4 pb-3">
        <View
          className={`w-24 h-24 rounded-full items-center justify-center mb-4 ${
            calibrationStatus === "success"
              ? "bg-green-500/20"
              : "bg-red-500/20"
          }`}
        >
          {calibrationStatus === "success" ? (
            <Check size={48} className="text-green-500" />
          ) : (
            <X size={48} className="text-red-500" />
          )}
        </View>

        <Text variant="h3" className="text-center mb-0">
          {calibrationStatus === "success"
            ? "Calibration Successful!"
            : "Calibration Failed"}
        </Text>
        <Text className="text-muted-foreground text-center px-4">
          {resultMessage}
        </Text>
      </View>

      {/* Signal Quality */}
      <Card className="mb-2">
        <CardHeader>
          <CardTitle>Signal Quality</CardTitle>
        </CardHeader>
        <CardContent>
          <View className="flex-row items-center gap-4">
            <View className="flex-1">
              <Progress value={signalQuality} className="h-3" />
            </View>
            <Text
              className={`font-bold ${
                signalQuality >= 70
                  ? "text-green-500"
                  : signalQuality >= 40
                    ? "text-yellow-500"
                    : "text-red-500"
              }`}
            >
              {signalQuality}%
            </Text>
          </View>
          <Text className="text-muted-foreground text-sm mt-0">
            {signalQuality >= 70
              ? "Excellent signal quality"
              : signalQuality >= 40
                ? "Acceptable signal quality"
                : "Poor signal quality - please adjust device"}
          </Text>
        </CardContent>
      </Card>

      {calibrationStatus === "success" && SHOW_CALIBRATION_GRAPH && (
        <Card className="mb-2">
          <CardHeader>
            <CardTitle>Calibration Preview</CardTitle>
          </CardHeader>
          <CardContent>
            {isGraphLoading && (
              <Text className="text-muted-foreground text-sm">
                Loading graph...
              </Text>
            )}
            {graphError && (
              <Text className="text-destructive text-sm">{graphError}</Text>
            )}
            {!isGraphLoading && !graphError && graphPoints.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                className="mt-1"
              >
                <View style={{ height: 140 }}>
                  <Svg
                    width={Math.max(graphPoints.length * 3, 320)}
                    height={120}
                  >
                    <Path
                      d={buildWavePath(graphPoints, 120, 3)}
                      stroke="#22c55e"
                      strokeWidth={2}
                      fill="none"
                    />
                  </Svg>
                </View>
              </ScrollView>
            )}
          </CardContent>
        </Card>
      )}

      {/* Recommendations (if failed) */}
      {calibrationStatus === "failed" && recommendations.length > 0 && (
        <Card className="mb-3">
          <CardHeader>
            <CardTitle className="flex-row items-center gap-2">
              <AlertCircle size={18} className="text-yellow-500" />
              <Text className="font-semibold">Recommendations</Text>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <View className="gap-2">
              {recommendations.map((rec, index) => (
                <View key={index} className="flex-row items-start gap-2">
                  <Text className="text-muted-foreground">•</Text>
                  <Text className="text-muted-foreground flex-1">{rec}</Text>
                </View>
              ))}
            </View>
          </CardContent>
        </Card>
      )}

      {/* Action Buttons */}
      <View className="gap-2 pb-4">
        {calibrationStatus === "success" ? (
          <Button size="lg" onPress={handleContinue} className="w-full">
            <Text className="text-primary-foreground font-semibold text-lg">
              Continue
            </Text>
          </Button>
        ) : (
          <>
            <Button size="lg" onPress={handleRetry} className="w-full">
              <RefreshCw size={18} className="text-primary-foreground mr-2" />
              <Text className="text-primary-foreground font-semibold text-lg">
                Try Again
              </Text>
            </Button>
            <Button variant="outline" onPress={handleContinue}>
              <Text>Skip for now</Text>
            </Button>
          </>
        )}
      </View>
    </ScrollView>
  );

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 px-6 pt-4">
        {/* Header */}
        <View className="flex-row items-center justify-between mb-4">
          <Button variant="ghost" size="icon" onPress={handleBack}>
            <ArrowLeft size={24} className="text-foreground" />
          </Button>
          <Text className="font-semibold">Device Calibration</Text>
          <View className="w-10" />
        </View>

        {/* Mock Mode Indicator */}
        {ENABLE_MOCK_MODE && step === "guidance" && (
          <View className="bg-purple-500/20 border border-purple-500/50 rounded-lg p-3 mb-3">
            <View className="flex-row items-center gap-2">
              <FlaskConical size={18} className="text-purple-500" />
              <View className="flex-1">
                <Text className="text-purple-500 font-semibold text-sm">
                  Mock Mode Active
                </Text>
                <Text className="text-purple-400 text-xs">
                  Calibration will use simulated signal data
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Content based on step */}
        {step === "guidance" && renderGuidance()}
        {step === "ready" && renderReady()}
        {step === "calibrating" && renderCalibrating()}
        {step === "result" && renderResult()}
      </View>
    </SafeAreaView>
  );
}
