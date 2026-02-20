import { View, ScrollView, Pressable, Alert } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  User,
  Bluetooth,
  Bell,
  Shield,
  HelpCircle,
  LogOut,
  ChevronRight,
  Moon,
  RefreshCw,
} from "lucide-react-native";

import { Text } from "@/components/ui/text";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { DeviceConnectionCard } from "@/components/device-connection-card";
import { useAppStore } from "@/stores/app-store";
import { useColorScheme } from "@/hooks/use-color-scheme";

interface SettingsItemProps {
  icon: React.ComponentType<{
    size: number;
    className: string;
    strokeWidth?: number;
  }>;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  rightElement?: React.ReactNode;
}

function SettingsItem({
  icon: Icon,
  title,
  subtitle,
  onPress,
  rightElement,
}: SettingsItemProps) {
  const content = (
    <View className="flex-row items-center py-3">
      <View className="bg-primary/10 w-10 h-10 rounded-full items-center justify-center mr-3">
        <Icon size={20} className="text-primary" strokeWidth={1.5} />
      </View>
      <View className="flex-1">
        <Text className="font-medium">{title}</Text>
        {subtitle && (
          <Text className="text-muted-foreground text-sm">{subtitle}</Text>
        )}
      </View>
      {rightElement ||
        (onPress && (
          <ChevronRight size={20} className="text-muted-foreground" />
        ))}
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} className="active:opacity-70">
        {content}
      </Pressable>
    );
  }

  return content;
}

export default function SettingsScreen() {
  const { user, resetOnboarding, pairedDevice } = useAppStore();
  const colorScheme = useColorScheme();

  const handleLogout = () => {
    Alert.alert(
      "Log Out",
      "Are you sure you want to log out? You will need to go through the setup process again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Log Out",
          style: "destructive",
          onPress: () => {
            resetOnboarding();
            router.replace("/(onboarding)/welcome");
          },
        },
      ],
    );
  };

  const handleResetOnboarding = () => {
    Alert.alert(
      "Reset Setup",
      "This will clear all your data and restart the setup process. Are you sure?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => {
            resetOnboarding();
            router.replace("/(onboarding)/welcome");
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View className="px-5 pt-4 pb-6">
          <Text className="text-2xl font-bold">Settings</Text>
        </View>

        {/* Profile Section */}
        <View className="px-5 mb-6">
          <Card>
            <CardContent className="p-4">
              <View className="flex-row items-center gap-4">
                <View className="w-16 h-16 rounded-full bg-primary items-center justify-center">
                  <Text className="text-primary-foreground text-2xl font-bold">
                    {user?.name?.charAt(0).toUpperCase() || "U"}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className="text-lg font-semibold">
                    {user?.name || "User"}
                  </Text>
                  <Text className="text-muted-foreground">
                    {user?.email || "No email"}
                  </Text>
                </View>
                <Button variant="ghost" size="icon">
                  <ChevronRight size={20} className="text-muted-foreground" />
                </Button>
              </View>
            </CardContent>
          </Card>
        </View>

        {/* Device Section */}
        <View className="px-5 mb-6">
          <Text className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">
            Device
          </Text>
          <DeviceConnectionCard />
        </View>

        {/* App Settings */}
        <View className="px-5 mb-6">
          <Text className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">
            App Settings
          </Text>
          <Card>
            <CardContent className="px-4 py-2 divide-y divide-border">
              <SettingsItem
                icon={Bell}
                title="Notifications"
                subtitle="Manage alerts and reminders"
                onPress={() => {}}
              />
              <View className="flex-row items-center justify-between py-3">
                <View className="flex-row items-center">
                  <View className="bg-primary/10 w-10 h-10 rounded-full items-center justify-center mr-3">
                    <Moon
                      size={20}
                      className="text-primary"
                      strokeWidth={1.5}
                    />
                  </View>
                  <View>
                    <Text className="font-medium">Dark Mode</Text>
                    <Text className="text-muted-foreground text-sm">
                      {colorScheme === "dark" ? "On" : "Off"}
                    </Text>
                  </View>
                </View>
                <Switch checked={colorScheme === "dark"} disabled />
              </View>
            </CardContent>
          </Card>
        </View>

        {/* Support */}
        <View className="px-5 mb-6">
          <Text className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">
            Support
          </Text>
          <Card>
            <CardContent className="px-4 py-2 divide-y divide-border">
              <SettingsItem
                icon={HelpCircle}
                title="Help Center"
                subtitle="FAQs and support"
                onPress={() => {}}
              />
              <SettingsItem
                icon={Shield}
                title="Privacy Policy"
                onPress={() => {}}
              />
            </CardContent>
          </Card>
        </View>

        {/* Danger Zone */}
        <View className="px-5 mb-6">
          <Text className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">
            Account
          </Text>
          <Card>
            <CardContent className="px-4 py-2 divide-y divide-border">
              <SettingsItem
                icon={RefreshCw}
                title="Reset Setup"
                subtitle="Clear data and restart setup"
                onPress={handleResetOnboarding}
              />
              <Pressable onPress={handleLogout} className="active:opacity-70">
                <View className="flex-row items-center py-3">
                  <View className="bg-destructive/10 w-10 h-10 rounded-full items-center justify-center mr-3">
                    <LogOut
                      size={20}
                      className="text-destructive"
                      strokeWidth={1.5}
                    />
                  </View>
                  <Text className="font-medium text-destructive">Log Out</Text>
                </View>
              </Pressable>
            </CardContent>
          </Card>
        </View>

        {/* App Version */}
        <View className="items-center py-6">
          <Text className="text-muted-foreground text-sm">ECG App v1.0.0</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
