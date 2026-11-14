#!/bin/bash
# Records one clip per scene of the Sylo 5.2 sneak peek on an iPhone simulator.
# Builds the app and its UI test once, then for each scene: record the screen, run that one test
# (it writes start and end markers), stop recording, and cut the clip with ffmpeg.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="$ROOT/apps/sylo-ios/sylo-ios.xcodeproj"
BUILD="$ROOT/build"
DD="$BUILD/dd"
MARK="$BUILD/markers"
RAW="$BUILD/raw"
OUT="$BUILD/clips"
SHEETS="$BUILD/sheets"
LOGS="$BUILD/logs"
mkdir -p "$MARK" "$RAW" "$OUT" "$SHEETS" "$LOGS"

xcrun simctl list devices available > "$LOGS/simctl-devices.txt" || true
UDID="$(python3 "$ROOT/.github/ios-sneak-capture/pick_device.py")"
echo "Simulator $UDID"

# A software keyboard in the recording, no onboarding tips.
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false || true
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl ui "$UDID" appearance dark
xcrun simctl status_bar "$UDID" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
xcrun simctl spawn "$UDID" defaults write com.apple.keyboard.preferences DidShowContinuousPathIntroduction -bool true || true
xcrun simctl spawn "$UDID" defaults write com.apple.keyboard.preferences KeyboardAutocorrection -bool false || true
xcrun simctl spawn "$UDID" defaults write com.apple.keyboard.preferences KeyboardPrediction -bool false || true

command -v ffmpeg >/dev/null || HOMEBREW_NO_AUTO_UPDATE=1 brew install ffmpeg

echo "Building the app and the UI test"
if ! xcodebuild build-for-testing \
  -project "$PROJECT" -scheme SneakCapture -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$DD" \
  CODE_SIGNING_ALLOWED=NO > "$LOGS/build.log" 2>&1; then
  tail -n 120 "$LOGS/build.log"
  exit 1
fi
tail -n 3 "$LOGS/build.log"

FAILED=0
for ENTRY in 01:overview:testScene01Overview 02:health:testScene02Health 03:history:testScene03History \
             04:suggestions:testScene04Suggestions 05:wizard:testScene05Wizard; do
  ID="${ENTRY%%:*}"
  REST="${ENTRY#*:}"
  NAME="${REST%%:*}"
  TEST="${REST##*:}"
  echo "Scene $ID ($NAME)"
  rm -f "$MARK/$ID.txt"

  xcrun simctl io "$UDID" recordVideo --codec h264 --force "$RAW/$ID-$NAME.mp4" > "$LOGS/record-$ID.log" 2>&1 &
  RECORDER=$!
  for _ in $(seq 1 50); do
    grep -qi "recording started" "$LOGS/record-$ID.log" 2>/dev/null && break
    sleep 0.2
  done
  T0="$(python3 -c 'import time; print(time.time())')"

  set +e
  TEST_RUNNER_SNEAK_MARKER_DIR="$MARK" xcodebuild test-without-building \
    -project "$PROJECT" -scheme SneakCapture -configuration Debug \
    -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$DD" \
    -only-testing:"SneakCaptureUITests/SneakScenes/$TEST" \
    -resultBundlePath "$BUILD/result-$ID.xcresult" \
    CODE_SIGNING_ALLOWED=NO > "$LOGS/test-$ID.log" 2>&1
  STATUS=$?
  set -e
  sleep 1
  kill -INT "$RECORDER" 2>/dev/null || true
  wait "$RECORDER" 2>/dev/null || true

  if [ "$STATUS" -ne 0 ]; then
    echo "Scene $ID FAILED"
    grep -E "error|failed|Assertion|XCTAssert" "$LOGS/test-$ID.log" | head -n 20 || true
    FAILED=1
    xcrun xcresulttool export attachments --path "$BUILD/result-$ID.xcresult" \
      --output-path "$BUILD/failure-$ID" > /dev/null 2>&1 || true
  fi
  rm -rf "$BUILD/result-$ID.xcresult.bak"

  START="$(awk '$1=="start"{print $2}' "$MARK/$ID.txt" 2>/dev/null | head -n 1 || true)"
  END="$(awk '$1=="end"{print $2}' "$MARK/$ID.txt" 2>/dev/null | tail -n 1 || true)"
  RAWFILE="$RAW/$ID-$NAME.mp4"
  CLIP="$OUT/$ID-$NAME.mp4"
  if [ -n "$START" ] && [ -n "$END" ] && [ -s "$RAWFILE" ]; then
    SS="$(awk -v s="$START" -v t="$T0" 'BEGIN { v = s - t - 1.0; if (v < 0) v = 0; printf "%.2f", v }')"
    # One second before the start and 0.4 s after the end marker; the test holds the last screen 0.8 s more.
    DUR="$(awk -v s="$START" -v e="$END" 'BEGIN { printf "%.2f", e - s + 1.4 }')"
    echo "Cut $CLIP from $SS s for $DUR s"
    ffmpeg -y -loglevel error -ss "$SS" -i "$RAWFILE" -t "$DUR" -vf "fps=30" -c:v libx264 -pix_fmt yuv420p -crf 17 -an "$CLIP"
  elif [ -s "$RAWFILE" ]; then
    echo "No markers for scene $ID: keeping the whole recording"
    cp "$RAWFILE" "$CLIP"
  fi
  if [ -s "$CLIP" ]; then
    ffmpeg -y -loglevel error -i "$CLIP" -vf "fps=1.5,scale=200:-1,tile=10x4" -frames:v 1 "$SHEETS/$ID-$NAME.png" || true
    ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$CLIP" > "$LOGS/length-$ID.txt" || true
    ffprobe -v error -show_entries stream=nb_frames,avg_frame_rate,width,height -of default=nw=1 "$RAWFILE" > "$LOGS/raw-info-$ID.txt" || true
    ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$RAWFILE" >> "$LOGS/raw-info-$ID.txt" || true
  fi
done

echo "Clips:"
ls -l "$OUT"
for F in "$LOGS"/length-*.txt; do echo "$(basename "$F"): $(cat "$F")"; done
exit "$FAILED"
