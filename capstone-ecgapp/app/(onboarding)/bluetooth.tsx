import { router } from "expo-router";
import {
  AlertCircle,
  ArrowLeft,
  Bluetooth,
  Check,
  FlaskConical,
  RefreshCw,
  Signal,
  Wifi,
  WifiOff,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { ENABLE_MOCK_MODE } from "@/config/mock-config";
import { useBluetoothService } from "@/services/bluetooth-service";
import { useAppStore } from "@/stores/app-store";
import type { ECGDevice } from "@/types";

interface DeviceItemProps {
  device: ECGDevice;
  isConnecting: boolean;
  isSelected: boolean;
  onSelect: () => void;
}

function DeviceItem({
  device,
  isConnecting,
  isSelected,
  onSelect,
}: DeviceItemProps) {
  const getSignalStrength = (rssi: number) => {
    if (rssi >= -50) return "Excellent";
    if (rssi >= -70) return "Good";
    if (rssi >= -85) return "Fair";
    return "Weak";
  };

  const getSignalColor = (rssi: number) => {
    if (rssi >= -50) return "text-green-500";
    if (rssi >= -70) return "text-yellow-500";
    if (rssi >= -85) return "text-orange-500";
    return "text-red-500";
  };

  return (
    <Pressable
      onPress={onSelect}
      disabled={isConnecting}
      className={`bg-card border rounded-xl p-4 mb-3 ${
        isSelected ? "border-primary" : "border-border"
      } active:opacity-80`}
    >
      <View className="flex-row items-center gap-4">
        <View
          className={`w-12 h-12 rounded-full items-center justify-center ${
            isSelected ? "bg-primary" : "bg-primary/10"
          }`}
        >
          {isConnecting ? (
            <ActivityIndicator
              size="small"
              color={isSelected ? "#fff" : undefined}
            />
          ) : device.isConnected ? (
            <Check
              size={24}
              className={
                isSelected ? "text-primary-foreground" : "text-primary"
              }
            />
          ) : (
            <Bluetooth
              size={24}
              className={
                isSelected ? "text-primary-foreground" : "text-primary"
              }
              strokeWidth={1.5}
            />
          )}
        </View>

        <View className="flex-1">
          <Text className="font-semibold text-base">{device.name}</Text>
          <View className="flex-row items-center gap-2 mt-1">
            <Signal size={14} className={getSignalColor(device.rssi)} />
            <Text className={`text-sm ${getSignalColor(device.rssi)}`}>
              {getSignalStrength(device.rssi)}
            </Text>
            <Text className="text-muted-foreground text-sm">
              ({device.rssi} dBm)
            </Text>
          </View>
        </View>

        {isConnecting && (
          <Text className="text-primary text-sm">Connecting...</Text>
        )}
        {device.isConnected && !isConnecting && (
          <View className="flex-row items-center gap-1">
            <Check size={16} className="text-green-500" />
            <Text className="text-green-500 text-sm">Connected</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

export default function BluetoothScreen() {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const {
    bluetoothStatus,
    connectionStatus,
    discoveredDevices,
    isScanning,
    error,
    pairedDevice,
    startScan,
    stopScan,
    connectToDevice,
  } = useBluetoothService();

  const { setOnboardingStep, completeOnboarding } = useAppStore();

  // Start scanning on mount
  useEffect(() => {
    if (bluetoothStatus === "poweredOn") {
      startScan();
    }
  }, [bluetoothStatus]);

  const handleRefresh = () => {
    stopScan();
    setTimeout(() => {
      startScan();
    }, 500);
  };

  const handleDeviceSelect = async (device: ECGDevice) => {
    if (isConnecting) return;

    setSelectedDeviceId(device.id);
    setIsConnecting(true);

    const success = await connectToDevice(device.id);

    setIsConnecting(false);

    if (success) {
      // Device connected successfully
      setSelectedDeviceId(device.id);
    } else {
      setSelectedDeviceId(null);
    }
  };

  const handleContinue = () => {
    setOnboardingStep("calibration");
    completeOnboarding();
    // Navigate to main app - calibration will be in the main app flow
    router.replace("/(tabs)");
  };

  const handleBack = () => {
    stopScan();
    router.back();
  };

  const handleSkip = () => {
    // Allow skipping for testing purposes
    completeOnboarding();
    router.replace("/(tabs)");
  };

  const isBluetoothReady = bluetoothStatus === "poweredOn";
  const hasConnectedDevice = connectionStatus === "connected" || pairedDevice;

  const renderEmptyState = () => {
    if (!isBluetoothReady) {
      return (
        <View className="items-center justify-center py-12">
          <View className="bg-destructive/10 w-20 h-20 rounded-full items-center justify-center mb-4">
            <WifiOff size={40} className="text-destructive" strokeWidth={1.5} />
          </View>
          <Text className="text-lg font-semibold mb-2">Bluetooth is Off</Text>
          <Text className="text-muted-foreground text-center px-4">
            Please turn on Bluetooth in your device settings to scan for ECG
            devices
          </Text>
        </View>
      );
    }

    if (isScanning) {
      return (
        <View className="items-center justify-center py-12">
          <ActivityIndicator size="large" className="mb-4" />
          <Text className="text-lg font-semibold mb-2">Scanning...</Text>
          <Text className="text-muted-foreground text-center">
            Looking for nearby ECG devices
          </Text>
        </View>
      );
    }

    return (
      <View className="items-center justify-center py-12">
        <View className="bg-muted w-20 h-20 rounded-full items-center justify-center mb-4">
          <Bluetooth
            size={40}
            className="text-muted-foreground"
            strokeWidth={1.5}
          />
        </View>
        <Text className="text-lg font-semibold mb-2">No Devices Found</Text>
        <Text className="text-muted-foreground text-center px-4 mb-4">
          Make sure your ECG device is turned on and in pairing mode
        </Text>
        <Button variant="outline" onPress={handleRefresh}>
          <RefreshCw size={16} className="text-foreground mr-2" />
          <Text>Scan Again</Text>
        </Button>
      </View>
    );
  };

  return (
    <SafeAreaView className="bg-background flex-1">
      <View className="flex-1 px-6 pt-4">
        {/* Back Button */}
        <View className="flex-row items-center justify-between mb-4">
          <Button variant="ghost" size="icon" onPress={handleBack}>
            <ArrowLeft size={24} className="text-foreground" />
          </Button>
          {isScanning && (
            <Button variant="ghost" onPress={stopScan}>
              <Text className="text-primary">Stop Scan</Text>
            </Button>
          )}
        </View>

        {/* Header */}
        <View className="mb-6">
          <Text variant="h2" className="border-b-0 pb-0 mb-2">
            Connect Your Device
          </Text>
          <Text className="text-muted-foreground text-base">
            Select your ECG device from the list below to pair
          </Text>
        </View>

        {/* Mock Mode Indicator */}
        {ENABLE_MOCK_MODE && (
          <View className="bg-purple-500/20 border border-purple-500/50 rounded-lg p-3 mb-4">
            <View className="flex-row items-center gap-2">
              <FlaskConical size={18} className="text-purple-500" />
              <View className="flex-1">
                <Text className="text-purple-500 font-semibold text-sm">
                  Mock Mode Active
                </Text>
                <Text className="text-purple-400 text-xs">
                  Using simulated device for development
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Status Bar */}
        <View className="flex-row items-center justify-between bg-card border border-border rounded-xl p-3 mb-4">
          <View className="flex-row items-center gap-2">
            {isBluetoothReady ? (
              <>
                <Wifi size={18} className="text-green-500" />
                <Text className="text-green-500 text-sm font-medium">
                  Bluetooth Ready
                </Text>
              </>
            ) : (
              <>
                <WifiOff size={18} className="text-destructive" />
                <Text className="text-destructive text-sm font-medium">
                  Bluetooth Off
                </Text>
              </>
            )}
          </View>
          <Button
            variant="ghost"
            size="sm"
            onPress={handleRefresh}
            disabled={!isBluetoothReady || isScanning}
          >
            <RefreshCw
              size={16}
              className={
                isScanning ? "text-muted-foreground" : "text-foreground"
              }
            />
          </Button>
        </View>

        {/* Error Message */}
        {error && (
          <View className="bg-destructive/10 border border-destructive/20 rounded-xl p-3 mb-4">
            <View className="flex-row items-center gap-2">
              <AlertCircle size={18} className="text-destructive" />
              <Text className="text-destructive text-sm flex-1">{error}</Text>
            </View>
          </View>
        )}

        {/* Device List */}
        <View className="flex-1">
          {discoveredDevices.length > 0 ? (
            <FlatList
              data={discoveredDevices}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <DeviceItem
                  device={item}
                  isConnecting={isConnecting && selectedDeviceId === item.id}
                  isSelected={selectedDeviceId === item.id}
                  onSelect={() => handleDeviceSelect(item)}
                />
              )}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 16 }}
            />
          ) : (
            renderEmptyState()
          )}
        </View>

        {/* Continue Button */}
        <View className="pb-8 pt-4">
          <Button
            size="lg"
            onPress={handleContinue}
            disabled={!hasConnectedDevice}
            className="w-full mb-3"
          >
            <Text className="text-primary-foreground font-semibold text-lg">
              Continue
            </Text>
          </Button>
          <Button variant="ghost" onPress={handleSkip}>
            <Text className="text-muted-foreground">Skip for now</Text>
          </Button>
        </View>
      </View>
    </SafeAreaView>
  );
}
