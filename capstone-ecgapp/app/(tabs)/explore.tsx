import { View, ScrollView, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import {
  Heart,
  Clock,
  Flag,
  ChevronRight,
  Activity,
} from "lucide-react-native";

import { Text } from "@/components/ui/text";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSessionHistoryStore } from "@/stores/session-store";
import type { RunSession } from "@/types";

function SessionCard({ session }: { session: RunSession }) {
  const formatDate = (date: Date) => {
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (d.toDateString() === today.toDateString()) {
      return "Today";
    } else if (d.toDateString() === yesterday.toDateString()) {
      return "Yesterday";
    }
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
    });
  };

  const formatTime = (date: Date) => {
    return new Date(date).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const formatDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hrs > 0) {
      return `${hrs}h ${mins}m`;
    }
    return `${mins}m ${secs}s`;
  };

  return (
    <Card className="mb-3">
      <CardContent className="p-4">
        <Pressable className="active:opacity-80">
          <View className="flex-row justify-between items-start mb-3">
            <View>
              <Text className="font-semibold text-base">ECG Session</Text>
              <Text className="text-muted-foreground text-sm">
                {formatDate(session.startTime)} at{" "}
                {formatTime(session.startTime)}
              </Text>
            </View>
            <ChevronRight size={20} className="text-muted-foreground" />
          </View>

          <View className="flex-row gap-4">
            <View className="flex-row items-center gap-2">
              <Clock size={14} className="text-muted-foreground" />
              <Text className="text-sm">
                {formatDuration(session.duration)}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <Heart size={14} className="text-red-500" />
              <Text className="text-sm">
                {session.averageHeartRate || "--"} avg bpm
              </Text>
            </View>
            {session.eventMarkers.length > 0 && (
              <View className="flex-row items-center gap-2">
                <Flag size={14} className="text-yellow-500" />
                <Text className="text-sm">{session.eventMarkers.length}</Text>
              </View>
            )}
          </View>

          {/* Heart Rate Range Bar */}
          <View className="mt-3 pt-3 border-t border-border">
            <View className="flex-row justify-between items-center">
              <View className="flex-row items-center gap-1">
                <Text className="text-xs text-blue-500">
                  {session.minHeartRate || "--"}
                </Text>
                <Text className="text-xs text-muted-foreground">min</Text>
              </View>
              <View className="flex-1 mx-3 h-2 bg-muted rounded-full" />
              <View className="flex-row items-center gap-1">
                <Text className="text-xs text-red-500">
                  {session.maxHeartRate || "--"}
                </Text>
                <Text className="text-xs text-muted-foreground">max</Text>
              </View>
            </View>
          </View>
        </Pressable>
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  const handleStartSession = () => {
    router.push("/run-session");
  };

  return (
    <View className="flex-1 items-center justify-center px-6 py-12">
      <View className="w-24 h-24 rounded-full bg-muted items-center justify-center mb-6">
        <Activity size={48} className="text-muted-foreground" strokeWidth={1} />
      </View>
      <Text className="text-xl font-bold text-center mb-2">
        No Sessions Yet
      </Text>
      <Text className="text-muted-foreground text-center mb-8">
        Start your first ECG monitoring session to see your history and insights
        here.
      </Text>
      <Button size="lg" onPress={handleStartSession}>
        <Text className="text-primary-foreground font-semibold">
          Start Your First Session
        </Text>
      </Button>
    </View>
  );
}

function StatsOverview({ sessions }: { sessions: RunSession[] }) {
  const totalSessions = sessions.length;
  const totalDuration = sessions.reduce((acc, s) => acc + s.duration, 0);
  const avgHeartRate =
    sessions.length > 0
      ? Math.round(
          sessions.reduce((acc, s) => acc + (s.averageHeartRate || 0), 0) /
            sessions.length,
        )
      : 0;

  const formatTotalDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hrs > 0) {
      return `${hrs}h ${mins}m`;
    }
    return `${mins}m`;
  };

  return (
    <View className="flex-row gap-3 mb-4">
      <Card className="flex-1">
        <CardContent className="p-3 items-center">
          <Text className="text-2xl font-bold">{totalSessions}</Text>
          <Text className="text-muted-foreground text-xs">Sessions</Text>
        </CardContent>
      </Card>
      <Card className="flex-1">
        <CardContent className="p-3 items-center">
          <Text className="text-2xl font-bold">
            {formatTotalDuration(totalDuration)}
          </Text>
          <Text className="text-muted-foreground text-xs">Total Time</Text>
        </CardContent>
      </Card>
      <Card className="flex-1">
        <CardContent className="p-3 items-center">
          <Text className="text-2xl font-bold">{avgHeartRate || "--"}</Text>
          <Text className="text-muted-foreground text-xs">Avg BPM</Text>
        </CardContent>
      </Card>
    </View>
  );
}

export default function HistoryScreen() {
  const { sessions } = useSessionHistoryStore();

  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-5 pt-4 pb-4 border-b border-border">
        <View className="flex-row justify-between items-center">
          <Text className="text-2xl font-bold">Session History</Text>
          {sessions.length > 0 && (
            <Pressable onPress={() => router.push("/run-session")}>
              <Text className="text-primary font-medium">New Session</Text>
            </Pressable>
          )}
        </View>
      </View>

      {sessions.length === 0 ? (
        <EmptyState />
      ) : (
        <ScrollView
          className="flex-1 px-5 pt-4"
          showsVerticalScrollIndicator={false}
        >
          {/* Stats Overview */}
          <StatsOverview sessions={sessions} />

          {/* Sessions List */}
          <View className="flex-row justify-between items-center mb-3">
            <Text className="font-semibold">Recent Sessions</Text>
            <Text className="text-muted-foreground text-sm">
              {sessions.length} total
            </Text>
          </View>

          {sessions.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}

          {/* Bottom padding */}
          <View className="h-8" />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
