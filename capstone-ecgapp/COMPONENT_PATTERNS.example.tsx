import React, { useState } from "react";
import { View, ScrollView, Alert } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/cn";

/**
 * Example Component Patterns
 * This file demonstrates common usage patterns with React Native Reusables
 */

// Pattern 1: Simple Button with State
export function SimpleButton() {
  const [count, setCount] = useState(0);

  return (
    <View className="gap-2">
      <Button
        label={`Pressed: ${count} times`}
        onPress={() => setCount(count + 1)}
        className="bg-accent"
      />
    </View>
  );
}

// Pattern 2: Conditional Styling
interface ButtonVariantProps {
  variant?: "primary" | "secondary" | "danger";
}

export function ButtonWithVariants({
  variant = "primary",
}: ButtonVariantProps) {
  const baseClass = "px-4 py-2 rounded-lg";
  const variantClass = cn({
    "bg-primary": variant === "primary",
    "bg-secondary border border-border": variant === "secondary",
    "bg-red-500": variant === "danger",
  });

  return (
    <Button
      label={`${variant} Button`}
      className={cn(baseClass, variantClass)}
      onPress={() => Alert.alert(`${variant} button pressed`)}
    />
  );
}

// Pattern 3: Layout with Gap and Padding
export function LayoutExample() {
  return (
    <View className="flex-1 p-6 gap-4 bg-background">
      <Text className="text-2xl font-bold text-foreground">Section Title</Text>

      <View className="gap-2 p-4 bg-muted rounded-lg border border-border">
        <Text className="text-foreground">Card content</Text>
        <Text className="text-sm text-muted-foreground">
          Using tailwind spacing utilities
        </Text>
      </View>

      <Button label="Action" onPress={() => {}} />
    </View>
  );
}

// Pattern 4: Dynamic Colors
export function ColorPaletteDisplay() {
  const colors = [
    { name: "primary", class: "bg-primary" },
    { name: "secondary", class: "bg-secondary" },
    { name: "accent", class: "bg-accent" },
    { name: "muted", class: "bg-muted" },
    { name: "background", class: "bg-background" },
    { name: "border", class: "bg-border" },
  ];

  return (
    <View className="gap-4">
      <Text className="text-lg font-semibold text-foreground">
        Color Palette
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {colors.map((color) => (
          <View key={color.name} className="items-center gap-2">
            <View
              className={cn(
                "w-16 h-16 rounded-lg border border-border",
                color.class,
              )}
            />
            <Text className="text-xs text-muted-foreground">{color.name}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// Pattern 5: Form Layout
export function FormExample() {
  const [email, setEmail] = useState("");

  return (
    <View className="gap-4 p-4">
      <Text className="text-lg font-semibold text-foreground">Enter Email</Text>

      <View className="border border-border rounded-lg p-3 gap-2">
        <Text className="text-sm text-muted-foreground">Email Address</Text>
        <Text className="text-foreground">{email || "example@email.com"}</Text>
      </View>

      <Button
        label="Submit"
        className="bg-primary"
        onPress={() => Alert.alert("Form submitted")}
      />
    </View>
  );
}

// Pattern 6: Dark Mode Support
export function DarkModeExample() {
  return (
    <View className="flex-1 bg-background gap-4 p-6">
      <Text className="text-2xl font-bold text-foreground">
        This text adapts to light/dark mode
      </Text>

      <View className="p-4 bg-muted rounded-lg border border-border">
        <Text className="text-muted-foreground">
          Background, text, and border colors automatically adjust
        </Text>
      </View>
    </View>
  );
}

// Pattern 7: Responsive Layout
export function ResponsiveLayout() {
  return (
    <ScrollView className="flex-1 bg-background">
      <View className="p-4 gap-4">
        <Text className="text-xl font-bold text-foreground">
          Responsive Grid
        </Text>

        <View className="flex-row gap-2">
          <View className="flex-1 h-24 bg-accent rounded-lg" />
          <View className="flex-1 h-24 bg-primary rounded-lg" />
        </View>

        <View className="flex-row gap-2">
          <View className="flex-1 h-24 bg-secondary rounded-lg border border-border" />
          <View className="flex-1 h-24 bg-muted rounded-lg" />
        </View>
      </View>
    </ScrollView>
  );
}

// Pattern 8: Component Composition
interface CardProps {
  title: string;
  description: string;
  onPress: () => void;
}

export function Card({ title, description, onPress }: CardProps) {
  return (
    <View className="gap-3 p-4 bg-background border border-border rounded-lg">
      <Text className="text-lg font-semibold text-foreground">{title}</Text>
      <Text className="text-sm text-muted-foreground">{description}</Text>
      <Button label="Action" onPress={onPress} className="bg-primary" />
    </View>
  );
}

// Example usage:
export function CardExample() {
  return (
    <View className="gap-4 p-4">
      <Card
        title="Card Title"
        description="Card description goes here"
        onPress={() => Alert.alert("Card action")}
      />
    </View>
  );
}

/**
 * COMMON PATTERNS SUMMARY
 *
 * 1. Spacing: Use gap, p (padding), m (margin) utilities
 *    - gap-4: 16px gap between children
 *    - p-4: 16px padding on all sides
 *    - px-4: 16px padding on x-axis only
 *
 * 2. Colors: Use predefined color classes
 *    - bg-primary, text-foreground, border-border
 *    - Dark mode automatically applies with .dark class
 *
 * 3. Typography: Font sizes and weights
 *    - text-lg, text-sm, text-2xl, text-3xl
 *    - font-bold, font-semibold
 *
 * 4. Borders and Rounded: Border utilities
 *    - border border-border
 *    - rounded-lg, rounded-full
 *
 * 5. Flex Layout: Flexbox utilities
 *    - flex-1: Take available space
 *    - flex-row: Horizontal layout
 *    - items-center: Center items vertically
 *    - justify-between: Distribute items
 *
 * 6. Conditional Classes: Use cn() helper
 *    - cn('base-class', condition && 'conditional-class')
 *    - cn(baseClass, { 'active-class': isActive })
 *
 * For more patterns, visit: https://reactnativereusables.com/
 */
