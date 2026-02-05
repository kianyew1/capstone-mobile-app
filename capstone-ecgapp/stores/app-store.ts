import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  CalibrationResult,
  ECGDevice,
  OnboardingStep,
  User,
} from "@/types";

interface AppState {
  // User state
  user: User | null;
  setUser: (user: User | null) => void;

  // Onboarding state
  onboardingStep: OnboardingStep;
  isOnboardingComplete: boolean;
  setOnboardingStep: (step: OnboardingStep) => void;
  completeOnboarding: () => void;
  resetOnboarding: () => void;

  // Permissions state
  permissions: {
    bluetooth: boolean;
    location: boolean;
  };
  setPermission: (type: "bluetooth" | "location", granted: boolean) => void;

  // Device state
  pairedDevice: ECGDevice | null;
  setPairedDevice: (device: ECGDevice | null) => void;

  // Calibration state
  calibrationResult: CalibrationResult | null;
  setCalibrationResult: (result: CalibrationResult | null) => void;
  isCalibrated: boolean;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      // User state
      user: null,
      setUser: (user) => set({ user }),

      // Onboarding state
      onboardingStep: "welcome",
      isOnboardingComplete: false,
      setOnboardingStep: (step) => set({ onboardingStep: step }),
      completeOnboarding: () =>
        set({ isOnboardingComplete: true, onboardingStep: "complete" }),
      resetOnboarding: () =>
        set({
          isOnboardingComplete: false,
          onboardingStep: "welcome",
          user: null,
          pairedDevice: null,
          calibrationResult: null,
          permissions: { bluetooth: false, location: false },
        }),

      // Permissions state
      permissions: {
        bluetooth: false,
        location: false,
      },
      setPermission: (type, granted) =>
        set((state) => ({
          permissions: { ...state.permissions, [type]: granted },
        })),

      // Device state
      pairedDevice: null,
      setPairedDevice: (device) => set({ pairedDevice: device }),

      // Calibration state
      calibrationResult: null,
      setCalibrationResult: (result) =>
        set({
          calibrationResult: result,
          isCalibrated: result?.status === "success",
        }),
      isCalibrated: false,
    }),
    {
      name: "ecg-app-storage",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        user: state.user,
        isOnboardingComplete: state.isOnboardingComplete,
        pairedDevice: state.pairedDevice,
        calibrationResult: state.calibrationResult,
        isCalibrated: state.isCalibrated,
      }),
    },
  ),
);
