import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Text } from "@/components/ui/text";
import { useSessionHistoryStore } from "@/stores/session-store";

const weekDayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const toDateKey = (date: Date) => {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;
};

const getDotClass = (count: number) => {
  if (count >= 3) return "bg-emerald-600";
  if (count === 2) return "bg-emerald-500";
  return "bg-emerald-400";
};

export default function ActivityCalendarScreen() {
  const { sessions } = useSessionHistoryStore();
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const sessionDayCounts = useMemo(() => {
    const counts = new Map<string, number>();

    sessions.forEach((session) => {
      const date = new Date(session.startTime);
      if (Number.isNaN(date.getTime())) return;

      const key = toDateKey(date);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });

    return counts;
  }, [sessions]);

  const monthCells = useMemo(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const startWeekday = firstDay.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;

    const cells = [] as {
      key: string;
      date: Date | null;
      count: number;
    }[];

    for (let i = 0; i < totalCells; i += 1) {
      const dayNumber = i - startWeekday + 1;
      if (dayNumber < 1 || dayNumber > daysInMonth) {
        cells.push({ key: `empty-${i}`, date: null, count: 0 });
        continue;
      }

      const date = new Date(year, month, dayNumber);
      const key = toDateKey(date);
      const count = sessionDayCounts.get(key) ?? 0;

      cells.push({ key, date, count });
    }

    return cells;
  }, [currentMonth, sessionDayCounts]);

  const monthSummary = useMemo(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();

    let activeDays = 0;
    let totalSessions = 0;

    monthCells.forEach((cell) => {
      if (!cell.date) return;
      if (cell.date.getFullYear() !== year || cell.date.getMonth() !== month) {
        return;
      }

      if (cell.count > 0) {
        activeDays += 1;
        totalSessions += cell.count;
      }
    });

    return { activeDays, totalSessions };
  }, [currentMonth, monthCells]);

  const handleChangeMonth = (direction: "prev" | "next") => {
    setCurrentMonth((prev) => {
      const next = new Date(prev);
      next.setMonth(prev.getMonth() + (direction === "prev" ? -1 : 1));
      return new Date(next.getFullYear(), next.getMonth(), 1);
    });
  };

  const monthLabel = currentMonth.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const todayKey = toDateKey(new Date());

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-5 pt-4 pb-6">
          <View className="flex-row items-center justify-between mb-6">
            <Pressable
              onPress={() => router.back()}
              className="w-10 h-10 rounded-full bg-secondary items-center justify-center"
            >
              <Ionicons
                name="chevron-back"
                size={20}
                className="text-foreground"
              />
            </Pressable>
            <Text className="text-lg font-semibold">Activity Calendar</Text>
            <View className="w-10 h-10" />
          </View>

          <View className="flex-row items-center justify-between mb-4">
            <Pressable
              onPress={() => handleChangeMonth("prev")}
              className="w-9 h-9 rounded-full bg-secondary items-center justify-center"
            >
              <Ionicons
                name="chevron-back"
                size={18}
                className="text-foreground"
              />
            </Pressable>
            <Text className="text-base font-semibold">{monthLabel}</Text>
            <Pressable
              onPress={() => handleChangeMonth("next")}
              className="w-9 h-9 rounded-full bg-secondary items-center justify-center"
            >
              <Ionicons
                name="chevron-forward"
                size={18}
                className="text-foreground"
              />
            </Pressable>
          </View>

          <View className="flex-row justify-between mb-2">
            {weekDayLabels.map((label) => (
              <Text
                key={label}
                className="flex-1 text-center text-xs text-muted-foreground"
              >
                {label}
              </Text>
            ))}
          </View>

          <View className="gap-2">
            {Array.from({ length: monthCells.length / 7 }).map(
              (_, rowIndex) => {
                const row = monthCells.slice(rowIndex * 7, rowIndex * 7 + 7);
                return (
                  <View key={`row-${rowIndex}`} className="flex-row">
                    {row.map((cell) => {
                      if (!cell.date) {
                        return (
                          <View
                            key={cell.key}
                            className="flex-1 aspect-square"
                          />
                        );
                      }

                      const cellKey = toDateKey(cell.date);
                      const isToday = cellKey === todayKey;
                      const hasActivity = cell.count > 0;

                      return (
                        <View
                          key={cell.key}
                          className="flex-1 aspect-square items-center justify-center"
                        >
                          <View
                            className={`w-10 h-10 rounded-full items-center justify-center ${
                              isToday
                                ? "border border-primary"
                                : "border border-transparent"
                            }`}
                          >
                            <Text className="text-sm font-medium">
                              {cell.date.getDate()}
                            </Text>
                          </View>
                          <View
                            className={`mt-1 w-2.5 h-2.5 rounded-full ${
                              hasActivity
                                ? getDotClass(cell.count)
                                : "bg-transparent"
                            }`}
                          />
                        </View>
                      );
                    })}
                  </View>
                );
              },
            )}
          </View>

          <View className="mt-6 p-4 rounded-xl bg-secondary">
            <Text className="text-sm font-semibold mb-1">
              {monthSummary.activeDays} active day
              {monthSummary.activeDays === 1 ? "" : "s"}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {monthSummary.totalSessions} session
              {monthSummary.totalSessions === 1 ? "" : "s"} logged this month
            </Text>
            <View className="flex-row items-center gap-2 mt-3">
              <View className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
              <Text className="text-xs text-muted-foreground">
                Activity recorded
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
