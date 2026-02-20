import { router } from "expo-router";
import { Activity, Bluetooth, Heart, Shield } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

const features = [
  {
    icon: Heart,
    title: "ECG Monitoring",
    description: "Track your heart health in real-time",
  },
  {
    icon: Activity,
    title: "Run Sessions",
    description: "Monitor your heart during activities",
  },
  {
    icon: Bluetooth,
    title: "Wireless Connection",
    description: "Connect to your ECG device via Bluetooth",
  },
  {
    icon: Shield,
    title: "Secure & Private",
    description: "Your health data stays safe with us",
  },
];

export default function WelcomeScreen() {
  const handleGetStarted = () => {
    router.push("/(onboarding)/account");
  };

  return (
    <SafeAreaView className="bg-background flex-1">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: 24,
          paddingTop: 48,
          paddingBottom: 24,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-1">
          {/* Header */}
          <View className="items-center mb-10">
            <View className="bg-primary/10 w-24 h-24 rounded-full items-center justify-center mb-6">
              <Heart size={48} className="text-primary" strokeWidth={1.5} />
            </View>
            <Text variant="h1" className="text-center mb-2">
              Welcome to ECG App
            </Text>
            <Text className="text-muted-foreground text-center text-lg">
              Your personal heart health companion
            </Text>
          </View>

          {/* Features */}
          <View className="gap-4">
            {features.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <View
                  key={index}
                  className="flex-row items-center gap-4 bg-card p-4 rounded-xl border border-border"
                >
                  <View className="bg-primary/10 w-12 h-12 rounded-full items-center justify-center">
                    <Icon
                      size={24}
                      className="text-primary"
                      strokeWidth={1.5}
                    />
                  </View>
                  <View className="flex-1">
                    <Text className="font-semibold text-base">
                      {feature.title}
                    </Text>
                    <Text className="text-muted-foreground text-sm">
                      {feature.description}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>

          {/* CTA Button */}
          <View className="mt-auto pt-6">
            <Button size="lg" onPress={handleGetStarted} className="w-full">
              <Text className="text-primary-foreground font-semibold text-lg">
                Get Started
              </Text>
            </Button>
            <Text className="text-muted-foreground text-center text-sm mt-4">
              By continuing, you agree to our Terms of Service and Privacy
              Policy
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
