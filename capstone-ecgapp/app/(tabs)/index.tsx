import { Card, CardContent, Progress, Text } from "@/components/ui";
import { Ionicons } from "@expo/vector-icons";
import {
  Pressable,
  ScrollView,
  View,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useBluetoothService } from "@/services/bluetooth-service";
import { useAppStore } from "@/stores/app-store";
import { useSessionHistoryStore } from "@/stores/session-store";

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

const weeklyActivity = [
  { day: "M", value: 65 },
  { day: "T", value: 80 },
  { day: "W", value: 45 },
  { day: "T", value: 90 },
  { day: "F", value: 70 },
  { day: "S", value: 55 },
  { day: "S", value: 30 },
];

function MetricCard({
  title,
  value,
  unit,
  subtitle,
  icon,
  iconColor = "text-primary",
  children,
}: {
  title: string;
  value?: string | number;
  unit?: string;
  subtitle?: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className="flex-1">
      <CardContent className="p-4">
        <View className="flex-row items-center gap-2 mb-2">
          <Ionicons name={icon} size={20} className={iconColor} />
          <Text className="text-muted-foreground text-sm font-medium">
            {title}
          </Text>
        </View>
        {value !== undefined && (
          <View className="flex-row items-baseline gap-1">
            <Text className="text-3xl font-bold">{value}</Text>
            {unit && (
              <Text className="text-muted-foreground text-sm">{unit}</Text>
            )}
          </View>
        )}
        {subtitle && (
          <Text className="text-muted-foreground text-xs mt-1">{subtitle}</Text>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

function ECGWaveform() {
  // Simplified ECG waveform visualization
  return (
    <View className="h-16 flex-row items-center justify-center gap-0.5 overflow-hidden">
      {[...Array(40)].map((_, i) => {
        // Create a simplified ECG pattern
        const isQRS = i % 10 === 5;
        const isPWave = i % 10 === 3;
        const isTWave = i % 10 === 7;
        let height = 8;
        if (isQRS) height = 32;
        else if (isPWave || isTWave) height = 16;

        return (
          <View
            key={i}
            className="bg-red-500 w-1 rounded-full"
            style={{ height, opacity: 0.4 + (i / 40) * 0.6 }}
          />
        );
      })}
    </View>
  );
}

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
  const {
    connectionStatus,
    pairedDevice,
    reconnectToPairedDevice,
    isScanning,
    startScan,
  } = useBluetoothService();
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

  const handleCalibrate = () => {
    router.push("/calibration");
  };

  const handleViewHistory = () => {
    router.push("/(tabs)/explore");
  };

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

            {isConnected && <ECGWaveform />}

            {!isConnected && !isConnecting && (
              <View className="py-4 items-center">
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
      <View className="px-5 py-3">
        <Text className="text-lg font-semibold mb-3">Heart Rate</Text>
        <View className="flex-row gap-3">
          <MetricCard
            title="Current"
            value={heartRateData.current}
            unit="BPM"
            icon="heart"
            iconColor="text-red-500"
          />
          <MetricCard
            title="Resting"
            value={heartRateData.resting}
            unit="BPM"
            subtitle="Average"
            icon="bed"
            iconColor="text-blue-500"
          />
        </View>

        <Card className="mt-3">
          <CardContent className="p-4">
            <View className="flex-row justify-between items-center mb-3">
              <Text className="text-muted-foreground text-sm font-medium">
                Today's Range
              </Text>
              <Text className="text-xs text-muted-foreground">
                {heartRateData.min} - {heartRateData.max} BPM
              </Text>
            </View>
            <View className="flex-row items-center gap-3">
              <Text className="text-muted-foreground text-xs w-8">
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
              <Text className="text-muted-foreground text-xs w-8 text-right">
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
          <Pressable>
            <Text className="text-primary text-sm">See All</Text>
          </Pressable>
        </View>
        <Card>
          <CardContent className="p-4">
            <View className="flex-row gap-2">
              {weeklyActivity.map((item, index) => (
                <ActivityBar key={index} value={item.value} day={item.day} />
              ))}
            </View>
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

      {/* Quick Actions */}
      <View className="px-5 py-3">
        <Text className="text-lg font-semibold mb-3">Quick Actions</Text>
        <View className="flex-row gap-3 mb-3">
          <Pressable
            className="flex-1 bg-green-500 rounded-xl p-4 items-center active:opacity-80"
            onPress={handleStartRun}
          >
            <Ionicons name="play" size={28} color="white" />
            <Text className="text-white font-medium mt-2">Start Run</Text>
          </Pressable>
          <Pressable
            className="flex-1 bg-primary rounded-xl p-4 items-center active:opacity-80"
            onPress={handleCalibrate}
          >
            <Ionicons name="pulse" size={28} color="white" />
            <Text className="text-primary-foreground font-medium mt-2">
              {isCalibrated ? "Re-calibrate" : "Calibrate"}
            </Text>
          </Pressable>
        </View>
        <View className="flex-row gap-3">
          <Pressable
            className="flex-1 bg-secondary rounded-xl p-4 items-center active:opacity-80"
            onPress={handleViewHistory}
          >
            <Ionicons
              name="stats-chart"
              size={28}
              className="text-foreground"
            />
            <Text className="font-medium mt-2">History</Text>
            {sessions.length > 0 && (
              <Text className="text-muted-foreground text-xs">
                {sessions.length} sessions
              </Text>
            )}
          </Pressable>
          <Pressable className="flex-1 bg-secondary rounded-xl p-4 items-center active:opacity-80">
            <Ionicons
              name="share-outline"
              size={28}
              className="text-foreground"
            />
            <Text className="font-medium mt-2">Share</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}
