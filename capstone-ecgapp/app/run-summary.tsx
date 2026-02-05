import { useState, useEffect } from "react";
import { View, ScrollView, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Check,
  Heart,
  Clock,
  Flame,
  TrendingUp,
  TrendingDown,
  Target,
  AlertTriangle,
  Info,
  Share2,
  ChevronRight,
  Cloud,
  CloudOff,
} from "lucide-react-native";
import Animated, { FadeInUp } from "react-native-reanimated";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { Progress } from "@/components/ui/progress";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  useSessionStore,
  useSessionHistoryStore,
} from "@/stores/session-store";
import {
  uploadSessionData,
  getSessionAnalysis,
  type SessionInsight,
  type HeartRateZone,
  type SessionSummary,
} from "@/services/api-service";

type SyncStatus = "syncing" | "analyzing" | "complete" | "error";

export default function RunSummaryScreen() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("syncing");
  const [syncProgress, setSyncProgress] = useState(0);
  const [insights, setInsights] = useState<SessionInsight[]>([]);
  const [heartRateZones, setHeartRateZones] = useState<HeartRateZone[]>([]);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    currentSession,
    elapsedTime,
    averageHeartRate,
    maxHeartRate,
    minHeartRate,
    eventMarkers,
    heartRateHistory,
    resetSession,
  } = useSessionStore();

  const { addSession } = useSessionHistoryStore();

  useEffect(() => {
    syncAndAnalyze();
  }, []);

  const syncAndAnalyze = async () => {
    if (!currentSession) return;

    try {
      // Step 1: Upload session data
      setSyncStatus("syncing");
      for (let i = 0; i <= 100; i += 10) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        setSyncProgress(i);
      }

      const uploadResponse = await uploadSessionData(currentSession);

      if (!uploadResponse.success) {
        throw new Error("Failed to upload session data");
      }

      // Step 2: Get analysis from cloud
      setSyncStatus("analyzing");
      setSyncProgress(0);

      const analysisResponse = await getSessionAnalysis(currentSession.id);

      if (analysisResponse.success && analysisResponse.data) {
        setInsights(analysisResponse.data.insights);
        setHeartRateZones(analysisResponse.data.heartRateZones);
        setSummary(analysisResponse.data.summary);
      }

      // Save to local history
      addSession(currentSession);

      setSyncStatus("complete");
    } catch (err) {
      console.error("Sync error:", err);
      setError("Failed to sync session. Data saved locally.");
      setSyncStatus("error");

      // Still save locally even if cloud sync fails
      if (currentSession) {
        addSession(currentSession);
      }
    }
  };

  const handleDone = () => {
    resetSession();
    router.replace("/(tabs)");
  };

  const handleShare = () => {
    // Implement share functionality
    console.log("Share session");
  };

  const formatTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hrs > 0) {
      return `${hrs}h ${mins}m ${secs}s`;
    }
    return `${mins}m ${secs}s`;
  };

  const formatZoneDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getInsightIcon = (type: SessionInsight["type"]) => {
    switch (type) {
      case "positive":
        return <Check size={20} className="text-green-500" />;
      case "warning":
        return <AlertTriangle size={20} className="text-yellow-500" />;
      case "info":
        return <Info size={20} className="text-blue-500" />;
    }
  };

  // Syncing/Analyzing view
  if (syncStatus === "syncing" || syncStatus === "analyzing") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-6">
          <View className="w-24 h-24 rounded-full bg-primary/20 items-center justify-center mb-6">
            {syncStatus === "syncing" ? (
              <Cloud size={48} className="text-primary" />
            ) : (
              <ActivityIndicator size="large" />
            )}
          </View>

          <Text variant="h3" className="text-center mb-2">
            {syncStatus === "syncing"
              ? "Syncing to Cloud..."
              : "Analyzing Your Session..."}
          </Text>
          <Text className="text-muted-foreground text-center mb-8">
            {syncStatus === "syncing"
              ? "Uploading your session data securely"
              : "Our AI is analyzing your heart data"}
          </Text>

          {syncStatus === "syncing" && (
            <View className="w-full">
              <Progress value={syncProgress} className="h-2" />
              <Text className="text-muted-foreground text-center mt-2">
                {syncProgress}%
              </Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // Main summary view
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-6 pt-6 pb-8">
          {/* Header */}
          <Animated.View
            entering={FadeInUp.delay(100)}
            className="items-center mb-6"
          >
            <View className="w-20 h-20 rounded-full bg-green-500/20 items-center justify-center mb-4">
              <Check size={40} className="text-green-500" />
            </View>
            <Text variant="h2" className="text-center border-b-0 pb-0">
              Session Complete!
            </Text>
            {syncStatus === "error" && (
              <View className="flex-row items-center gap-2 mt-2 bg-yellow-500/20 px-3 py-1 rounded-full">
                <CloudOff size={14} className="text-yellow-500" />
                <Text className="text-yellow-500 text-sm">Saved locally</Text>
              </View>
            )}
          </Animated.View>

          {/* Quick Stats */}
          <Animated.View entering={FadeInUp.delay(200)}>
            <Card className="mb-4">
              <CardContent className="p-4">
                <View className="flex-row justify-around">
                  <View className="items-center">
                    <View className="flex-row items-center gap-1 mb-1">
                      <Clock size={16} className="text-muted-foreground" />
                      <Text className="text-muted-foreground text-sm">
                        Duration
                      </Text>
                    </View>
                    <Text className="text-2xl font-bold">
                      {formatTime(elapsedTime)}
                    </Text>
                  </View>
                  <View className="w-px bg-border" />
                  <View className="items-center">
                    <View className="flex-row items-center gap-1 mb-1">
                      <Heart size={16} className="text-red-500" />
                      <Text className="text-muted-foreground text-sm">
                        Avg HR
                      </Text>
                    </View>
                    <Text className="text-2xl font-bold">
                      {averageHeartRate || "--"}{" "}
                      <Text className="text-sm text-muted-foreground">bpm</Text>
                    </Text>
                  </View>
                  <View className="w-px bg-border" />
                  <View className="items-center">
                    <View className="flex-row items-center gap-1 mb-1">
                      <Flame size={16} className="text-orange-500" />
                      <Text className="text-muted-foreground text-sm">
                        Calories
                      </Text>
                    </View>
                    <Text className="text-2xl font-bold">
                      {summary?.totalCalories || Math.round(elapsedTime * 0.15)}
                    </Text>
                  </View>
                </View>
              </CardContent>
            </Card>
          </Animated.View>

          {/* Heart Rate Summary */}
          <Animated.View entering={FadeInUp.delay(300)}>
            <Card className="mb-4">
              <CardHeader>
                <CardTitle className="flex-row items-center gap-2">
                  <Heart size={18} className="text-red-500" />
                  <Text className="font-semibold">Heart Rate Summary</Text>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <View className="flex-row justify-between mb-4">
                  <View className="items-center flex-1">
                    <Text className="text-muted-foreground text-sm">Min</Text>
                    <Text className="text-xl font-bold text-blue-500">
                      {minHeartRate === 999 ? "--" : minHeartRate}
                    </Text>
                  </View>
                  <View className="items-center flex-1">
                    <Text className="text-muted-foreground text-sm">Avg</Text>
                    <Text className="text-xl font-bold">
                      {averageHeartRate || "--"}
                    </Text>
                  </View>
                  <View className="items-center flex-1">
                    <Text className="text-muted-foreground text-sm">Max</Text>
                    <Text className="text-xl font-bold text-red-500">
                      {maxHeartRate || "--"}
                    </Text>
                  </View>
                </View>

                {/* Heart Rate Zones */}
                {heartRateZones.length > 0 && (
                  <View className="gap-2">
                    <Text className="text-sm font-medium mb-2">
                      Time in Zones
                    </Text>
                    {heartRateZones.map((zone, index) => (
                      <View key={index} className="flex-row items-center gap-3">
                        <View className="w-16">
                          <Text className="text-sm">{zone.name}</Text>
                        </View>
                        <View className="flex-1">
                          <View className="h-4 bg-muted rounded-full overflow-hidden">
                            <View
                              className="h-full rounded-full"
                              style={{
                                width: `${zone.percentage}%`,
                                backgroundColor: zone.color,
                              }}
                            />
                          </View>
                        </View>
                        <Text className="text-sm text-muted-foreground w-12 text-right">
                          {formatZoneDuration(zone.duration)}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </CardContent>
            </Card>
          </Animated.View>

          {/* Performance Score */}
          {summary && (
            <Animated.View entering={FadeInUp.delay(400)}>
              <Card className="mb-4">
                <CardContent className="p-4">
                  <View className="flex-row items-center gap-4">
                    <View className="w-20 h-20 rounded-full border-4 border-primary items-center justify-center">
                      <Text className="text-3xl font-bold text-primary">
                        {summary.performanceScore}
                      </Text>
                    </View>
                    <View className="flex-1">
                      <Text className="font-semibold text-lg">
                        Performance Score
                      </Text>
                      <View className="flex-row items-center gap-1 mt-1">
                        {summary.comparedToAverage >= 0 ? (
                          <TrendingUp size={16} className="text-green-500" />
                        ) : (
                          <TrendingDown size={16} className="text-red-500" />
                        )}
                        <Text
                          className={`text-sm ${
                            summary.comparedToAverage >= 0
                              ? "text-green-500"
                              : "text-red-500"
                          }`}
                        >
                          {Math.abs(summary.comparedToAverage)}%{" "}
                          {summary.comparedToAverage >= 0 ? "better" : "lower"}{" "}
                          than average
                        </Text>
                      </View>
                    </View>
                  </View>
                </CardContent>
              </Card>
            </Animated.View>
          )}

          {/* Events Marked */}
          {eventMarkers.length > 0 && (
            <Animated.View entering={FadeInUp.delay(450)}>
              <Card className="mb-4">
                <CardHeader>
                  <CardTitle className="flex-row items-center gap-2">
                    <Target size={18} className="text-yellow-500" />
                    <Text className="font-semibold">Events Marked</Text>
                  </CardTitle>
                  <CardDescription>
                    {eventMarkers.length} event
                    {eventMarkers.length > 1 ? "s" : ""} during your session
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <View className="gap-2">
                    {eventMarkers.slice(0, 5).map((marker, index) => (
                      <View
                        key={marker.id}
                        className="flex-row items-center justify-between py-2 border-b border-border last:border-b-0"
                      >
                        <View className="flex-row items-center gap-2">
                          <View className="w-2 h-2 rounded-full bg-yellow-500" />
                          <Text className="capitalize">{marker.type}</Text>
                        </View>
                        <Text className="text-muted-foreground text-sm">
                          {new Date(marker.timestamp).toLocaleTimeString()}
                        </Text>
                      </View>
                    ))}
                    {eventMarkers.length > 5 && (
                      <Text className="text-muted-foreground text-sm text-center pt-2">
                        +{eventMarkers.length - 5} more events
                      </Text>
                    )}
                  </View>
                </CardContent>
              </Card>
            </Animated.View>
          )}

          {/* Insights */}
          {insights.length > 0 && (
            <Animated.View entering={FadeInUp.delay(500)}>
              <Card className="mb-4">
                <CardHeader>
                  <CardTitle>Insights</CardTitle>
                  <CardDescription>
                    AI-powered analysis of your session
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <View className="gap-4">
                    {insights.map((insight) => (
                      <View key={insight.id} className="flex-row gap-3">
                        <View
                          className={`w-10 h-10 rounded-full items-center justify-center ${
                            insight.type === "positive"
                              ? "bg-green-500/20"
                              : insight.type === "warning"
                                ? "bg-yellow-500/20"
                                : "bg-blue-500/20"
                          }`}
                        >
                          {getInsightIcon(insight.type)}
                        </View>
                        <View className="flex-1">
                          <Text className="font-medium">{insight.title}</Text>
                          <Text className="text-muted-foreground text-sm mt-1">
                            {insight.description}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </CardContent>
              </Card>
            </Animated.View>
          )}

          {/* Action Buttons */}
          <Animated.View entering={FadeInUp.delay(600)} className="gap-3 pt-4">
            <Button size="lg" onPress={handleDone} className="w-full">
              <Text className="text-primary-foreground font-semibold text-lg">
                Done
              </Text>
            </Button>
            <Button variant="outline" onPress={handleShare} className="w-full">
              <Share2 size={18} className="text-foreground mr-2" />
              <Text>Share Results</Text>
            </Button>
          </Animated.View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
