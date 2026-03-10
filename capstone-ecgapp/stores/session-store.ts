import { create } from "zustand";
import type {
  SessionStatus,
  HeartRateData,
  EventMarker,
  RunSession,
} from "@/types";

interface SessionState {
  // Current session
  currentSession: RunSession | null;
  sessionStatus: SessionStatus;

  // Real-time data
  currentHeartRate: number;
  heartRateHistory: HeartRateData[];
  eventMarkers: EventMarker[];

  // Connection status
  isReceivingData: boolean;
  lastDataTimestamp: number | null;

  // Session stats
  elapsedTime: number;
  averageHeartRate: number;
  maxHeartRate: number;
  minHeartRate: number;

  // Sync status
  isSyncing: boolean;
  syncProgress: number;
  lastSyncTime: Date | null;

  // Actions
  startSession: () => void;
  endSession: () => void;
  pauseSession: () => void;
  resumeSession: () => void;

  // Data actions
  addHeartRateData: (data: HeartRateData) => void;
  addEventMarker: (type: EventMarker["type"], description?: string) => void;

  // Timer actions
  updateElapsedTime: (time: number) => void;

  // Sync actions
  setSyncing: (isSyncing: boolean) => void;
  setSyncProgress: (progress: number) => void;

  // Pending upload
  pendingUpload: PendingUpload | null;
  setPendingUpload: (payload: PendingUpload | null) => void;
  clearPendingUpload: () => void;

  // Reset
  resetSession: () => void;
}

type PendingUpload = {
  recordId: string;
  sessionId: string;
  startTimeIso: string | null;
  packets: Uint8Array[];
  useMock: boolean;
};

const initialState = {
  currentSession: null,
  sessionStatus: "idle" as SessionStatus,
  currentHeartRate: 0,
  heartRateHistory: [],
  eventMarkers: [],
  isReceivingData: false,
  lastDataTimestamp: null,
  elapsedTime: 0,
  averageHeartRate: 0,
  maxHeartRate: 0,
  minHeartRate: 999,
  isSyncing: false,
  syncProgress: 0,
  lastSyncTime: null,
  pendingUpload: null,
};

export const useSessionStore = create<SessionState>((set, get) => ({
  ...initialState,

  startSession: () => {
    const session: RunSession = {
      id: `session_${Date.now()}`,
      startTime: new Date(),
      status: "running",
      duration: 0,
      heartRateData: [],
      eventMarkers: [],
    };

    set({
      currentSession: session,
      sessionStatus: "running",
      heartRateHistory: [],
      eventMarkers: [],
      elapsedTime: 0,
      averageHeartRate: 0,
      maxHeartRate: 0,
      minHeartRate: 999,
      isReceivingData: true,
    });
  },

  endSession: () => {
    const state = get();
    if (state.currentSession) {
      const endedSession: RunSession = {
        ...state.currentSession,
        endTime: new Date(),
        status: "completed",
        duration: state.elapsedTime,
        heartRateData: state.heartRateHistory,
        eventMarkers: state.eventMarkers,
        averageHeartRate: state.averageHeartRate,
        maxHeartRate: state.maxHeartRate,
        minHeartRate: state.minHeartRate === 999 ? 0 : state.minHeartRate,
      };

      set({
        currentSession: endedSession,
        sessionStatus: "completed",
        isReceivingData: false,
      });
    }
  },

  pauseSession: () => {
    set({ sessionStatus: "paused" });
  },

  resumeSession: () => {
    set({ sessionStatus: "running" });
  },

  addHeartRateData: (data: HeartRateData) => {
    set((state) => {
      const newHistory = [...state.heartRateHistory, data];
      const heartRates = newHistory.map((d) => d.heartRate);
      const sum = heartRates.reduce((a, b) => a + b, 0);

      return {
        heartRateHistory: newHistory,
        currentHeartRate: data.heartRate,
        averageHeartRate: Math.round(sum / heartRates.length),
        maxHeartRate: Math.max(state.maxHeartRate, data.heartRate),
        minHeartRate: Math.min(state.minHeartRate, data.heartRate),
        lastDataTimestamp: data.timestamp,
        isReceivingData: true,
      };
    });
  },

  addEventMarker: (type: EventMarker["type"], description?: string) => {
    const marker: EventMarker = {
      id: `marker_${Date.now()}`,
      timestamp: Date.now(),
      type,
      description,
    };

    set((state) => ({
      eventMarkers: [...state.eventMarkers, marker],
    }));
  },

  updateElapsedTime: (time: number) => {
    set({ elapsedTime: time });
  },

  setSyncing: (isSyncing: boolean) => {
    set({ isSyncing });
    if (!isSyncing) {
      set({ lastSyncTime: new Date() });
    }
  },

  setSyncProgress: (progress: number) => {
    set({ syncProgress: progress });
  },

  setPendingUpload: (payload: PendingUpload | null) => {
    set({ pendingUpload: payload });
  },

  clearPendingUpload: () => {
    set({ pendingUpload: null });
  },

  resetSession: () => {
    set(initialState);
  },
}));

// Session history store for completed sessions
interface SessionHistoryState {
  sessions: RunSession[];
  addSession: (session: RunSession) => void;
  clearHistory: () => void;
}

export const useSessionHistoryStore = create<SessionHistoryState>((set) => ({
  sessions: [],

  addSession: (session: RunSession) => {
    set((state) => ({
      sessions: [session, ...state.sessions].slice(0, 50), // Keep last 50 sessions
    }));
  },

  clearHistory: () => {
    set({ sessions: [] });
  },
}));
