import { useCallback, useEffect, useState } from "react";
import { Platform, PermissionsAndroid, Linking, Alert } from "react-native";
import * as Location from "expo-location";
import { useAppStore } from "@/stores/app-store";

export type PermissionStatus =
  | "undetermined"
  | "granted"
  | "denied"
  | "restricted";

interface PermissionState {
  bluetooth: PermissionStatus;
  location: PermissionStatus;
}

export function usePermissions() {
  const [permissions, setPermissions] = useState<PermissionState>({
    bluetooth: "undetermined",
    location: "undetermined",
  });
  const [isChecking, setIsChecking] = useState(false);

  const { setPermission } = useAppStore();

  // Check current permission status
  const checkPermissions = useCallback(async () => {
    setIsChecking(true);

    try {
      const newPermissions: PermissionState = {
        bluetooth: "undetermined",
        location: "undetermined",
      };

      // Check location permission
      const { status: locationStatus } =
        await Location.getForegroundPermissionsAsync();
      newPermissions.location = mapExpoStatus(locationStatus);

      // Check Bluetooth permission (Android specific)
      if (Platform.OS === "android") {
        const apiLevel = Platform.Version as number;

        if (apiLevel >= 31) {
          const bluetoothScan = await PermissionsAndroid.check(
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          );
          const bluetoothConnect = await PermissionsAndroid.check(
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          );

          newPermissions.bluetooth =
            bluetoothScan && bluetoothConnect ? "granted" : "denied";
        } else {
          // On older Android, Bluetooth uses location permission
          newPermissions.bluetooth = newPermissions.location;
        }
      } else {
        // iOS - Bluetooth permission is handled at usage time
        // We assume granted if location is granted for BLE
        newPermissions.bluetooth =
          newPermissions.location === "granted" ? "granted" : "undetermined";
      }

      setPermissions(newPermissions);

      // Update app store
      setPermission("bluetooth", newPermissions.bluetooth === "granted");
      setPermission("location", newPermissions.location === "granted");
    } catch (err) {
      console.error("Error checking permissions:", err);
    } finally {
      setIsChecking(false);
    }
  }, [setPermission]);

  // Request location permission
  const requestLocationPermission = useCallback(async (): Promise<boolean> => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      const granted = status === "granted";

      setPermissions((prev) => ({
        ...prev,
        location: mapExpoStatus(status),
      }));
      setPermission("location", granted);

      return granted;
    } catch (err) {
      console.error("Error requesting location permission:", err);
      return false;
    }
  }, [setPermission]);

  // Request Bluetooth permission (Android 12+)
  const requestBluetoothPermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === "android") {
      const apiLevel = Platform.Version as number;

      if (apiLevel >= 31) {
        try {
          const results = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]);

          const granted =
            results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] ===
              PermissionsAndroid.RESULTS.GRANTED &&
            results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
              PermissionsAndroid.RESULTS.GRANTED;

          setPermissions((prev) => ({
            ...prev,
            bluetooth: granted ? "granted" : "denied",
          }));
          setPermission("bluetooth", granted);

          return granted;
        } catch (err) {
          console.error("Error requesting Bluetooth permission:", err);
          return false;
        }
      } else {
        // On older Android, use location permission for Bluetooth
        return requestLocationPermission();
      }
    }

    // iOS - return true, permission will be requested when Bluetooth is used
    setPermissions((prev) => ({
      ...prev,
      bluetooth: "granted",
    }));
    setPermission("bluetooth", true);
    return true;
  }, [requestLocationPermission, setPermission]);

  // Request all required permissions
  const requestAllPermissions = useCallback(async (): Promise<{
    bluetooth: boolean;
    location: boolean;
  }> => {
    const location = await requestLocationPermission();
    const bluetooth = await requestBluetoothPermission();

    return { bluetooth, location };
  }, [requestLocationPermission, requestBluetoothPermission]);

  // Open app settings
  const openSettings = useCallback(() => {
    Alert.alert(
      "Permissions Required",
      "Please enable the required permissions in your device settings.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Open Settings",
          onPress: () => {
            Linking.openSettings();
          },
        },
      ],
    );
  }, []);

  // Map Expo permission status to our status
  const mapExpoStatus = (
    status: Location.PermissionStatus,
  ): PermissionStatus => {
    switch (status) {
      case Location.PermissionStatus.GRANTED:
        return "granted";
      case Location.PermissionStatus.DENIED:
        return "denied";
      default:
        return "undetermined";
    }
  };

  // Check permissions on mount
  useEffect(() => {
    checkPermissions();
  }, []);

  const allPermissionsGranted =
    permissions.bluetooth === "granted" && permissions.location === "granted";

  return {
    permissions,
    isChecking,
    allPermissionsGranted,
    checkPermissions,
    requestLocationPermission,
    requestBluetoothPermission,
    requestAllPermissions,
    openSettings,
  };
}
