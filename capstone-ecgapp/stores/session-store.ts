import { create } from "zustand";
import type {
  SessionStatus,
  HeartRateData,
  ECGDataPacket,
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
  ecgBuffer: ECGDataPacket[];
  eventMarkers: EventMarker[];

  // Connection status
  isReceivingData: boolean;
  lastDataTimestamp: number | null;
  bufferedPackets: ECGDataPacket[]; // For offline buffering

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
  addECGPacket: (packet: ECGDataPacket) => void;
  addEventMarker: (type: EventMarker["type"], description?: string) => void;

  // Buffering actions
  addToBuffer: (packet: ECGDataPacket) => void;
  flushBuffer: () => ECGDataPacket[];

  // Timer actions
  updateElapsedTime: (time: number) => void;

  // Sync actions
  setSyncing: (isSyncing: boolean) => void;
  setSyncProgress: (progress: number) => void;

  // Reset
  resetSession: () => void;
}

const initialState = {
  currentSession: null,
  sessionStatus: "idle" as SessionStatus,
  currentHeartRate: 0,
  heartRateHistory: [],
  ecgBuffer: [],
  eventMarkers: [],
  isReceivingData: false,
  lastDataTimestamp: null,
  bufferedPackets: [],
  elapsedTime: 0,
  averageHeartRate: 0,
  maxHeartRate: 0,
  minHeartRate: 999,
  isSyncing: false,
  syncProgress: 0,
  lastSyncTime: null,
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
      ecgPackets: [],
      eventMarkers: [],
    };

    set({
      currentSession: session,
      sessionStatus: "running",
      heartRateHistory: [],
      ecgBuffer: [],
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
        ecgPackets: state.ecgBuffer,
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

  addECGPacket: (packet: ECGDataPacket) => {
    set((state) => ({
      ecgBuffer: [...state.ecgBuffer, packet],
      lastDataTimestamp: packet.timestamp,
    }));
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

  addToBuffer: (packet: ECGDataPacket) => {
    set((state) => ({
      bufferedPackets: [...state.bufferedPackets, packet],
    }));
  },

  flushBuffer: () => {
    const packets = get().bufferedPackets;
    set({ bufferedPackets: [] });
    return packets;
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
