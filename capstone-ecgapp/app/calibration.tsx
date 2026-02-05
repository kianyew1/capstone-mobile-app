import { useState, useEffect } from "react";
import { View, Image, ActivityIndicator, ScrollView } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ArrowLeft,
  Check,
  X,
  AlertCircle,
  RefreshCw,
  Zap,
} from "lucide-react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from "react-native-reanimated";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { Progress } from "@/components/ui/progress";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAppStore } from "@/stores/app-store";
import { submitCalibrationData } from "@/services/api-service";
import type { CalibrationStatus } from "@/types";

type CalibrationStep = "guidance" | "ready" | "calibrating" | "result";

export default function CalibrationScreen() {
  const params = useLocalSearchParams<{ fromOnboarding?: string }>();
  const isFromOnboarding = params.fromOnboarding === "true";

  const [step, setStep] = useState<CalibrationStep>("guidance");
  const [calibrationStatus, setCalibrationStatus] =
    useState<CalibrationStatus>("not-started");
  const [progress, setProgress] = useState(0);
  const [resultMessage, setResultMessage] = useState("");
  const [signalQuality, setSignalQuality] = useState(0);
  const [recommendations, setRecommendations] = useState<string[]>([]);

  const { pairedDevice, setCalibrationResult, isCalibrated } = useAppStore();

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

    // Simulate calibration progress
    const progressInterval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(progressInterval);
          return 100;
        }
        return prev + 2;
      });
    }, 60);

    try {
      // Mock signal data - in production this would come from the BLE device
      const mockSignalData = Array.from(
        { length: 100 },
        () => Math.random() * 100,
      );

      const response = await submitCalibrationData(
        pairedDevice?.id || "mock_device",
        mockSignalData,
      );

      clearInterval(progressInterval);
      setProgress(100);

      if (response.success && response.data) {
        const { isCalibrated, signalQuality, message, recommendations } =
          response.data;

        setSignalQuality(signalQuality);
        setResultMessage(message);
        setRecommendations(recommendations || []);

        if (isCalibrated) {
          setCalibrationStatus("success");
          setCalibrationResult({
            status: "success",
            message,
            timestamp: new Date(),
            signalQuality,
          });
        } else {
          setCalibrationStatus("failed");
          setCalibrationResult({
            status: "failed",
            message,
            timestamp: new Date(),
            signalQuality,
          });
        }
      } else {
        setCalibrationStatus("failed");
        setResultMessage("Calibration failed. Please try again.");
      }

      setStep("result");
    } catch (error) {
      clearInterval(progressInterval);
      setCalibrationStatus("failed");
      setResultMessage(
        "An error occurred during calibration. Please try again.",
      );
      setStep("result");
    }
  };

  const handleRetry = () => {
    setStep("guidance");
    setCalibrationStatus("not-started");
    setProgress(0);
    setResultMessage("");
    setRecommendations([]);
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

        {/* Content based on step */}
        {step === "guidance" && renderGuidance()}
        {step === "ready" && renderReady()}
        {step === "calibrating" && renderCalibrating()}
        {step === "result" && renderResult()}
      </View>
    </SafeAreaView>
  );
}
