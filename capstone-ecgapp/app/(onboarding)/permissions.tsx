import { View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  MapPin,
  Bluetooth,
  ArrowLeft,
  Check,
  X,
  AlertCircle,
} from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { usePermissions, type PermissionStatus } from "@/hooks/use-permissions";
import { useAppStore } from "@/stores/app-store";

interface PermissionItemProps {
  icon: React.ComponentType<{
    size: number;
    className: string;
    strokeWidth?: number;
  }>;
  title: string;
  description: string;
  status: PermissionStatus;
  onRequest: () => void;
  isLoading?: boolean;
}

function PermissionItem({
  icon: Icon,
  title,
  description,
  status,
  onRequest,
  isLoading,
}: PermissionItemProps) {
  const getStatusIcon = () => {
    switch (status) {
      case "granted":
        return <Check size={20} className="text-green-500" />;
      case "denied":
        return <X size={20} className="text-destructive" />;
      default:
        return <AlertCircle size={20} className="text-muted-foreground" />;
    }
  };

  const getStatusText = () => {
    switch (status) {
      case "granted":
        return "Granted";
      case "denied":
        return "Denied";
      default:
        return "Not requested";
    }
  };

  return (
    <View className="bg-card border border-border rounded-xl p-4">
      <View className="flex-row items-start gap-4">
        <View className="bg-primary/10 w-12 h-12 rounded-full items-center justify-center">
          <Icon size={24} className="text-primary" strokeWidth={1.5} />
        </View>
        <View className="flex-1">
          <View className="flex-row items-center justify-between mb-1">
            <Text className="font-semibold text-base">{title}</Text>
            <View className="flex-row items-center gap-1">
              {getStatusIcon()}
              <Text
                className={`text-sm ${
                  status === "granted"
                    ? "text-green-500"
                    : status === "denied"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                {getStatusText()}
              </Text>
            </View>
          </View>
          <Text className="text-muted-foreground text-sm mb-3">
            {description}
          </Text>
          {status !== "granted" && (
            <Button
              variant={status === "denied" ? "outline" : "default"}
              size="sm"
              onPress={onRequest}
              disabled={isLoading}
              className="self-start"
            >
              <Text
                className={`text-sm font-medium ${
                  status === "denied"
                    ? "text-foreground"
                    : "text-primary-foreground"
                }`}
              >
                {status === "denied" ? "Open Settings" : "Allow"}
              </Text>
            </Button>
          )}
        </View>
      </View>
    </View>
  );
}

export default function PermissionsScreen() {
  const {
    permissions,
    isChecking,
    allPermissionsGranted,
    requestLocationPermission,
    requestBluetoothPermission,
    openSettings,
  } = usePermissions();

  const { setOnboardingStep } = useAppStore();

  const handleContinue = () => {
    setOnboardingStep("bluetooth");
    router.push("/(onboarding)/bluetooth");
  };

  const handleBack = () => {
    router.back();
  };

  const handleLocationRequest = async () => {
    if (permissions.location === "denied") {
      openSettings();
    } else {
      await requestLocationPermission();
    }
  };

  const handleBluetoothRequest = async () => {
    if (permissions.bluetooth === "denied") {
      openSettings();
    } else {
      await requestBluetoothPermission();
    }
  };

  return (
    <SafeAreaView className="bg-background flex-1">
      <View className="flex-1 px-6 pt-4">
        {/* Back Button */}
        <Button
          variant="ghost"
          size="icon"
          onPress={handleBack}
          className="self-start mb-4"
        >
          <ArrowLeft size={24} className="text-foreground" />
        </Button>

        {/* Header */}
        <View className="mb-8">
          <Text variant="h2" className="border-b-0 pb-0 mb-2">
            Enable Permissions
          </Text>
          <Text className="text-muted-foreground text-base">
            We need a few permissions to connect to your ECG device and provide
            the best experience
          </Text>
        </View>

        {/* Permissions List */}
        <View className="gap-4">
          <PermissionItem
            icon={MapPin}
            title="Location"
            description="Required for Bluetooth device scanning. We don't track your location."
            status={permissions.location}
            onRequest={handleLocationRequest}
            isLoading={isChecking}
          />
          <PermissionItem
            icon={Bluetooth}
            title="Bluetooth"
            description="Required to connect and communicate with your ECG device."
            status={permissions.bluetooth}
            onRequest={handleBluetoothRequest}
            isLoading={isChecking}
          />
        </View>

        {/* Info Card */}
        <View className="bg-muted/50 rounded-xl p-4 mt-6">
          <View className="flex-row items-start gap-3">
            <AlertCircle
              size={20}
              className="text-muted-foreground mt-0.5"
              strokeWidth={1.5}
            />
            <View className="flex-1">
              <Text className="text-sm text-muted-foreground">
                These permissions are only used to communicate with your ECG
                device. Your data remains private and secure.
              </Text>
            </View>
          </View>
        </View>

        {/* Spacer */}
        <View className="flex-1" />

        {/* Continue Button */}
        <View className="pb-8 pt-6">
          <Button
            size="lg"
            onPress={handleContinue}
            disabled={!allPermissionsGranted}
            className="w-full"
          >
            <Text className="text-primary-foreground font-semibold text-lg">
              Continue
            </Text>
          </Button>
          {!allPermissionsGranted && (
            <Text className="text-muted-foreground text-center text-sm mt-3">
              Please grant all permissions to continue
            </Text>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
