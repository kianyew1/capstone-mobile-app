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
import { ActivityIndicator, ScrollView, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Text } from "@/components/ui/text";
import { ENABLE_MOCK_MODE } from "@/config/mock-config";
import { useBluetoothService } from "@/services/bluetooth-service";
import { saveCalibrationRun } from "@/services/ecg-storage";
import { useAppStore } from "@/stores/app-store";
import type { CalibrationStatus } from "@/types";
import { toByteArray } from "base64-js";

type CalibrationStep = "guidance" | "ready" | "calibrating" | "result";

export default function CalibrationScreen() {
  const params = useLocalSearchParams<{ fromOnboarding?: string }>();
  const isFromOnboarding = params.fromOnboarding === "true";
  const targetPacketCount = 1000;

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

  const { setCalibrationResult } = useAppStore();
  const { startEcgNotifications, stopEcgNotifications } = useBluetoothService();
  const packetCountRef = useRef(0);
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
    packetsRef.current = [];
    calibrationStartRef.current = Date.now();
    isFinishingRef.current = false;

    const runId = `calibration_${Date.now()}`;
    const startedAt = calibrationStartRef.current ?? Date.now();

    const finishSuccess = async () => {
      if (isFinishingRef.current) return;
      isFinishingRef.current = true;
      stopEcgNotifications();

      const endedAt = Date.now();
      setElapsedMs(endedAt - startedAt);

      try {
        await saveCalibrationRun(
          runId,
          startedAt,
          endedAt,
          packetsRef.current,
        );

      const message = `Saved ${packetsRef.current.length} packets to local storage (run id: ${runId}).`;
      setSignalQuality(100);
      setProgress(100);
        setResultMessage(message);
        setCalibrationStatus("success");
        setCalibrationResult({
          status: "success",
          message,
          timestamp: new Date(),
          signalQuality: 100,
        });
      } catch (error) {
        console.error("Failed to save calibration packets:", error);
        setCalibrationStatus("failed");
        setResultMessage("Failed to save calibration packets.");
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

    const started = await startEcgNotifications((payloadBase64) => {
      if (isFinishingRef.current) return;

      const bytes = toByteArray(payloadBase64);
      const receivedAt = Date.now();

      packetsRef.current.push({ data: bytes, receivedAt });
      packetCountRef.current += 1;
      const count = packetCountRef.current;
      setPacketCount(count);
      setLastPacketBytes(bytes);
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
    });

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
    setLastPacketBytes(null);
    packetCountRef.current = 0;
    packetsRef.current = [];
    calibrationStartRef.current = null;
    isFinishingRef.current = false;
  };

  const handleContinue = () => {
    if (isFromOnboarding) {
      router.replace("/(tabs)");
    } else {
      router.back();
    }
  };

  const handleBack = () => {
    if (step === "guidance" || step === "result") {
      router.back();
    } else {
      stopEcgNotifications();
      setStep("guidance");
    }
  };

  const handleSkip = () => {
    if (isFromOnboarding) {
      router.replace("/(tabs)");
    } else {
      router.back();
    }
  };

  const formatPacketBytes = (bytes: Uint8Array) =>
    `Uint8Array(${bytes.length}) [${Array.from(bytes).join(", ")}]`;

  const formatSeconds = (ms: number) => (ms / 1000).toFixed(1);

  const renderGuidance = () => (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="items-center mb-6">
        <Text variant="h3" className="text-center mb-2">
          Device Placement Guide
        </Text>
        <Text className="text-muted-foreground text-center">
          Follow these steps to ensure accurate readings
        </Text>
      </View>

      {/* Placeholder for device placement image */}
      <View className="bg-muted rounded-2xl h-64 items-center justify-center mb-6 overflow-hidden">
        {/* Replace with actual asset image */}
        <View className="items-center">
          <View className="w-32 h-32 rounded-full bg-primary/20 items-center justify-center mb-4">
            <Zap size={64} className="text-primary" strokeWidth={1} />
          </View>
          <Text className="text-muted-foreground text-sm">
            Device Placement Illustration
          </Text>
          <Text className="text-muted-foreground text-xs mt-1">
            (Your asset image here)
          </Text>
        </View>
      </View>

      {/* Instructions */}
      <View className="gap-4 mb-6">
        <Card>
          <CardContent className="p-4">
            <View className="flex-row gap-3">
              <View className="w-8 h-8 rounded-full bg-primary items-center justify-center">
                <Text className="text-primary-foreground font-bold">1</Text>
              </View>
              <View className="flex-1">
                <Text className="font-semibold">Clean the area</Text>
                <Text className="text-muted-foreground text-sm mt-1">
                  Wipe the sensor area on your skin with a damp cloth to ensure
                  good electrode contact.
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <View className="flex-row gap-3">
              <View className="w-8 h-8 rounded-full bg-primary items-center justify-center">
                <Text className="text-primary-foreground font-bold">2</Text>
              </View>
              <View className="flex-1">
                <Text className="font-semibold">Position the device</Text>
                <Text className="text-muted-foreground text-sm mt-1">
                  Place the ECG device on your chest, slightly to the left of
                  center, below your collarbone.
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <View className="flex-row gap-3">
              <View className="w-8 h-8 rounded-full bg-primary items-center justify-center">
                <Text className="text-primary-foreground font-bold">3</Text>
              </View>
              <View className="flex-1">
                <Text className="font-semibold">Secure the device</Text>
                <Text className="text-muted-foreground text-sm mt-1">
                  Make sure the device sits flat against your skin and the strap
                  is snug but comfortable.
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <View className="flex-row gap-3">
              <View className="w-8 h-8 rounded-full bg-primary items-center justify-center">
                <Text className="text-primary-foreground font-bold">4</Text>
              </View>
              <View className="flex-1">
                <Text className="font-semibold">Stay still</Text>
                <Text className="text-muted-foreground text-sm mt-1">
                  During calibration, remain still and relaxed. Avoid talking or
                  moving for about 30 seconds.
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>
      </View>

      {/* Ready Button */}
      <View className="pb-4">
        <Button size="lg" onPress={handleReady} className="w-full mb-3">
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
        className="w-32 h-32 rounded-full bg-primary/20 items-center justify-center mb-8"
      >
        <View className="w-24 h-24 rounded-full bg-primary/40 items-center justify-center">
          <View className="w-16 h-16 rounded-full bg-primary items-center justify-center">
            <Zap size={32} className="text-primary-foreground" />
          </View>
        </View>
      </Animated.View>

      <Text variant="h3" className="text-center mb-2">
        Ready to Calibrate
      </Text>
      <Text className="text-muted-foreground text-center mb-8">
        Make sure your device is positioned correctly and you're comfortable.
        The calibration will take about 30 seconds.
      </Text>

      <View className="w-full gap-3">
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
        className="w-32 h-32 rounded-full bg-primary/20 items-center justify-center mb-8"
      >
        <ActivityIndicator size="large" color="#0a7ea4" />
      </Animated.View>

      <Text variant="h3" className="text-center mb-2">
        Calibrating...
      </Text>
      <Text className="text-muted-foreground text-center mb-8">
        Please remain still while we calibrate your device. This will take about
        30 seconds.
      </Text>

      <View className="w-full mb-4">
        <Progress value={progress} className="h-3" />
      </View>
      <Text className="text-muted-foreground">{Math.round(progress)}%</Text>
      <View className="mt-4 items-center">
        <Text className="text-muted-foreground text-sm">
          Packets received: {packetCount} / {targetPacketCount}
        </Text>
        <Text className="text-muted-foreground text-sm mt-1">
          Time: {formatSeconds(elapsedMs)}s
        </Text>
        {lastPacketBytes && (
          <Text className="text-muted-foreground text-xs mt-1">
            Last packet bytes: {formatPacketBytes(lastPacketBytes)}
          </Text>
        )}
      </View>
    </View>
  );

  const renderResult = () => (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="items-center pt-8 pb-6">
        <View
          className={`w-24 h-24 rounded-full items-center justify-center mb-6 ${
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

        <Text variant="h3" className="text-center mb-2">
          {calibrationStatus === "success"
            ? "Calibration Successful!"
            : "Calibration Failed"}
        </Text>
        <Text className="text-muted-foreground text-center px-4">
          {resultMessage}
        </Text>
      </View>

      {/* Signal Quality */}
      <Card className="mb-4">
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
          <Text className="text-muted-foreground text-sm mt-2">
            {signalQuality >= 70
              ? "Excellent signal quality"
              : signalQuality >= 40
                ? "Acceptable signal quality"
                : "Poor signal quality - please adjust device"}
          </Text>
        </CardContent>
      </Card>

      {/* Recommendations (if failed) */}
      {calibrationStatus === "failed" && recommendations.length > 0 && (
        <Card className="mb-4">
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
      <View className="gap-3 pb-8">
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
        <View className="flex-row items-center justify-between mb-6">
          <Button variant="ghost" size="icon" onPress={handleBack}>
            <ArrowLeft size={24} className="text-foreground" />
          </Button>
          <Text className="font-semibold">Device Calibration</Text>
          <View className="w-10" />
        </View>

        {/* Mock Mode Indicator */}
        {ENABLE_MOCK_MODE && step === "guidance" && (
          <View className="bg-purple-500/20 border border-purple-500/50 rounded-lg p-3 mb-4">
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
