import { Card, CardContent, Progress, Text } from "@/components/ui";
import { useBluetoothService } from "@/services/bluetooth-service";
import { useAppStore } from "@/stores/app-store";
import { useSessionHistoryStore } from "@/stores/session-store";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// Mock data for the health metrics
const heartRateData = {
  current: 72,
  min: 58,
  max: 124,
  resting: 62,
};

const ecgStatus = {
  lastReading: "2 hours ago",
  status: "Normal Sinus Rhythm",
  nextRecommended: "Tomorrow",
};

const dayLabels = ["S", "M", "T", "W", "T", "F", "S"];

function ActivityBar({ value, day }: { value: number; day: string }) {
  return (
    <View className="items-center gap-1 flex-1">
      <View className="h-20 w-full justify-end">
        <View
          className="bg-primary/80 rounded-t-sm w-full"
          style={{ height: `${value}%` }}
        />
      </View>
      <Text className="text-muted-foreground text-xs">{day}</Text>
    </View>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { connectionStatus, pairedDevice, reconnectToPairedDevice } =
    useBluetoothService();
  const { user, isCalibrated } = useAppStore();
  const { sessions } = useSessionHistoryStore();

  const isConnected = connectionStatus === "connected";
  const isConnecting =
    connectionStatus === "connecting" || connectionStatus === "reconnecting";

  const handleDeviceAction = () => {
    if (!pairedDevice) {
      // Navigate to bluetooth pairing screen
      router.push("/(onboarding)/bluetooth");
    } else if (!isConnected && !isConnecting) {
      reconnectToPairedDevice();
    } else if (isConnected) {
      // Start ECG recording - go to calibration if not calibrated
      if (!isCalibrated) {
        router.push("/calibration");
      } else {
        router.push("/run-session");
      }
    }
  };

  const handleStartRun = () => {
    if (!pairedDevice) {
      Alert.alert(
        "No Device Paired",
        "Please pair your ECG device before starting a session.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Pair Device",
            onPress: () => router.push("/(onboarding)/bluetooth"),
          },
        ],
      );
      return;
    }

    if (!isConnected) {
      Alert.alert(
        "Device Not Connected",
        "Your ECG device is not connected. Would you like to reconnect?",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Reconnect", onPress: () => reconnectToPairedDevice() },
        ],
      );
      return;
    }

    if (!isCalibrated) {
      Alert.alert(
        "Calibration Required",
        "Your device needs to be calibrated before starting a session.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Calibrate", onPress: () => router.push("/calibration") },
        ],
      );
      return;
    }

    router.push("/run-session");
  };

  const handleSeeAllActivity = () => {
    router.push("/activity-calendar");
  };

  const sessionDayCounts = useMemo(() => {
    const counts = new Map<string, number>();

    sessions.forEach((session) => {
      const date = new Date(session.startTime);
      if (Number.isNaN(date.getTime())) return;

      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
        2,
        "0",
      )}-${String(date.getDate()).padStart(2, "0")}`;

      counts.set(key, (counts.get(key) ?? 0) + 1);
    });

    return counts;
  }, [sessions]);

  const weeklyActivityData = useMemo(() => {
    const today = new Date();
    const data = [] as { day: string; value: number; count: number }[];
    let maxCount = 0;

    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);

      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
        2,
        "0",
      )}-${String(date.getDate()).padStart(2, "0")}`;
      const count = sessionDayCounts.get(key) ?? 0;

      maxCount = Math.max(maxCount, count);
      data.push({ day: dayLabels[date.getDay()], value: 0, count });
    }

    return data.map((item) => ({
      ...item,
      value: maxCount === 0 ? 0 : Math.round((item.count / maxCount) * 100),
    }));
  }, [sessionDayCounts]);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View className="px-5 pt-4 pb-2">
        <View className="flex-row justify-between items-center">
          <View>
            <Text className="text-muted-foreground text-sm">
              {getGreeting()}
            </Text>
            <Text className="text-2xl font-bold">
              {user?.name || "Your Health"}
            </Text>
          </View>
          <Pressable className="w-10 h-10 rounded-full bg-secondary items-center justify-center">
            <Ionicons name="person" size={20} className="text-foreground" />
          </Pressable>
        </View>
      </View>

      <View className="px-5 pb-2">
        <Pressable
          className="bg-primary rounded-xl py-3 px-4 flex-row items-center justify-center gap-2 active:opacity-80"
          onPress={handleStartRun}
        >
          <Ionicons name="play" size={18} color="#ffffff" />
          <Text className="text-primary-foreground font-semibold">
            Start Run
          </Text>
        </Pressable>
      </View>

      {/* ECG Device Status Card */}
      <View className="px-5 py-3">
        <Card className="bg-gradient-to-br from-red-500/10 to-pink-500/10 border-red-200 dark:border-red-900">
          <CardContent className="p-4">
            <View className="flex-row justify-between items-start mb-3">
              <View className="flex-row items-center gap-2">
                <View className="w-10 h-10 rounded-full bg-red-500/20 items-center justify-center">
                  {isConnecting ? (
                    <ActivityIndicator size="small" color="#ef4444" />
                  ) : (
                    <Ionicons name="pulse" size={24} color="#ef4444" />
                  )}
                </View>
                <View>
                  <Text className="font-semibold text-base">
                    {pairedDevice?.name || "ECG Monitor"}
                  </Text>
                  <View className="flex-row items-center gap-1">
                    <View
                      className={`w-2 h-2 rounded-full ${
                        isConnected
                          ? "bg-green-500"
                          : isConnecting
                            ? "bg-yellow-500"
                            : pairedDevice
                              ? "bg-orange-500"
                              : "bg-gray-400"
                      }`}
                    />
                    <Text className="text-muted-foreground text-xs">
                      {isConnected
                        ? "Connected"
                        : isConnecting
                          ? "Connecting..."
                          : pairedDevice
                            ? "Disconnected"
                            : "No Device"}
                    </Text>
                  </View>
                </View>
              </View>
              <Pressable
                className={`px-3 py-1.5 rounded-full ${
                  isConnected ? "bg-red-500" : "bg-primary"
                }`}
                onPress={handleDeviceAction}
                disabled={isConnecting}
              >
                <Text className="text-white text-xs font-medium">
                  {isConnected
                    ? "Take ECG"
                    : isConnecting
                      ? "Connecting..."
                      : pairedDevice
                        ? "Reconnect"
                        : "Pair Device"}
                </Text>
              </Pressable>
            </View>

            {!isConnected && !isConnecting && (
              <View className="py-2 items-center">
                <Text className="text-muted-foreground text-sm text-center">
                  {pairedDevice
                    ? "Tap 'Reconnect' to connect to your ECG device"
                    : "Pair your ECG device to start monitoring"}
                </Text>
              </View>
            )}

            {isConnected && (
              <View className="flex-row justify-between mt-3 pt-3 border-t border-border">
                <View>
                  <Text className="text-muted-foreground text-xs">
                    Last Reading
                  </Text>
                  <Text className="font-medium text-sm">
                    {ecgStatus.lastReading}
                  </Text>
                </View>
                <View className="items-end">
                  <Text className="text-muted-foreground text-xs">Status</Text>
                  <Text className="font-medium text-sm text-green-600">
                    {ecgStatus.status}
                  </Text>
                </View>
              </View>
            )}
          </CardContent>
        </Card>
      </View>

      {/* Heart Rate Stats */}
      <View className="px-5 py-2">
        <Text className="text-lg font-semibold mb-2">Heart Rate</Text>
        <Card>
          <CardContent className="p-3">
            <View className="flex-row items-center justify-between mb-2">
              <View>
                <Text className="text-muted-foreground text-xs">Current</Text>
                <View className="flex-row items-baseline gap-1">
                  <Text className="text-2xl font-bold">
                    {heartRateData.current}
                  </Text>
                  <Text className="text-muted-foreground text-xs">BPM</Text>
                </View>
              </View>
              <View className="items-end">
                <Text className="text-muted-foreground text-xs">Resting</Text>
                <Text className="font-semibold text-base">
                  {heartRateData.resting} BPM
                </Text>
              </View>
            </View>

            <View className="flex-row justify-between items-center mb-2">
              <Text className="text-muted-foreground text-xs">
                Today's Range
              </Text>
              <Text className="text-xs text-muted-foreground">
                {heartRateData.min} - {heartRateData.max} BPM
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <Text className="text-muted-foreground text-xs w-7">
                {heartRateData.min}
              </Text>
              <View className="flex-1">
                <Progress
                  value={
                    ((heartRateData.current - heartRateData.min) /
                      (heartRateData.max - heartRateData.min)) *
                    100
                  }
                  className="h-2 bg-muted"
                  indicatorClassName="bg-red-500"
                />
              </View>
              <Text className="text-muted-foreground text-xs w-7 text-right">
                {heartRateData.max}
              </Text>
            </View>
          </CardContent>
        </Card>
      </View>

      {/* Weekly Activity */}
      <View className="px-5 py-3">
        <View className="flex-row justify-between items-center mb-3">
          <Text className="text-lg font-semibold">Weekly Activity</Text>
          <Pressable onPress={handleSeeAllActivity}>
            <Text className="text-primary text-sm">See All</Text>
          </Pressable>
        </View>
        <Card>
          <CardContent className="p-4">
            <View className="flex-row gap-2">
              {weeklyActivityData.map((item, index) => (
                <ActivityBar key={index} value={item.value} day={item.day} />
              ))}
            </View>
            {weeklyActivityData.every((item) => item.count === 0) && (
              <Text className="text-muted-foreground text-xs mt-3 text-center">
                No activity recorded this week
              </Text>
            )}
          </CardContent>
        </Card>
      </View>

      {/* Health Insights */}
      <View className="px-5 py-3">
        <Text className="text-lg font-semibold mb-3">Insights</Text>
        <Card>
          <CardContent className="p-4">
            <View className="flex-row items-start gap-3">
              <View className="w-10 h-10 rounded-full bg-green-500/20 items-center justify-center">
                <Ionicons name="checkmark-circle" size={24} color="#22c55e" />
              </View>
              <View className="flex-1">
                <Text className="font-semibold">Heart Health Looking Good</Text>
                <Text className="text-muted-foreground text-sm mt-1">
                  Your resting heart rate has been consistent over the past
                  week. Keep up the good work!
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>

        <Card className="mt-3">
          <CardContent className="p-4">
            <View className="flex-row items-start gap-3">
              <View className="w-10 h-10 rounded-full bg-blue-500/20 items-center justify-center">
                <Ionicons name="calendar" size={24} color="#3b82f6" />
              </View>
              <View className="flex-1">
                <Text className="font-semibold">Scheduled ECG Reminder</Text>
                <Text className="text-muted-foreground text-sm mt-1">
                  Your next recommended ECG reading is{" "}
                  {ecgStatus.nextRecommended}. Regular monitoring helps track
                  your heart health.
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>
      </View>
    </ScrollView>
  );
}
