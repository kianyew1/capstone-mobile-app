import { router } from "expo-router";
import {
  AlertCircle,
  ChevronUp,
  Clock,
  Flag,
  Heart,
  Pause,
  Play,
  Smartphone,
  Square,
  Zap,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  AppState,
  InteractionManager,
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

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { ENABLE_MOCK_MODE } from "@/config/mock-config";
import {
  checkSessionSignalQuality,
  startSessionRecord,
} from "@/services/backend-ecg";
import { useBluetoothService } from "@/services/bluetooth-service";
import {
  concatUint8Arrays,
  ECG_PACKET_BYTES,
  ECG_SAMPLES_PER_PACKET,
} from "@/services/ecg-utils";
import {
  appendSessionPacket,
  beginSessionCapture,
  setSessionCaptureRecordId,
} from "@/services/session-packet-storage";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";

export default function RunSessionScreen() {
  const [showBackgroundTip, setShowBackgroundTip] = useState(true);
  const [isAppActive, setIsAppActive] = useState(true);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionCheckTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const expectedPacketBytes = ECG_PACKET_BYTES;

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
    setPendingUpload,
  } = useSessionStore();

  const {
    connectionStatus,
    pairedDevice,
    startEcgNotifications,
    stopEcgNotifications,
  } = useBluetoothService();
  const { user, calibrationResult } = useAppStore();
  const isConnected = connectionStatus === "connected";
  const userId = user?.email ?? "unknown@local";

  const sessionCheckPacketsRef = useRef<Uint8Array[]>([]);
  const sessionPacketCountRef = useRef(0);
  const invalidPacketCountRef = useRef(0);
  const simulatedHeartRateRef = useRef(78);
  const sessionStartRef = useRef<Date | null>(null);
  const isStreamingRef = useRef(false);
  const isSessionCheckInFlightRef = useRef(false);
  const hasPreparedUploadRef = useRef(false);
  const hasInitializedSessionCaptureRef = useRef(false);
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

      const sessionId = formatSessionId(sessionStartRef.current ?? new Date());
      sessionIdRef.current = sessionId;
      void beginSessionCapture({
        sessionId,
        recordId: null,
        startTimeIso: sessionStartRef.current?.toISOString() ?? null,
      }).catch((error) => {
        console.error("Failed to initialize session SQLite capture:", error);
      });
      const calibrationObjectKey = calibrationResult?.calibrationObjectKey;
      if (!calibrationObjectKey) {
        hasPreparedUploadRef.current = false;
        console.error(
          "Failed to prepare session upload:",
          new Error("Missing calibration object key."),
        );
        return;
      }

      startSessionRecord({
        userId,
        sessionId,
        calibrationObjectKey,
        startTime: sessionStartRef.current,
      })
        .then((record) => {
          recordIdRef.current = record.recordId ?? null;
          if (recordIdRef.current) {
            console.log(
              `[SESSION] Supabase record created record_id=${recordIdRef.current}`,
            );
            void setSessionCaptureRecordId(sessionId, record.recordId).catch(
              (error) => {
                console.error(
                  "Failed to persist session record id to SQLite:",
                  error,
                );
              },
            );
          }
        })
        .catch((error) => {
          console.error("Failed to prepare session upload:", error);
        });
    }

    if (isStreamingRef.current) return;
    isStreamingRef.current = true;
    if (!hasInitializedSessionCaptureRef.current) {
      hasInitializedSessionCaptureRef.current = true;
      sessionCheckPacketsRef.current = [];
      sessionPacketCountRef.current = 0;
      invalidPacketCountRef.current = 0;
      console.log(
        `[SESSION] start stream expectedBytes=${expectedPacketBytes}`,
      );
    } else {
      console.log("[SESSION] resume stream");
    }

    startEcgNotifications((payloadBase64) => {
      if (!isStreamingRef.current) return;
      const bytes = toByteArray(payloadBase64);
      if (bytes.length !== expectedPacketBytes) {
        invalidPacketCountRef.current += 1;
        const invalidCount = invalidPacketCountRef.current;
        if (invalidCount <= 5 || invalidCount % 50 === 0) {
          console.log(
            `[SESSION] invalid packet len=${bytes.length} expected=${expectedPacketBytes} count=${invalidCount}`,
          );
        }
        return;
      }
      sessionCheckPacketsRef.current.push(bytes);
      sessionPacketCountRef.current += 1;
      const count = sessionPacketCountRef.current;
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void appendSessionPacket({
          sessionId,
          packetIndex: count,
          receivedAtMs: Date.now(),
          bytes,
        }).catch((error) => {
          console.error("Failed to append session packet to SQLite:", error);
        });
      }
      if (count === 1) {
        console.log(`[SESSION] first packet bytes=${bytes.length}`);
      } else if (count % 20 === 0) {
        console.log(`[SESSION] packet=${count}`);
      }
    }).catch((error) => {
      console.error("Failed to start ECG stream:", error);
    });
  }, [
    calibrationResult?.calibrationObjectKey,
    sessionStatus,
    startEcgNotifications,
    userId,
  ]);

  useEffect(() => {
    if (sessionStatus !== "running") {
      if (sessionCheckTimerRef.current) {
        clearInterval(sessionCheckTimerRef.current);
        sessionCheckTimerRef.current = null;
      }
      if (sessionStatus === "paused") {
        isStreamingRef.current = false;
        stopEcgNotifications();
        console.log("[SESSION] paused stream");
      }
      return;
    }

    const flushSessionCheck = async () => {
      if (isSessionCheckInFlightRef.current) return;
      const recordId = recordIdRef.current;
      const sessionId = sessionIdRef.current;
      if (!recordId || !sessionId) {
        return;
      }
      const chunkPackets = sessionCheckPacketsRef.current;
      if (chunkPackets.length === 0) {
        return;
      }

      sessionCheckPacketsRef.current = [];
      const bytes = concatUint8Arrays(chunkPackets);
      isSessionCheckInFlightRef.current = true;
      try {
        const result = await checkSessionSignalQuality({
          recordId,
          sessionId,
          bytes,
        });
        console.log(
          `[SESSION] live check result abnormal=${result.abnormalDetected} signal_ok=${result.signalOk} quality=${result.qualityPercentage.toFixed(2)} hr=${result.heartRateBpm ?? "null"} reasons=${result.reasonCodes.join("|") || "none"} buffered_packets=${result.totalPacketsBuffered}`,
        );
      } catch (error) {
        console.error("Failed to run live session check:", error);
      } finally {
        isSessionCheckInFlightRef.current = false;
      }
    };

    sessionCheckTimerRef.current = setInterval(() => {
      void flushSessionCheck();
    }, 500);

    return () => {
      if (sessionCheckTimerRef.current) {
        clearInterval(sessionCheckTimerRef.current);
        sessionCheckTimerRef.current = null;
      }
    };
  }, [sessionStatus, stopEcgNotifications]);

  useEffect(() => {
    if (sessionStatus === "idle" || sessionStatus === "completed") {
      hasPreparedUploadRef.current = false;
      hasInitializedSessionCaptureRef.current = false;
      isStreamingRef.current = false;
      isSessionCheckInFlightRef.current = false;
      recordIdRef.current = null;
      sessionIdRef.current = null;
      sessionStartRef.current = null;
      sessionCheckPacketsRef.current = [];
      stopEcgNotifications();
    }
  }, [sessionStatus, stopEcgNotifications]);

  useEffect(() => {
    if (sessionStatus !== "running" || !ENABLE_MOCK_MODE) {
      return;
    }

    const timer = setInterval(() => {
      const drift = Math.floor(Math.random() * 7) - 3;
      const baselineShift = Math.sin(Date.now() / 5000) * 2;
      const next = Math.round(
        simulatedHeartRateRef.current + drift + baselineShift,
      );
      simulatedHeartRateRef.current = Math.min(142, Math.max(64, next));

      addHeartRateData({
        heartRate: simulatedHeartRateRef.current,
        timestamp: Date.now(),
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [addHeartRateData, sessionStatus]);

  useEffect(() => {
    return () => {
      isStreamingRef.current = false;
      isSessionCheckInFlightRef.current = false;
      if (sessionCheckTimerRef.current) {
        clearInterval(sessionCheckTimerRef.current);
        sessionCheckTimerRef.current = null;
      }
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

  useEffect(() => {
    if (sessionStatus !== "running") return;
    console.log(
      `[SESSION] packets captured=${sessionPacketCountRef.current} samplesPerChannel=${sessionPacketCountRef.current * ECG_SAMPLES_PER_PACKET}`,
    );
  }, [sessionStatus]);

  const formatTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const formatSessionId = (timestamp: Date) => {
    const day = String(timestamp.getDate()).padStart(2, "0");
    const month = timestamp.toLocaleString("en-US", { month: "short" });
    const year = String(timestamp.getFullYear()).slice(-2);
    const hours = String(timestamp.getHours()).padStart(2, "0");
    const minutes = String(timestamp.getMinutes()).padStart(2, "0");
    return `session_${day}${month}${year}_${hours}${minutes}H`;
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

  const handleEnd = async () => {
    isStreamingRef.current = false;
    if (sessionCheckTimerRef.current) {
      clearInterval(sessionCheckTimerRef.current);
      sessionCheckTimerRef.current = null;
    }
    stopEcgNotifications();

    const recordId = recordIdRef.current;
    const sessionId = sessionIdRef.current;

    if (!sessionId) {
      console.warn("Missing session identifier; upload will be skipped.");
    } else {
      const samplesPerChannel =
        sessionPacketCountRef.current * ECG_SAMPLES_PER_PACKET;
      console.log(
        `[SESSION] end packets=${sessionPacketCountRef.current} samplesPerChannel=${samplesPerChannel} invalidPackets=${invalidPacketCountRef.current}`,
      );
      if (sessionPacketCountRef.current === 0 && !ENABLE_MOCK_MODE) {
        console.warn("No session bytes captured; upload will be skipped.");
      }

      setPendingUpload({
        recordId,
        sessionId,
        startTimeIso: sessionStartRef.current?.toISOString() ?? null,
        useMock: false,
      });
    }

    endSession();

    InteractionManager.runAfterInteractions(() => {
      requestAnimationFrame(() => {
        router.replace("/run-summary");
      });
    });
  };

  const handleMarkEvent = (type: "symptom" | "episode" | "user-mark") => {
    addEventMarker(type);
  };

  const handleConfirmEnd = () => {
    Alert.alert(
      "End Session?",
      "Are you sure you want to end this session? Your data will be saved and synced to the cloud.",
      [
        { text: "Continue Session", style: "cancel" },
        {
          text: "End Session",
          style: "destructive",
          onPress: () => {
            void handleEnd();
          },
        },
      ],
      { cancelable: true },
    );
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
              <Pressable
                onPress={handleConfirmEnd}
                className="w-20 h-20 rounded-full items-center justify-center bg-red-500 active:opacity-80"
              >
                <Square size={32} color="white" fill="white" />
              </Pressable>
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
