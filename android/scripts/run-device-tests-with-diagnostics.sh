#!/usr/bin/env bash
# Run connected instrumentation tests and preserve emulator state before the
# android-emulator-runner action shuts the device down after a failure.
set -u

diagnostics_dir="app/build/reports/androidTests/diagnostics"
mkdir -p "$diagnostics_dir"

./gradlew --no-daemon connectedDebugAndroidTest
test_status=$?
if [ "$test_status" -eq 0 ]; then
  exit 0
fi

adb logcat -d -v threadtime > "$diagnostics_dir/logcat.txt" || true
adb shell dumpsys activity processes > "$diagnostics_dir/activity-processes.txt" || true
adb shell dumpsys meminfo com.voiza.app > "$diagnostics_dir/target-meminfo.txt" || true
exit "$test_status"
