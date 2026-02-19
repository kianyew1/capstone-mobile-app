import { router } from "expo-router";
import {
  AlertCircle,
  ChevronUp,
  Clock,
  Flag,
  FlaskConical,
  Heart,
  Pause,
  Play,
  Smartphone,
  Square,
  Zap,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  AppState,
  Pressable,
  ScrollView,
  View,
  type AppStateStatus,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { toByteArray } from "base64-js";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { ENABLE_MOCK_MODE } from "@/config/mock-config";
import { generateMockHeartRate } from "@/services/api-service";
import { useBluetoothService } from "@/services/bluetooth-service";
import {
  createSessionRecordAtStart,
  finalizeSessionRecording,
  uploadCalibrationFile,
} from "@/services/supabase-ecg";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";

export default function RunSessionScreen() {
  const [showBackgroundTip, setShowBackgroundTip] = useState(true);
  const [isAppActive, setIsAppActive] = useState(true);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartRateRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const {
    currentSession,
    sessionStatus,
    currentHeartRate,
    elapsedTime,
    averageHeartRate,
    maxHeartRate,
    minHeartRate,
    eventMarkers,
    startSession,
    endSession,
    pauseSession,
    resumeSession,
    addHeartRateData,
    addEventMarker,
    updateElapsedTime,
  } = useSessionStore();

  const { connectionStatus, pairedDevice, startEcgNotifications, stopEcgNotifications } =
    useBluetoothService();
  const { user } = useAppStore();
  const isConnected = connectionStatus === "connected";
  const userId = user?.email ?? "unknown@local";

  const sessionPacketsRef = useRef<Uint8Array[]>([]);
  const sessionStartRef = useRef<Date | null>(null);
  const isStreamingRef = useRef(false);
  const hasPreparedUploadRef = useRef(false);
  const recordIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // Heart pulse animation
  const heartScale = useSharedValue(1);

  useEffect(() => {
    heartScale.value = withRepeat(
      withSequence(
        withTiming(1.15, { duration: 400, easing: Easing.ease }),
        withTiming(1, { duration: 400, easing: Easing.ease }),
      ),
      -1,
      false,
    );
  }, []);

  const heartPulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: heartScale.value }],
  }));

  // Handle app state changes (background/foreground)
  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      (nextAppState: AppStateStatus) => {
        setIsAppActive(nextAppState === "active");
      },
    );

    return () => {
      subscription.remove();
    };
  }, []);

  // Start BLE stream and upload latest calibration when session begins
  useEffect(() => {
    if (sessionStatus !== "running") return;

    if (!sessionStartRef.current) {
      sessionStartRef.current = new Date();
    }

    if (!hasPreparedUploadRef.current) {
      hasPreparedUploadRef.current = true;

      const sessionId = currentSession?.id ?? `session_${Date.now()}`;
      sessionIdRef.current = sessionId;

      uploadCalibrationFile()
        .then((calibration) => {
          if (!calibration) {
            throw new Error("No calibration available to upload.");
          }
          return createSessionRecordAtStart({
            userId,
            sessionId,
            calibrationObjectKey: calibration.objectKey,
            startTime: sessionStartRef.current,
          });
        })
        .then((record) => {
          recordIdRef.current = record.recordId ?? null;
        })
        .catch((error) => {
          console.error("Failed to prepare session upload:", error);
        });
    }

    if (isStreamingRef.current) return;
    isStreamingRef.current = true;
    sessionPacketsRef.current = [];

    startEcgNotifications((payloadBase64) => {
      if (!isStreamingRef.current) return;
      const bytes = toByteArray(payloadBase64);
      sessionPacketsRef.current.push(bytes);
    }).catch((error) => {
      console.error("Failed to start ECG stream:", error);
    });
  }, [sessionStatus, startEcgNotifications, userId]);

  useEffect(() => {
    if (sessionStatus === "idle" || sessionStatus === "completed") {
      hasPreparedUploadRef.current = false;
      isStreamingRef.current = false;
      recordIdRef.current = null;
      sessionIdRef.current = null;
      sessionStartRef.current = null;
      stopEcgNotifications();
    }
  }, [sessionStatus, stopEcgNotifications]);

  useEffect(() => {
    return () => {
      isStreamingRef.current = false;
      stopEcgNotifications();
    };
  }, [stopEcgNotifications]);

  // Timer logic
  useEffect(() => {
    if (sessionStatus === "running") {
      timerRef.current = setInterval(() => {
        updateElapsedTime(elapsedTime + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [sessionStatus, elapsedTime, updateElapsedTime]);

  // Mock heart rate data generation
  useEffect(() => {
    if (sessionStatus === "running") {
      heartRateRef.current = setInterval(() => {
        // Generate mock heart rate data - replace with real BLE data
        const mockHeartRate = generateMockHeartRate(70, true);
        addHeartRateData({
          timestamp: Date.now(),
          heartRate: mockHeartRate,
          rrInterval: 60000 / mockHeartRate,
        });
      }, 1000);
    } else {
      if (heartRateRef.current) {
        clearInterval(heartRateRef.current);
        heartRateRef.current = null;
      }
    }

    return () => {
      if (heartRateRef.current) {
        clearInterval(heartRateRef.current);
      }
    };
  }, [sessionStatus, addHeartRateData]);

  const formatTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const handleStart = () => {
    startSession();
    setShowBackgroundTip(true);
  };

  const handlePauseResume = () => {
    if (sessionStatus === "running") {
      pauseSession();
    } else if (sessionStatus === "paused") {
      resumeSession();
    }
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

  const handleEnd = async () => {
    isStreamingRef.current = false;
    stopEcgNotifications();

    const chunks = sessionPacketsRef.current;
    sessionPacketsRef.current = [];

    if (chunks.length > 0) {
      const bytes = concatUint8Arrays(chunks);
      const sessionId = sessionIdRef.current ?? currentSession?.id ?? `session_${Date.now()}`;
      const recordId = recordIdRef.current;
      try {
        if (recordId) {
          await finalizeSessionRecording({
            recordId,
            userId,
            sessionId,
            bytes,
            startTime: sessionStartRef.current,
          });
        } else {
          console.warn("No Supabase record id available; session upload skipped.");
        }
      } catch (error) {
        console.error("Failed to upload session recording:", error);
      }
    }

    endSession();
    // Use replace to avoid re-rendering the current screen during navigation
    // and a small delay to ensure state updates are processed
    setTimeout(() => {
      router.replace("/run-summary");
    }, 100);
  };

  const handleMarkEvent = (type: "symptom" | "episode" | "user-mark") => {
    addEventMarker(type);
  };

  const handleBack = () => {
    if (sessionStatus === "idle") {
      router.back();
    }
  };

  const getHeartRateZone = (hr: number): { name: string; color: string } => {
    if (hr < 100) return { name: "Rest", color: "text-gray-500" };
    if (hr < 130) return { name: "Fat Burn", color: "text-green-500" };
    if (hr < 160) return { name: "Cardio", color: "text-yellow-500" };
    return { name: "Peak", color: "text-red-500" };
  };

  const zone = getHeartRateZone(currentHeartRate);

  // Pre-session view
  if (sessionStatus === "idle") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 px-6 pt-4">
          {/* Mock Mode Indicator */}
          {ENABLE_MOCK_MODE && (
            <View className="bg-purple-500/20 border border-purple-500/50 rounded-lg p-3 mb-4">
              <View className="flex-row items-center gap-2">
                <FlaskConical size={20} className="text-purple-500" />
                <View className="flex-1">
                  <Text className="text-purple-500 font-semibold text-sm">
                    Mock Mode Active
                  </Text>
                  <Text className="text-purple-400 text-xs">
                    Using simulated ECG data for prototyping
                  </Text>
                </View>
              </View>
            </View>
          )}

          <View className="flex-1 items-center justify-center">
            {/* Device Status */}
            <Card className="w-full mb-8">
              <CardContent className="p-4">
                <View className="flex-row items-center gap-3">
                  <View
                    className={`w-12 h-12 rounded-full items-center justify-center ${
                      isConnected ? "bg-green-500/20" : "bg-yellow-500/20"
                    }`}
                  >
                    <Zap
                      size={24}
                      className={
                        isConnected ? "text-green-500" : "text-yellow-500"
                      }
                    />
                  </View>
                  <View className="flex-1">
                    <Text className="font-semibold">
                      {pairedDevice?.name || "ECG Device"}
                    </Text>
                    <Text
                      className={`text-sm ${
                        isConnected ? "text-green-500" : "text-yellow-500"
                      }`}
                    >
                      {isConnected ? "Connected & Ready" : "Connecting..."}
                    </Text>
                  </View>
                </View>
              </CardContent>
            </Card>

            {/* Start Button */}
            <Pressable
              onPress={handleStart}
              disabled={!isConnected}
              className={`w-40 h-40 rounded-full items-center justify-center ${
                isConnected ? "bg-green-500" : "bg-muted"
              } active:opacity-80`}
            >
              <Play
                size={64}
                className={isConnected ? "text-white" : "text-muted-foreground"}
                fill={isConnected ? "white" : undefined}
              />
            </Pressable>

            <Text className="text-2xl font-bold mt-6">Start Session</Text>
            <Text className="text-muted-foreground text-center mt-2">
              {isConnected
                ? "Tap to begin your ECG monitoring session"
                : "Waiting for device connection..."}
            </Text>
          </View>

          <View className="pb-8">
            <Button variant="outline" onPress={handleBack} className="w-full">
              <Text>Cancel</Text>
            </Button>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Active session view (Strava-like)
  return (
    <SafeAreaView className="flex-1 bg-black">
      <View className="flex-1">
        {/* Mock Mode Banner */}
        {ENABLE_MOCK_MODE && (
          <View className="bg-purple-500/90 px-4 py-2 border-b border-purple-400">
            <View className="flex-row items-center justify-center gap-2">
              <FlaskConical size={16} color="white" />
              <Text className="text-white font-medium text-xs">
                MOCK MODE - Simulated Data
              </Text>
            </View>
          </View>
        )}

        {/* Background Tip Banner */}
        {showBackgroundTip && sessionStatus === "running" && (
          <Animated.View
            entering={FadeIn}
            exiting={FadeOut}
            className="bg-blue-500/90 px-4 py-3"
          >
            <Pressable
              onPress={() => setShowBackgroundTip(false)}
              className="flex-row items-center gap-3"
            >
              <Smartphone size={20} color="white" />
              <View className="flex-1">
                <Text className="text-white font-medium text-sm">
                  You can close this app or turn off your screen
                </Text>
                <Text className="text-white/80 text-xs">
                  Data collection will continue in the background
                </Text>
              </View>
              <ChevronUp size={20} color="white" />
            </Pressable>
          </Animated.View>
        )}

        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow justify-between pb-8"
          showsVerticalScrollIndicator={false}
        >
          {/* Main Stats Display */}
          <View className="items-center justify-start px-6 pt-6">
            {/* Heart Rate - Main Focus */}
            <View className="items-center mb-8">
              <Animated.View style={heartPulseStyle}>
                <Heart size={48} className="text-red-500 mb-2" fill="#ef4444" />
              </Animated.View>
              <Text className="text-white text-8xl font-bold">
                {currentHeartRate || "--"}
              </Text>
              <Text className="text-white/60 text-xl">BPM</Text>
              <View
                className={`px-3 py-1 rounded-full mt-2 ${
                  zone.name === "Rest"
                    ? "bg-gray-500/30"
                    : zone.name === "Fat Burn"
                      ? "bg-green-500/30"
                      : zone.name === "Cardio"
                        ? "bg-yellow-500/30"
                        : "bg-red-500/30"
                }`}
              >
                <Text className={`font-medium ${zone.color}`}>
                  {zone.name} Zone
                </Text>
              </View>
            </View>

            {/* Timer */}
            <View className="items-center mb-8">
              <View className="flex-row items-center gap-2 mb-1">
                <Clock size={18} color="#9ca3af" />
                <Text className="text-gray-400 text-sm">Duration</Text>
              </View>
              <Text className="text-white text-4xl font-mono font-bold">
                {formatTime(elapsedTime)}
              </Text>
            </View>

            {/* Stats Grid */}
            <View className="flex-row w-full gap-4 mb-8">
              <View className="flex-1 bg-white/10 rounded-xl p-4 items-center">
                <Text className="text-gray-400 text-xs mb-1">AVG</Text>
                <Text className="text-white text-2xl font-bold">
                  {averageHeartRate || "--"}
                </Text>
                <Text className="text-gray-400 text-xs">BPM</Text>
              </View>
              <View className="flex-1 bg-white/10 rounded-xl p-4 items-center">
                <Text className="text-gray-400 text-xs mb-1">MAX</Text>
                <Text className="text-white text-2xl font-bold">
                  {maxHeartRate || "--"}
                </Text>
                <Text className="text-gray-400 text-xs">BPM</Text>
              </View>
              <View className="flex-1 bg-white/10 rounded-xl p-4 items-center">
                <Text className="text-gray-400 text-xs mb-1">MIN</Text>
                <Text className="text-white text-2xl font-bold">
                  {minHeartRate === 999 ? "--" : minHeartRate}
                </Text>
                <Text className="text-gray-400 text-xs">BPM</Text>
              </View>
            </View>

            {/* Connection Status */}
            {!isConnected && (
              <View className="flex-row items-center gap-2 bg-yellow-500/20 px-4 py-2 rounded-full">
                <AlertCircle size={16} color="#f59e0b" />
                <Text className="text-yellow-500 text-sm">
                  Device disconnected - buffering data
                </Text>
              </View>
            )}
          </View>

          {/* Control Panel */}
          <View className="px-6">
            {/* Event Marking Button */}
            <Pressable
              onPress={() => handleMarkEvent("user-mark")}
              className="flex-row items-center justify-center gap-2 bg-yellow-500/20 rounded-xl p-4 mb-4 active:bg-yellow-500/30"
            >
              <Flag size={20} color="#f59e0b" />
              <Text className="text-yellow-500 font-medium">
                Mark Event / Symptom
              </Text>
            </Pressable>

            {/* Event Markers Count */}
            {eventMarkers.length > 0 && (
              <Animated.View
                entering={FadeIn}
                exiting={FadeOut}
                className="flex-row items-center justify-center gap-2 mb-4"
              >
                <Flag size={16} color="#f59e0b" />
                <Text className="text-yellow-500">
                  {eventMarkers.length} event
                  {eventMarkers.length > 1 ? "s" : ""} marked
                </Text>
              </Animated.View>
            )}

            {/* Main Controls */}
            <View className="flex-row items-center justify-center gap-6">
              {/* Pause/Resume Button */}
              <Pressable
                onPress={handlePauseResume}
                className={`w-20 h-20 rounded-full items-center justify-center ${
                  sessionStatus === "paused" ? "bg-green-500" : "bg-yellow-500"
                } active:opacity-80`}
              >
                {sessionStatus === "paused" ? (
                  <Play size={32} color="white" fill="white" />
                ) : (
                  <Pause size={32} color="white" />
                )}
              </Pressable>

              {/* End Button */}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Pressable className="w-20 h-20 rounded-full items-center justify-center bg-red-500 active:opacity-80">
                    <Square size={32} color="white" fill="white" />
                  </Pressable>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>End Session?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to end this session? Your data will
                      be saved and synced to the cloud.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>
                      <Text>Continue Session</Text>
                    </AlertDialogCancel>
                    <AlertDialogAction onPress={handleEnd}>
                      <Text className="text-black">End Session</Text>
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </View>

            {/* Status Text */}
            <Text className="text-gray-400 text-center mt-4">
              {sessionStatus === "paused" ? "Session Paused" : "Recording..."}
            </Text>
          </View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
