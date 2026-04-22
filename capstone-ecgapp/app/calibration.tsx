import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Check, RefreshCw, X, Zap } from "lucide-react-native";
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
import Svg, { Line, Path, Text as SvgText } from "react-native-svg";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Text } from "@/components/ui/text";
import { ENABLE_MOCK_MODE } from "@/config/mock-config";
import { getCalibrationSignalQuality } from "@/services/calibration-quality";
import { useBluetoothService } from "@/services/bluetooth-service";
import {
  concatUint8Arrays,
  ECG_PACKET_BYTES,
  ECG_SAMPLES_PER_PACKET,
} from "@/services/ecg-utils";
import { useAppStore } from "@/stores/app-store";
import type { CalibrationStatus } from "@/types";
import { toByteArray } from "base64-js";

type CalibrationStep = "guidance" | "ready" | "calibrating" | "result";

export default function CalibrationScreen() {
  const params = useLocalSearchParams<{ fromOnboarding?: string }>();
  const isFromOnboarding = params.fromOnboarding === "true";
  const targetPacketCount = 400;
  const calibrationSeconds = 20;
  const expectedPacketBytes = ECG_PACKET_BYTES;

  const [step, setStep] = useState<CalibrationStep>("guidance");
  const [calibrationStatus, setCalibrationStatus] =
    useState<CalibrationStatus>("not-started");
  const [progress, setProgress] = useState(0);
  const [resultMessage, setResultMessage] = useState("");
  const [signalQuality, setSignalQuality] = useState(0);
  const [packetCount, setPacketCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastPacketBytes, setLastPacketBytes] = useState<Uint8Array | null>(
    null,
  );
  const [graphSeries, setGraphSeries] = useState<{
    ch2: number[];
    ch3: number[];
    ch4: number[];
  }>({ ch2: [], ch3: [], ch4: [] });
  const [graphError, setGraphError] = useState<string | null>(null);
  const [isGraphLoading, setIsGraphLoading] = useState(false);
  const [graphWidth, setGraphWidth] = useState(320);

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
    stopEcgNotifications();
    setStep("calibrating");
    setCalibrationStatus("in-progress");
    setProgress(0);
    setResultMessage("");
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
      `[CAL] start target=${targetPacketCount} expectedBytes=${expectedPacketBytes}`,
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
        setIsGraphLoading(true);
        setGraphError(null);
        const packetTotal = packetsRef.current.length;
        const samplesPerChannel = packetTotal * ECG_SAMPLES_PER_PACKET;
        console.log(
          `[CAL] packets=${packetTotal} samplesPerChannel=${samplesPerChannel}`,
        );
        const bytes = concatUint8Arrays(
          packetsRef.current.map((packet) => packet.data),
        );
        const quality = await getCalibrationSignalQuality(bytes, runId);
        const message = quality.signalSuitable
          ? `Signal quality ${quality.qualityPercentage}%. Calibration successful.`
          : `Signal quality ${quality.qualityPercentage}%. Calibration failed. Please adjust device placement.`;

        setSignalQuality(quality.qualityPercentage);
        setProgress(100);
        setResultMessage(message);
        setCalibrationStatus(quality.signalSuitable ? "success" : "failed");
        setGraphSeries({
          ch2: quality.preview.CH2,
          ch3: quality.preview.CH3,
          ch4: quality.preview.CH4,
        });
        setCalibrationResult({
          status: quality.signalSuitable ? "success" : "failed",
          message,
          timestamp: new Date(),
          signalQuality: quality.qualityPercentage,
          calibrationObjectKey: quality.calibrationObjectKey,
        });
      } catch (error) {
        console.error("Failed to save calibration packets:", error);
        setCalibrationStatus("failed");
        setSignalQuality(0);
        setResultMessage(
          "Calibration failed while checking signal quality. Please try again.",
        );
        setGraphError("Failed to build calibration preview.");
      } finally {
        setIsGraphLoading(false);
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
      ENABLE_MOCK_MODE
        ? {
            mockPacketIntervalMs: 50,
            mockPacketsPerTick: 1,
          }
        : undefined,
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
    setSignalQuality(0);
    setPacketCount(0);
    setElapsedMs(0);
    setLastPacketBytes(null);
    setGraphSeries({ ch2: [], ch3: [], ch4: [] });
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

  const buildSampleMarkers = (count: number, stepX: number, height: number) => {
    if (count <= 1) return null;
    const markerStep = count >= 2500 ? 500 : count >= 1000 ? 250 : 100;
    const markers = [];
    for (let i = 0; i < count; i += markerStep) {
      const x = i * stepX;
      markers.push(
        <Line
          key={`tick-${i}`}
          x1={x}
          y1={0}
          x2={x}
          y2={height}
          stroke="rgba(148, 163, 184, 0.35)"
          strokeWidth={1}
        />,
      );
      markers.push(
        <SvgText
          key={`label-${i}`}
          x={x + 2}
          y={height - 4}
          fontSize={10}
          fill="rgba(148, 163, 184, 0.8)"
        >
          {i}
        </SvgText>,
      );
    }
    const lastIndex = count - 1;
    if (lastIndex > 0 && lastIndex % markerStep !== 0) {
      const x = lastIndex * stepX;
      markers.push(
        <Line
          key={`tick-${lastIndex}`}
          x1={x}
          y1={0}
          x2={x}
          y2={height}
          stroke="rgba(148, 163, 184, 0.35)"
          strokeWidth={1}
        />,
      );
      markers.push(
        <SvgText
          key={`label-${lastIndex}`}
          x={x + 2}
          y={height - 4}
          fontSize={10}
          fill="rgba(148, 163, 184, 0.8)"
        >
          {count}
        </SvgText>,
      );
    }
    return markers;
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
          source={require("../assets/images/calibration_example.jpg")}
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
      <Text className="text-muted-foreground text-sm mt-2 text-center">
        Keep still while we collect a clean signal.
      </Text>
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

      {calibrationStatus === "success" && (
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
            {!isGraphLoading &&
              !graphError &&
              (graphSeries.ch2.length > 0 ||
                graphSeries.ch3.length > 0 ||
                graphSeries.ch4.length > 0) && (
                <View className="gap-3">
                  {[
                    { label: "CH2", data: graphSeries.ch2, color: "#22c55e" },
                    { label: "CH3", data: graphSeries.ch3, color: "#0ea5e9" },
                    { label: "CH4", data: graphSeries.ch4, color: "#f59e0b" },
                  ].map((series) => (
                    <View key={series.label}>
                      <Text className="text-xs text-muted-foreground">
                        {series.label}
                      </Text>
                      {series.data.length === 0 ? (
                        <Text className="text-xs text-muted-foreground">
                          No samples to preview.
                        </Text>
                      ) : (
                        <View
                          className="mt-1"
                          onLayout={(event) => {
                            const width = event.nativeEvent.layout.width;
                            if (width > 0 && width !== graphWidth) {
                              setGraphWidth(width);
                            }
                          }}
                        >
                          <View style={{ height: 140 }}>
                            <Svg width={graphWidth} height={120}>
                              {buildSampleMarkers(
                                series.data.length,
                                graphWidth /
                                  Math.max(series.data.length - 1, 1),
                                120,
                              )}
                              <Path
                                d={buildWavePath(
                                  series.data,
                                  120,
                                  graphWidth /
                                    Math.max(series.data.length - 1, 1),
                                )}
                                stroke={series.color}
                                strokeWidth={2}
                                fill="none"
                              />
                            </Svg>
                          </View>
                        </View>
                      )}
                    </View>
                  ))}
                </View>
              )}
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

        {/* Content based on step */}
        {step === "guidance" && renderGuidance()}
        {step === "ready" && renderReady()}
        {step === "calibrating" && renderCalibrating()}
        {step === "result" && renderResult()}
      </View>
    </SafeAreaView>
  );
}
