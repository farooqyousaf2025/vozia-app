#!/usr/bin/env bash
# Compile and run DtosGsonHarness against the app's own compiled DTO classes.
#
#   ./scripts/run-dto-harness.sh
#
# Needs a built debug variant (the Kotlin classes, not the APK):
#   gradle :app:compileDebugKotlin
# and fixtures captured from a running backend:
#   node ../backend/scripts/capture-wire-fixtures.cjs
#   node ../backend/scripts/capture-game-wire.cjs > fixtures/wire-games.json
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID="$(cd "$HERE/.." && pwd)"
CLASSES="$ANDROID/app/build/tmp/kotlin-classes/debug"
JAVAC_CLASSES="$ANDROID/app/build/intermediates/javac/debug/classes"
BUILD_DIR="$HERE/.build"

JDK="${JAVA_HOME:-/c/Program Files/Java/jdk-17}"
JAVAC="$JDK/bin/javac"
JAVA="$JDK/bin/java"
[ -x "$JAVAC" ] || { echo "javac not found at $JAVAC — set JAVA_HOME"; exit 1; }
[ -d "$CLASSES" ] || { echo "missing $CLASSES — run 'gradle :app:compileDebugKotlin' first"; exit 1; }

M2="$HOME/.gradle/caches/modules-2/files-2.1"
find_jar() { # find_jar <group> <artifact> <version>
  find "$M2/$1/$2/$3" -name "$2-$3.jar" 2>/dev/null | head -1 || true
}
# Versions the app itself ships with, read from the build files so the harness
# always runs against the real classpath instead of a hardcoded guess.
GSON_VER="$(grep -oE 'com\.google\.code\.gson:gson:[0-9.]+' "$ANDROID/app/build.gradle.kts" | head -1 | cut -d: -f3)"
KOTLIN_VER="$(sed -nE 's/.*id\("org\.jetbrains\.kotlin\.android"\) version "([0-9.]+)".*/\1/p' "$ANDROID/build.gradle.kts" | head -1)"
KOTLIN_VER="${KOTLIN_VER:?could not read the Kotlin plugin version from build.gradle.kts}"

GSON_JAR="$(find_jar com.google.code.gson gson "$GSON_VER")"
STDLIB_JAR="$(find_jar org.jetbrains.kotlin kotlin-stdlib "$KOTLIN_VER")"
[ -n "$GSON_JAR" ] || { echo "gson $GSON_VER jar not in the Gradle cache"; exit 1; }
[ -n "$STDLIB_JAR" ] || { echo "kotlin-stdlib $KOTLIN_VER jar not in the Gradle cache"; exit 1; }

to_win() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }
# Windows wants ';' between classpath entries, everything else ':'. CI runs this
# on Linux, so hardcoding ';' would silently hand the JVM one giant entry.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) SEP=';' ;;
  *) SEP=':' ;;
esac
CP="$(to_win "$CLASSES")${SEP}$(to_win "$GSON_JAR")${SEP}$(to_win "$STDLIB_JAR")"
[ -d "$JAVAC_CLASSES" ] && CP="$CP${SEP}$(to_win "$JAVAC_CLASSES")" # BuildConfig lives here

mkdir -p "$BUILD_DIR"
"$JAVAC" -nowarn -cp "$CP" -d "$BUILD_DIR" "$HERE/DtosGsonHarness.java"
cd "$HERE"
MSYS_NO_PATHCONV=1 "$JAVA" -Xmx256m -cp "$(to_win "$BUILD_DIR")${SEP}$CP" DtosGsonHarness \
  fixtures/wire-rest.json fixtures/wire-socket.json fixtures/wire-games.json
