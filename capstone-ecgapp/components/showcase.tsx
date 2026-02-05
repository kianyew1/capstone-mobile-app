import React from "react";
import { View, ScrollView } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/cn";

export default function ComponentShowcase() {
  const [count, setCount] = React.useState(0);

  return (
    <ScrollView className="flex-1 bg-background">
      <View className="flex-1 p-6 gap-6">
        {/* Title */}
        <View className="gap-2">
          <Text className="text-3xl font-bold text-foreground">
            React Native Reusables
          </Text>
          <Text className="text-base text-muted-foreground">
            Powered by Nativewind &amp; Tailwind CSS
          </Text>
        </View>

        {/* Button Examples */}
        <View className="gap-4">
          <Text className="text-lg font-semibold text-foreground">Buttons</Text>

          <Button
            label="Primary Button"
            className="bg-primary"
            onPress={() => alert("Primary button pressed!")}
          />

          <Button
            label="Secondary Button"
            className="bg-secondary border border-border"
            onPress={() => alert("Secondary button pressed!")}
          />

          <Button
            label={`Counter: ${count}`}
            className="bg-accent"
            onPress={() => setCount(count + 1)}
          />
        </View>

        {/* Color Palette */}
        <View className="gap-4">
          <Text className="text-lg font-semibold text-foreground">
            Color Palette
          </Text>

          <View className="flex-row flex-wrap gap-2">
            {[
              { name: "primary", class: "bg-primary" },
              { name: "secondary", class: "bg-secondary" },
              { name: "accent", class: "bg-accent" },
              { name: "muted", class: "bg-muted" },
              { name: "background", class: "bg-background" },
              { name: "border", class: "bg-border" },
            ].map((color) => (
              <View key={color.name} className="gap-1 items-center flex-1">
                <View
                  className={cn(
                    "w-16 h-16 rounded-lg border border-border",
                    color.class,
                  )}
                />
                <Text className="text-xs text-muted-foreground">
                  {color.name}
                </Text>
              </View>
            ))}
          </View>
        </View>

        {/* Text Styles */}
        <View className="gap-4">
          <Text className="text-lg font-semibold text-foreground">
            Typography
          </Text>

          <Text className="text-4xl font-bold text-foreground">
            Extra Large
          </Text>

          <Text className="text-2xl font-bold text-foreground">Large</Text>

          <Text className="text-lg font-semibold text-foreground">Regular</Text>

          <Text className="text-sm text-muted-foreground">
            Muted Foreground
          </Text>
        </View>

        {/* Spacing Example */}
        <View className="gap-4">
          <Text className="text-lg font-semibold text-foreground">
            Spacing &amp; Layout
          </Text>

          <View className="gap-2 p-4 bg-muted rounded-lg border border-border">
            <Text className="text-foreground">Padding &amp; Gap</Text>
            <View className="flex-row gap-2">
              <View className="flex-1 h-12 bg-accent rounded" />
              <View className="flex-1 h-12 bg-primary rounded" />
              <View className="flex-1 h-12 bg-secondary rounded" />
            </View>
          </View>
        </View>

        {/* Getting Started */}
        <View className="gap-4 p-4 bg-muted rounded-lg border border-border mb-8">
          <Text className="text-lg font-semibold text-foreground">
            Getting Started
          </Text>

          <Text className="text-sm text-muted-foreground">
            1. Import components from &apos;@/components/ui&apos;
          </Text>

          <Text className="text-sm text-muted-foreground">
            2. Use Tailwind classes with className prop
          </Text>

          <Text className="text-sm text-muted-foreground">
            3. Add more components with: npx @react-native-reusables/cli@latest
            add [component]
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
