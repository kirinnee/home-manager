#!/usr/bin/env bash
# Cross-platform text-to-speech wrapper
# Dependencies (injected by Nix):
#   - macOS: say (built-in)
#   - Linux/WSL: espeak-ng

speak_macos() {
  say "$@"
}

speak_linux() {
  espeak "$@"
}

speak_wsl() {
  # WSL: use PowerShell TTS (Windows built-in)
  powershell.exe -Command "Add-Type -AssemblyName System.Speech; \$speak = New-Object System.Speech.Synthesis.SpeechSynthesizer; \$speak.Speak([string]::Join(' ', \$args))" "$@"
}

# Detect platform
case "$(uname -s)" in
Darwin)
  speak_macos "$@"
  ;;
Linux)
  if grep -qi microsoft /proc/version 2>/dev/null; then
    speak_wsl "$@"
  else
    speak_linux "$@"
  fi
  ;;
*)
  echo "Error: Unsupported platform" >&2
  exit 1
  ;;
esac
