import { useState } from "react";
import { View, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { User, Mail, ArrowLeft } from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppStore } from "@/stores/app-store";

export default function AccountScreen() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});

  const { setUser, setOnboardingStep } = useAppStore();

  const validateForm = (): boolean => {
    const newErrors: { name?: string; email?: string } = {};

    if (!name.trim()) {
      newErrors.name = "Name is required";
    }

    if (!email.trim()) {
      newErrors.email = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = "Please enter a valid email";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleContinue = async () => {
    if (!validateForm()) return;

    setIsLoading(true);

    try {
      // In a real app, you would send this to your backend
      // For now, we'll just save locally
      const user = {
        id: Date.now().toString(),
        email: email.trim(),
        name: name.trim(),
        createdAt: new Date(),
      };

      setUser(user);
      setOnboardingStep("permissions");
      router.push("/(onboarding)/permissions");
    } catch (error) {
      console.error("Error creating account:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBack = () => {
    router.back();
  };

  return (
    <SafeAreaView className="bg-background flex-1">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow"
          keyboardShouldPersistTaps="handled"
        >
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
                Create Your Account
              </Text>
              <Text className="text-muted-foreground text-base">
                Tell us a bit about yourself to get started
              </Text>
            </View>

            {/* Form */}
            <View className="gap-6">
              {/* Name Input */}
              <View className="gap-2">
                <Label nativeID="name-label">
                  <Text className="font-medium">Full Name</Text>
                </Label>
                <View className="relative">
                  <View className="absolute left-3 top-0 bottom-0 justify-center z-10">
                    <User
                      size={20}
                      className="text-muted-foreground"
                      strokeWidth={1.5}
                    />
                  </View>
                  <Input
                    aria-labelledby="name-label"
                    placeholder="Enter your full name"
                    value={name}
                    onChangeText={(text) => {
                      setName(text);
                      if (errors.name)
                        setErrors((e) => ({ ...e, name: undefined }));
                    }}
                    autoCapitalize="words"
                    autoComplete="name"
                    className="pl-11"
                  />
                </View>
                {errors.name && (
                  <Text className="text-destructive text-sm">
                    {errors.name}
                  </Text>
                )}
              </View>

              {/* Email Input */}
              <View className="gap-2">
                <Label nativeID="email-label">
                  <Text className="font-medium">Email Address</Text>
                </Label>
                <View className="relative">
                  <View className="absolute left-3 top-0 bottom-0 justify-center z-10">
                    <Mail
                      size={20}
                      className="text-muted-foreground"
                      strokeWidth={1.5}
                    />
                  </View>
                  <Input
                    aria-labelledby="email-label"
                    placeholder="Enter your email"
                    value={email}
                    onChangeText={(text) => {
                      setEmail(text);
                      if (errors.email)
                        setErrors((e) => ({ ...e, email: undefined }));
                    }}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoComplete="email"
                    className="pl-11"
                  />
                </View>
                {errors.email && (
                  <Text className="text-destructive text-sm">
                    {errors.email}
                  </Text>
                )}
              </View>
            </View>

            {/* Spacer */}
            <View className="flex-1" />

            {/* Continue Button */}
            <View className="pb-8 pt-6">
              <Button
                size="lg"
                onPress={handleContinue}
                disabled={isLoading}
                className="w-full"
              >
                <Text className="text-primary-foreground font-semibold text-lg">
                  {isLoading ? "Creating Account..." : "Continue"}
                </Text>
              </Button>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
